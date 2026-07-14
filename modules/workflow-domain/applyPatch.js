import { cloneJson, makeConnectionBinding, makeConnectionsBinding } from './graphSchema.js';
import { validateWorkflowGraph } from './graphValidator.js';
import { validateWorkflowPatch } from './patchValidator.js';
import { getInputPortDefinitions } from './portRegistry.js';

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

function inputPortMaxConnections(graph, nodeId, port, catalog = null) {
  const node = getNode(graph, nodeId);
  if (!node) return 1;
  const inputDefs = getInputPortDefinitions({
    category: node.category,
    modelId: node.modelId,
    nodeType: node.nodeType,
    catalog,
  });
  return inputDefs[port]?.maxConnections ?? 1;
}

function assertPrecondition(graph, precondition, { catalog = null } = {}) {
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
      if (inputPortMaxConnections(graph, precondition.node_id, precondition.port, catalog) === Infinity) return;
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

function addConnectionBinding(targetNode, targetPort, sourceNodeId, sourcePort, maxConnections) {
  targetNode.inputs = targetNode.inputs || {};
  if (maxConnections === Infinity) {
    const existing = targetNode.inputs[targetPort];
    const connections = existing?.type === 'connections'
      ? [...existing.connections]
      : existing?.type === 'connection'
        ? [{ sourceNodeId: existing.sourceNodeId, sourcePort: existing.sourcePort }]
        : [];
    if (!connections.some((connection) => connection.sourceNodeId === sourceNodeId && connection.sourcePort === sourcePort)) {
      connections.push({ sourceNodeId, sourcePort });
    }
    targetNode.inputs[targetPort] = makeConnectionsBinding(connections);
    return;
  }
  targetNode.inputs[targetPort] = makeConnectionBinding(sourceNodeId, sourcePort);
}

function removeConnectionBinding(targetNode, targetPort, sourceNodeId, sourcePort) {
  const binding = targetNode?.inputs?.[targetPort];
  if (!binding) return;
  if (
    binding.type === 'connection' &&
    binding.sourceNodeId === sourceNodeId &&
    binding.sourcePort === sourcePort
  ) {
    delete targetNode.inputs[targetPort];
    return;
  }
  if (binding.type === 'connections') {
    const nextConnections = binding.connections.filter((connection) =>
      connection.sourceNodeId !== sourceNodeId || connection.sourcePort !== sourcePort
    );
    if (nextConnections.length === 0) delete targetNode.inputs[targetPort];
    else targetNode.inputs[targetPort] = makeConnectionsBinding(nextConnections);
  }
}

function applyOperation(graph, operation, { catalog = null } = {}) {
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
      {
        const maxConnections = inputPortMaxConnections(graph, operation.target.node_id, operation.target.port, catalog);
        if (maxConnections !== Infinity && graph.edges.some((edge) =>
          edge.target.nodeId === operation.target.node_id &&
          edge.target.port === operation.target.port
        )) {
          throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', `Target port "${operation.target.port}" is already occupied.`);
        }
        if (graph.edges.some((edge) =>
          edge.source.nodeId === operation.source.node_id &&
          edge.source.port === operation.source.port &&
          edge.target.nodeId === operation.target.node_id &&
          edge.target.port === operation.target.port
        )) {
          throw new WorkflowPatchConflict('PATCH_OPERATION_CONFLICT', 'Duplicate edge between the same source and target port.');
        }
      }
      if (operation.mode === 'fail_if_occupied') {
        assertPrecondition(graph, {
          type: 'target_port_unoccupied',
          node_id: operation.target.node_id,
          port: operation.target.port,
        }, { catalog });
      }
      graph.edges.push({
        id: operation.edge_id,
        source: { nodeId: operation.source.node_id, port: operation.source.port },
        target: { nodeId: operation.target.node_id, port: operation.target.port },
      });
      {
        const targetNode = getNode(graph, operation.target.node_id);
        if (targetNode) {
          addConnectionBinding(
            targetNode,
            operation.target.port,
            operation.source.node_id,
            operation.source.port,
            inputPortMaxConnections(graph, operation.target.node_id, operation.target.port, catalog)
          );
        }
      }
      return;
    case 'disconnect':
      {
        const edge = getEdge(graph, operation.edge_id);
        graph.edges = graph.edges.filter((item) => item.id !== operation.edge_id);
        if (edge) {
          const targetNode = getNode(graph, edge.target.nodeId);
          removeConnectionBinding(targetNode, edge.target.port, edge.source.nodeId, edge.source.port);
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
  for (const precondition of patch.preconditions || []) assertPrecondition(next, precondition, { catalog });
  for (const operation of patch.operations || []) applyOperation(next, operation, { catalog });

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
