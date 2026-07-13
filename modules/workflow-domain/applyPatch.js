import { cloneJson } from './graphSchema.js';
import { validateWorkflowGraph } from './graphValidator.js';
import { validateWorkflowPatch } from './patchValidator.js';

export class WorkflowPatchConflict extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkflowPatchConflict';
    this.code = code;
    this.details = details;
  }
}

function getNode(graph, nodeId) {
  return graph.nodes.find((node) => node.id === nodeId) || null;
}

function getEdge(graph, edgeId) {
  return graph.edges.find((edge) => edge.id === edgeId) || null;
}

function fieldValue(graph, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let current = graph;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function assertPrecondition(graph, precondition) {
  switch (precondition.type) {
    case 'workflow_revision_equals':
      if (graph.revision !== precondition.revision) {
        throw new WorkflowPatchConflict('WORKFLOW_REVISION_CONFLICT', 'The workflow changed after this patch was created.', {
          currentRevision: graph.revision,
          expectedRevision: precondition.revision,
        });
      }
      return;
    case 'node_exists':
      if (!getNode(graph, precondition.node_id)) throw new WorkflowPatchConflict('PATCH_PRECONDITION_FAILED', `Node "${precondition.node_id}" does not exist.`);
      return;
    case 'node_not_exists':
      if (getNode(graph, precondition.node_id)) throw new WorkflowPatchConflict('PATCH_PRECONDITION_FAILED', `Node "${precondition.node_id}" already exists.`);
      return;
    case 'edge_exists':
      if (!getEdge(graph, precondition.edge_id)) throw new WorkflowPatchConflict('PATCH_PRECONDITION_FAILED', `Edge "${precondition.edge_id}" does not exist.`);
      return;
    case 'edge_not_exists':
      if (getEdge(graph, precondition.edge_id)) throw new WorkflowPatchConflict('PATCH_PRECONDITION_FAILED', `Edge "${precondition.edge_id}" already exists.`);
      return;
    case 'field_equals':
      if (JSON.stringify(fieldValue(graph, precondition.path)) !== JSON.stringify(precondition.value)) {
        throw new WorkflowPatchConflict('PATCH_PRECONDITION_FAILED', `Field "${precondition.path}" no longer has the expected value.`);
      }
      return;
    case 'target_port_unoccupied':
      if (graph.edges.some((edge) => edge.target.nodeId === precondition.node_id && edge.target.port === precondition.port)) {
        throw new WorkflowPatchConflict('PATCH_PRECONDITION_FAILED', `Target port "${precondition.port}" is already occupied.`);
      }
      return;
    case 'node_type_unchanged': {
      const node = getNode(graph, precondition.node_id);
      if (!node || node.nodeType !== precondition.node_type) {
        throw new WorkflowPatchConflict('PATCH_PRECONDITION_FAILED', `Node "${precondition.node_id}" type changed.`);
      }
      return;
    }
    case 'model_remains_available':
      return;
    default:
      throw new WorkflowPatchConflict('PATCH_PRECONDITION_FAILED', `Unsupported precondition "${precondition.type}".`);
  }
}

function applyOperation(graph, operation) {
  switch (operation.op) {
    case 'add_node':
      if (getNode(graph, operation.node.id)) throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', `Node "${operation.node.id}" already exists.`);
      graph.nodes.push(cloneJson(operation.node));
      return;
    case 'set_node_parameter': {
      const node = getNode(graph, operation.node_id);
      if (!node) throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', `Node "${operation.node_id}" does not exist.`);
      if (
        Object.hasOwn(operation, 'expected_previous_value') &&
        JSON.stringify(node.parameters?.[operation.parameter]) !== JSON.stringify(operation.expected_previous_value)
      ) {
        throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', `Parameter "${operation.parameter}" changed.`);
      }
      node.parameters = node.parameters || {};
      node.parameters[operation.parameter] = cloneJson(operation.value);
      node.inputs = node.inputs || {};
      node.inputs[operation.parameter] = { type: 'constant', value: cloneJson(operation.value) };
      return;
    }
    case 'unset_node_parameter': {
      const node = getNode(graph, operation.node_id);
      if (!node) throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', `Node "${operation.node_id}" does not exist.`);
      delete node.parameters?.[operation.parameter];
      delete node.inputs?.[operation.parameter];
      return;
    }
    case 'set_node_model': {
      const node = getNode(graph, operation.node_id);
      if (!node) throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', `Node "${operation.node_id}" does not exist.`);
      node.modelId = operation.model_id;
      return;
    }
    case 'set_node_model_policy': {
      const node = getNode(graph, operation.node_id);
      if (!node) throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', `Node "${operation.node_id}" does not exist.`);
      node.modelPolicy = cloneJson(operation.policy || {});
      return;
    }
    case 'set_node_exposure': {
      const node = getNode(graph, operation.node_id);
      if (!node) throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', `Node "${operation.node_id}" does not exist.`);
      node.exposure = { ...(node.exposure || {}), ...(operation.exposure || {}) };
      return;
    }
    case 'connect':
      if (getEdge(graph, operation.edge_id)) throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', `Edge "${operation.edge_id}" already exists.`);
      if (operation.mode === 'fail_if_occupied') {
        assertPrecondition(graph, {
          type: 'target_port_unoccupied',
          node_id: operation.target.node_id,
          port: operation.target.port,
        });
      }
      graph.edges.push({
        id: operation.edge_id,
        source: { nodeId: operation.source.node_id, port: operation.source.port },
        target: { nodeId: operation.target.node_id, port: operation.target.port },
      });
      {
        const targetNode = getNode(graph, operation.target.node_id);
        if (targetNode) {
          targetNode.inputs = targetNode.inputs || {};
          targetNode.inputs[operation.target.port] = {
            type: 'connection',
            sourceNodeId: operation.source.node_id,
            sourcePort: operation.source.port,
          };
        }
      }
      return;
    case 'disconnect':
      {
        const edge = getEdge(graph, operation.edge_id);
        graph.edges = graph.edges.filter((item) => item.id !== operation.edge_id);
        if (edge) {
          const targetNode = getNode(graph, edge.target.nodeId);
          const binding = targetNode?.inputs?.[edge.target.port];
          if (
            binding?.type === 'connection' &&
            binding.sourceNodeId === edge.source.nodeId &&
            binding.sourcePort === edge.source.port
          ) {
            delete targetNode.inputs[edge.target.port];
          }
        }
      }
      return;
    case 'set_workflow_metadata':
      graph.metadata = { ...(graph.metadata || {}), ...(operation.metadata || {}) };
      return;
    default:
      throw new WorkflowPatchConflict('PATCH_OPERATION_UNSUPPORTED', `Unsupported operation "${operation.op}".`);
  }
}

export function applyWorkflowPatch(graph, patch, { catalog = null, validate = true } = {}) {
  const patchValidation = validateWorkflowPatch(patch);
  if (!patchValidation.valid) {
    const message = patchValidation.errors.map((error) => error.message).join('; ');
    throw new WorkflowPatchConflict('INVALID_PATCH', message, { errors: patchValidation.errors });
  }

  const next = cloneJson(graph);
  for (const precondition of patch.preconditions || []) assertPrecondition(next, precondition);
  for (const operation of patch.operations || []) applyOperation(next, operation);

  if (validate) {
    const graphValidation = validateWorkflowGraph(next, { catalog });
    if (!graphValidation.valid) {
      throw new WorkflowPatchConflict('PATCH_RESULT_INVALID', 'Patch produced an invalid workflow graph.', {
        errors: graphValidation.errors,
      });
    }
  }
  return next;
}
