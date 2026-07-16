import { createWorkflowPatch } from '../../workflow-domain/patchSchema.js';
import { makeConstantBinding, makeConnectionBinding, makeConnectionsBinding } from '../../workflow-domain/graphSchema.js';
import {
  getInputPortDefinitions,
  getOutputPortDefinitions,
  inferNodeKind,
  nodeTypeForCategory,
  portTypesCompatible,
} from '../../workflow-domain/portRegistry.js';
import { defaultArchitectModelProfile, getArchitectNodeProfile } from './capabilityCatalog.js';

function safeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function outputPortForCategory(category) {
  if (category === 'image') return 'image';
  if (category === 'video') return 'video';
  if (category === 'audio') return 'audio';
  if (category === 'text') return 'text';
  return 'result';
}

function outputTypeForCategory(category) {
  if (category === 'image') return 'image_url';
  if (category === 'video') return 'video_url';
  if (category === 'audio') return 'audio_url';
  if (category === 'text') return 'text';
  return 'unknown';
}

function constantInputs(parameters = {}) {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [key, makeConstantBinding(value)])
  );
}

function constantInputsForNode(node, catalog) {
  const inputs = getInputPortDefinitions({
    category: node.category,
    modelId: node.modelId,
    nodeType: node.nodeType,
    catalog,
  });
  const allowed = new Set(Object.keys(inputs));
  return Object.fromEntries(
    Object.entries(node.parameters || {})
      .filter(([key]) => allowed.has(key))
      .map(([key, value]) => [key, makeConstantBinding(value)])
  );
}

function filterSupportedParameters(parameters = {}, node, catalog) {
  const inputs = getInputPortDefinitions({
    category: node.category,
    modelId: node.modelId,
    nodeType: node.nodeType,
    catalog,
  });
  const allowed = new Set(Object.keys(inputs));
  return Object.fromEntries(
    Object.entries(parameters).filter(([key]) => allowed.has(key))
  );
}

const createWorkflowMessageOptions = [
  'I drafted the workflow. Review the proposal below.',
  'I put together a workflow draft. Take a look at the proposal below.',
  'I have a workflow proposal ready for you to review.',
  'The workflow draft is ready. Review it below when you are ready.',
  'I mapped out a workflow for this request. The proposal is ready below.',
];

function randomCreateWorkflowMessage() {
  return createWorkflowMessageOptions[Math.floor(Math.random() * createWorkflowMessageOptions.length)];
}

export function compileCreateWorkflowIrToPatch(ir, {
  provider = 'replicate',
  baseRevision = null,
  catalog = null,
} = {}) {
  const refToNode = new Map();
  const operations = [
    { op: 'set_workflow_metadata', metadata: { name: ir.workflow_name, category: ir.target_category, source: 'architect' } },
  ];
  const preconditions = baseRevision != null
    ? [{ type: 'workflow_revision_equals', revision: baseRevision }]
    : [];

  for (const [index, irNode] of ir.nodes.entries()) {
    const nodeId = `architect-${safeId(irNode.ref || `${irNode.category}-${index + 1}`)}`;
    const nodeType = nodeTypeForCategory(irNode.category, irNode.model_id);
    const outputs = getOutputPortDefinitions({ category: irNode.category, modelId: irNode.model_id });
    const fallbackOutputPort = outputPortForCategory(irNode.category);
    const node = {
      id: nodeId,
      nodeType,
      category: irNode.category,
      kind: irNode.role === 'input' ? 'input' : inferNodeKind(irNode.category, irNode.model_id),
      title: irNode.title || `${irNode.category[0].toUpperCase()}${irNode.category.slice(1)} ${irNode.role}`,
      provider,
      modelId: irNode.model_id,
      parameters: { ...(irNode.parameters || {}) },
      inputs: {},
      outputs: Object.keys(outputs).length > 0 ? outputs : { [fallbackOutputPort]: { type: outputTypeForCategory(irNode.category), label: irNode.category } },
      exposure: {
        makeInput: irNode.role === 'input' && irNode.expose_as_input !== false,
        makeOutput: irNode.role !== 'input' && irNode.category === ir.target_category,
      },
      layout: irNode.layout || { x: 80 + (index * 360), y: 120 },
    };
    node.inputs = constantInputsForNode(node, catalog);
    refToNode.set(irNode.ref, node);
    preconditions.push({ type: 'node_not_exists', node_id: nodeId });
    operations.push({ op: 'add_node', node });
  }

  for (const connection of ir.connections || []) {
    const sourceNode = refToNode.get(connection.from_ref);
    const targetNode = refToNode.get(connection.to_ref);
    if (!sourceNode || !targetNode) continue;
    const compatible = compatibleConnection(sourceNode, targetNode, catalog, connection.to_port || null);
    if (!compatible) {
      const error = new Error(`No compatible connection from "${connection.from_ref}" to "${connection.to_ref}".`);
      error.code = 'ARCHITECT_NO_COMPATIBLE_PORT';
      throw error;
    }
    if (compatible.targetMaxConnections !== Infinity) {
      delete targetNode.inputs?.[compatible.targetPort];
    } else if (targetNode.inputs?.[compatible.targetPort]?.type === 'constant') {
      delete targetNode.inputs[compatible.targetPort];
    }
    const edgeId = `edge-${sourceNode.id}-${targetNode.id}-${compatible.targetPort}`;
    preconditions.push({ type: 'edge_not_exists', edge_id: edgeId });
    operations.push({
      op: 'connect',
      edge_id: edgeId,
      source: { node_id: sourceNode.id, port: compatible.sourcePort },
      target: { node_id: targetNode.id, port: compatible.targetPort },
      mode: compatible.targetMaxConnections === Infinity ? 'append' : 'fail_if_occupied',
    });
  }

  return createWorkflowPatch({
    baseRevision,
    preconditions,
    operations,
  });
}

export function summarizeCreateWorkflowProposal(ir) {
  const selection = ir.diagnostics?.model_selection || [];
  return {
    title: ir.workflow_name,
    message: randomCreateWorkflowMessage(),
    assumptions: ir.assumptions || [],
    warnings: [],
    diagnostics: {
      model_selection: selection,
    },
  };
}

function formatNode(node) {
  return node?.title || node?.id || 'selected node';
}

function modelPreconditions(graph, node) {
  const preconditions = [
    { type: 'node_exists', node_id: node.id },
    { type: 'node_type_unchanged', node_id: node.id, node_type: node.nodeType },
  ];
  if (graph.revision != null) {
    preconditions.unshift({ type: 'workflow_revision_equals', revision: graph.revision });
  }
  return preconditions;
}

function uniqueNodeId(graph, prefix, reserved = new Set()) {
  const base = safeId(prefix) || 'architect-node';
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const id of reserved) ids.add(id);
  if (!ids.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  const error = new Error('Could not assign a unique node id.');
  error.code = 'ARCHITECT_NODE_ID_LIMIT';
  throw error;
}

function firstCompatibleOutput(node, targetType) {
  const outputs = getOutputPortDefinitions({ category: node.category, modelId: node.modelId });
  return Object.entries(outputs).find(([, def]) => portTypesCompatible(def.type, targetType)) || null;
}

function firstCompatibleInput(node, sourceType, catalog) {
  const inputs = getInputPortDefinitions({
    category: node.category,
    modelId: node.modelId,
    nodeType: node.nodeType,
    catalog,
  });
  return Object.entries(inputs).find(([, def]) => portTypesCompatible(sourceType, def.type)) || null;
}

function occupiedInputPorts(graph, nodeId) {
  const occupied = new Set(graph.edges.filter((edge) => edge.target.nodeId === nodeId).map((edge) => edge.target.port));
  const node = graph.nodes.find((item) => item.id === nodeId);
  for (const [port, binding] of Object.entries(node?.inputs || {})) {
    if (binding?.type === 'constant' || binding?.type === 'connection') occupied.add(port);
  }
  return occupied;
}

function layoutNear(node, position) {
  const x = Number(node.layout?.x || 0);
  const y = Number(node.layout?.y || 0);
  return position === 'before'
    ? { x: x - 360, y }
    : { x: x + 360, y };
}

function buildInsertedNode(insert, context, reservedNodeIds = new Set()) {
  const category = insert.category;
  const modelId = insert.model_id;
  const profile = getArchitectNodeProfile(category, modelId, context.catalog);
  if (!profile) {
    const error = new Error(`Model "${modelId}" is not enabled for Architect ${category} insertion.`);
    error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
    throw error;
  }
  const parameters = { ...(profile.defaultParameters || {}), ...(insert.parameters || {}) };
  const nodeId = uniqueNodeId(context.graph, insert.node_id || `architect-${category}-${modelId}`, reservedNodeIds);
  reservedNodeIds.add(nodeId);
  const nodeType = nodeTypeForCategory(category, modelId);
  const node = {
    id: nodeId,
    nodeType,
    category,
    kind: inferNodeKind(category, modelId),
    title: insert.title || `${category[0].toUpperCase()}${category.slice(1)} Generator`,
    provider: context.selectedNode.provider,
    modelId,
    parameters: {},
    inputs: {},
    outputs: getOutputPortDefinitions({ category, modelId }),
    exposure: { makeInput: false, makeOutput: false },
    layout: layoutNear(context.selectedNode, insert.position),
  };
  node.parameters = filterSupportedParameters(parameters, node, context.catalog);
  node.inputs = constantInputs(node.parameters);
  return node;
}

function findNode(graph, nodeId) {
  return graph.nodes.find((node) => node.id === nodeId) || null;
}

function findEdge(graph, edgeId) {
  return graph.edges.find((edge) => edge.id === edgeId) || null;
}

function compatibleConnection(sourceNode, targetNode, catalog, preferredTargetPort = null) {
  const outputs = getOutputPortDefinitions({
    category: sourceNode.category,
    modelId: sourceNode.modelId,
  });
  const inputs = getInputPortDefinitions({
    category: targetNode.category,
    modelId: targetNode.modelId,
    nodeType: targetNode.nodeType,
    catalog,
  });

  for (const [sourcePort, sourceDef] of Object.entries(outputs)) {
    const candidates = preferredTargetPort && inputs[preferredTargetPort]
      ? [[preferredTargetPort, inputs[preferredTargetPort]]]
      : Object.entries(inputs);
    const target = candidates.find(([, def]) => portTypesCompatible(sourceDef.type, def.type));
    if (!target) continue;
    const [targetPort, targetDef] = target;
    return { sourcePort, targetPort, targetMaxConnections: targetDef?.maxConnections ?? 1 };
  }
  return null;
}

function compatibleManyConnection(sourceNode, targetNode, catalog) {
  const outputs = getOutputPortDefinitions({
    category: sourceNode.category,
    modelId: sourceNode.modelId,
  });
  const inputs = getInputPortDefinitions({
    category: targetNode.category,
    modelId: targetNode.modelId,
    nodeType: targetNode.nodeType,
    catalog,
  });

  for (const [sourcePort, sourceDef] of Object.entries(outputs)) {
    const target = Object.entries(inputs).find(([, def]) =>
      def.maxConnections === Infinity && portTypesCompatible(sourceDef.type, def.type)
    );
    if (!target) continue;
    const [targetPort, targetDef] = target;
    return { sourcePort, targetPort, targetMaxConnections: targetDef.maxConnections };
  }
  return null;
}

function addConnectionInput(node, targetPort, sourceNodeId, sourcePort, maxConnections) {
  node.inputs = node.inputs || {};
  if (maxConnections === Infinity) {
    const existing = node.inputs[targetPort];
    const connections = existing?.type === 'connections'
      ? [...existing.connections]
      : existing?.type === 'connection'
        ? [{ sourceNodeId: existing.sourceNodeId, sourcePort: existing.sourcePort }]
        : [];
    if (!connections.some((connection) => connection.sourceNodeId === sourceNodeId && connection.sourcePort === sourcePort)) {
      connections.push({ sourceNodeId, sourcePort });
    }
    node.inputs[targetPort] = makeConnectionsBinding(connections);
    return;
  }
  node.inputs[targetPort] = makeConnectionBinding(sourceNodeId, sourcePort);
}

function pushConnect(sourceNode, targetNode, catalog, preconditions, operations, {
  targetPort = null,
  edgeId = null,
  mode = 'fail_if_occupied',
} = {}) {
  const connection = compatibleConnection(sourceNode, targetNode, catalog, targetPort);
  if (!connection) {
    const error = new Error(`No compatible connection from "${sourceNode.id}" to "${targetNode.id}".`);
    error.code = 'ARCHITECT_NO_COMPATIBLE_PORT';
    throw error;
  }
  const id = edgeId || `edge-${sourceNode.id}-${targetNode.id}-${connection.targetPort}`;
  const resolvedMode = connection.targetMaxConnections === Infinity && mode === 'fail_if_occupied' ? 'append' : mode;
  preconditions.push({ type: 'edge_not_exists', edge_id: id });
  if (resolvedMode === 'fail_if_occupied') {
    preconditions.push({ type: 'target_port_unoccupied', node_id: targetNode.id, port: connection.targetPort });
  }
  addConnectionInput(targetNode, connection.targetPort, sourceNode.id, connection.sourcePort, connection.targetMaxConnections);
  operations.push({
    op: 'connect',
    edge_id: id,
    source: { node_id: sourceNode.id, port: connection.sourcePort },
    target: { node_id: targetNode.id, port: connection.targetPort },
    mode: resolvedMode,
  });
  return { edgeId: id, ...connection };
}

function assertManyIncomingReplacementSupported(context, replaceEdges, firstInsertedNode) {
  if (replaceEdges.length <= 1) return;
  const targetPort = replaceEdges[0]?.target.port;
  if (!targetPort || !replaceEdges.every((edge) => edge.target.nodeId === context.selectedNode.id && edge.target.port === targetPort)) {
    const error = new Error('Replacing multiple incoming branch edges requires all edges to target the same selected-node input port.');
    error.code = 'ARCHITECT_BRANCH_REPLACEMENT_UNSUPPORTED';
    throw error;
  }
  const selectedInputs = getInputPortDefinitions({
    category: context.selectedNode.category,
    modelId: context.selectedNode.modelId,
    nodeType: context.selectedNode.nodeType,
    catalog: context.catalog,
  });
  if (selectedInputs[targetPort]?.maxConnections !== Infinity) {
    const error = new Error('Replacing multiple incoming branch edges is supported only for many-cardinality selected-node input ports.');
    error.code = 'ARCHITECT_BRANCH_REPLACEMENT_UNSUPPORTED';
    throw error;
  }
  for (const replaceEdge of replaceEdges) {
    const originalSource = findNode(context.graph, replaceEdge.source.nodeId);
    if (!originalSource || !compatibleManyConnection(originalSource, firstInsertedNode, context.catalog)) {
      const error = new Error('Replacing multiple incoming branch edges requires the first inserted node to accept the incoming media on a many-cardinality port.');
      error.code = 'ARCHITECT_BRANCH_REPLACEMENT_UNSUPPORTED';
      throw error;
    }
  }
}

function addInsertedNodes(nodes, preconditions, operations) {
  for (const node of nodes) {
    preconditions.push({ type: 'node_not_exists', node_id: node.id });
    operations.push({ op: 'add_node', node });
  }
}

function compileInsertAfter(insert, context, insertedNode, preconditions, operations) {
  addInsertedNodes([insertedNode], preconditions, operations);
  pushConnect(context.selectedNode, insertedNode, context.catalog, preconditions, operations);
}

function compileInsertBefore(insert, context, insertedNode, preconditions, operations) {
  const occupied = occupiedInputPorts(context.graph, context.selectedNode.id);
  const selectedInputs = getInputPortDefinitions({
    category: context.selectedNode.category,
    modelId: context.selectedNode.modelId,
    nodeType: context.selectedNode.nodeType,
    catalog: context.catalog,
  });
  for (const [targetPort, targetDef] of Object.entries(selectedInputs)) {
    if (occupied.has(targetPort) && targetDef.maxConnections !== Infinity) continue;
    const source = firstCompatibleOutput(insertedNode, targetDef.type);
    if (!source) continue;
    const [sourcePort] = source;
    const edgeId = `edge-${insertedNode.id}-${context.selectedNode.id}-${targetPort}`;
    preconditions.push({ type: 'node_not_exists', node_id: insertedNode.id });
    preconditions.push({ type: 'edge_not_exists', edge_id: edgeId });
    if (targetDef.maxConnections !== Infinity) {
      preconditions.push({ type: 'target_port_unoccupied', node_id: context.selectedNode.id, port: targetPort });
    }
    operations.push({ op: 'add_node', node: insertedNode });
    operations.push({
      op: 'connect',
      edge_id: edgeId,
      source: { node_id: insertedNode.id, port: sourcePort },
      target: { node_id: context.selectedNode.id, port: targetPort },
      mode: targetDef.maxConnections === Infinity ? 'append' : 'fail_if_occupied',
    });
    return;
  }
  const error = new Error(`No unoccupied compatible input on "${context.selectedNode.id}" for the inserted node output.`);
  error.code = 'ARCHITECT_NO_COMPATIBLE_PORT';
  throw error;
}

function assertAdjacentEdge(context, edgeId) {
  const edge = findEdge(context.graph, edgeId);
  if (!edge) {
    const error = new Error(`Edge "${edgeId}" was not found.`);
    error.code = 'ARCHITECT_EDGE_NOT_FOUND';
    throw error;
  }
  if (edge.source.nodeId !== context.selectedNode.id && edge.target.nodeId !== context.selectedNode.id) {
    const error = new Error(`Edge "${edgeId}" is outside the selected-node neighborhood.`);
    error.code = 'ARCHITECT_EDGE_OUT_OF_SCOPE';
    throw error;
  }
  return edge;
}

function compileInsertedChain(edit, context, preconditions, operations) {
  const inserts = edit.insert_nodes || [];
  if (inserts.length === 0) return false;
  const replaceEdgeIds = edit.replace_edge_ids?.length ? edit.replace_edge_ids : edit.replace_edge_id ? [edit.replace_edge_id] : [];
  if (inserts.length === 1 && replaceEdgeIds.length === 0) {
    const insertedNode = buildInsertedNode(inserts[0], context);
    if (inserts[0].position === 'before') {
      compileInsertBefore(inserts[0], context, insertedNode, preconditions, operations);
    } else {
      compileInsertAfter(inserts[0], context, insertedNode, preconditions, operations);
    }
    return true;
  }

  const direction = inserts[0]?.position === 'before' ? 'before' : 'after';
  const reserved = new Set();
  const insertedNodes = inserts.map((insert) => buildInsertedNode({ ...insert, position: direction }, context, reserved));
  const replaceEdges = replaceEdgeIds.map((edgeId) => assertAdjacentEdge(context, edgeId));

  for (const replaceEdge of replaceEdges) {
    const validDirection = direction === 'after'
      ? replaceEdge.source.nodeId === context.selectedNode.id
      : replaceEdge.target.nodeId === context.selectedNode.id;
    if (!validDirection) {
      const error = new Error(`Edge "${replaceEdge.id}" cannot be replaced by a ${direction} insertion chain.`);
      error.code = 'ARCHITECT_EDGE_DIRECTION_CONFLICT';
      throw error;
    }
  }

  if (replaceEdges.length > 0) {
    if (direction === 'before') assertManyIncomingReplacementSupported(context, replaceEdges, insertedNodes[0]);
    for (const replaceEdge of replaceEdges) {
      preconditions.push({ type: 'edge_exists', edge_id: replaceEdge.id });
      operations.push({
        op: 'disconnect',
        edge_id: replaceEdge.id,
        source: { node_id: replaceEdge.source.nodeId, port: replaceEdge.source.port },
        target: { node_id: replaceEdge.target.nodeId, port: replaceEdge.target.port },
      });
    }
  }

  addInsertedNodes(insertedNodes, preconditions, operations);

  if (direction === 'after') {
    pushConnect(context.selectedNode, insertedNodes[0], context.catalog, preconditions, operations);
    for (let index = 0; index < insertedNodes.length - 1; index += 1) {
      pushConnect(insertedNodes[index], insertedNodes[index + 1], context.catalog, preconditions, operations);
    }
    if (replaceEdges.length > 0) {
      for (const replaceEdge of replaceEdges) {
      const originalTarget = findNode(context.graph, replaceEdge.target.nodeId);
      pushConnect(insertedNodes[insertedNodes.length - 1], originalTarget, context.catalog, preconditions, operations, {
        targetPort: replaceEdge.target.port,
        mode: 'replace_existing',
      });
      }
    }
    return true;
  }

  if (replaceEdges.length > 0) {
    for (const replaceEdge of replaceEdges) {
      const originalSource = findNode(context.graph, replaceEdge.source.nodeId);
      if (replaceEdges.length > 1) {
        const manyConnection = compatibleManyConnection(originalSource, insertedNodes[0], context.catalog);
        pushConnect(originalSource, insertedNodes[0], context.catalog, preconditions, operations, {
          targetPort: manyConnection.targetPort,
        });
      } else {
        pushConnect(originalSource, insertedNodes[0], context.catalog, preconditions, operations);
      }
    }
  }
  for (let index = 0; index < insertedNodes.length - 1; index += 1) {
    pushConnect(insertedNodes[index], insertedNodes[index + 1], context.catalog, preconditions, operations);
  }
  const targetPort = replaceEdges[0]?.target.port || null;
  pushConnect(insertedNodes[insertedNodes.length - 1], context.selectedNode, context.catalog, preconditions, operations, {
    targetPort,
    mode: replaceEdges.length > 0 ? 'replace_existing' : 'fail_if_occupied',
  });
  return true;
}

function compileDisconnects(edit, context, preconditions, operations) {
  for (const edgeId of edit.disconnect_edge_ids || []) {
    const edge = assertAdjacentEdge(context, edgeId);
    preconditions.push({ type: 'edge_exists', edge_id: edgeId });
    operations.push({
      op: 'disconnect',
      edge_id: edgeId,
      source: { node_id: edge.source.nodeId, port: edge.source.port },
      target: { node_id: edge.target.nodeId, port: edge.target.port },
    });
  }
}

function compileExplicitConnections(edit, context, preconditions, operations) {
  const neighborhoodIds = new Set([context.selectedNode.id]);
  for (const edge of context.graph.edges) {
    if (edge.source.nodeId === context.selectedNode.id) neighborhoodIds.add(edge.target.nodeId);
    if (edge.target.nodeId === context.selectedNode.id) neighborhoodIds.add(edge.source.nodeId);
  }

  for (const connection of edit.connections || []) {
    if (!neighborhoodIds.has(connection.source_node_id) || !neighborhoodIds.has(connection.target_node_id)) {
      const error = new Error('Explicit rewires must stay inside the selected-node neighborhood.');
      error.code = 'ARCHITECT_REWIRE_OUT_OF_SCOPE';
      throw error;
    }
    const sourceNode = findNode(context.graph, connection.source_node_id);
    const targetNode = findNode(context.graph, connection.target_node_id);
    if (!sourceNode || !targetNode) {
      const error = new Error('Explicit rewire references an unknown node.');
      error.code = 'ARCHITECT_REWIRE_NODE_NOT_FOUND';
      throw error;
    }
    const edgeId = connection.edge_id || `edge-${sourceNode.id}-${targetNode.id}-${connection.target_port}`;
    const targetDefs = getInputPortDefinitions({
      category: targetNode.category,
      modelId: targetNode.modelId,
      nodeType: targetNode.nodeType,
      catalog: context.catalog,
    });
    const targetMaxConnections = targetDefs[connection.target_port]?.maxConnections ?? 1;
    const resolvedMode = targetMaxConnections === Infinity && connection.mode === 'fail_if_occupied'
      ? 'append'
      : connection.mode;
    preconditions.push({ type: 'edge_not_exists', edge_id: edgeId });
    if (resolvedMode === 'fail_if_occupied') {
      preconditions.push({ type: 'target_port_unoccupied', node_id: targetNode.id, port: connection.target_port });
    }
    operations.push({
      op: 'connect',
      edge_id: edgeId,
      source: { node_id: sourceNode.id, port: connection.source_port },
      target: { node_id: targetNode.id, port: connection.target_port },
      mode: resolvedMode,
    });
  }
}

export function compileBoundedEditToPatch(edit, context) {
  const node = context.selectedNode;
  if (!node) {
    const error = new Error('A selected node is required for bounded edits.');
    error.code = 'ARCHITECT_SELECTED_NODE_REQUIRED';
    throw error;
  }

  const operations = [];
  const preconditions = modelPreconditions(context.graph, node);

  for (const [parameter, value] of Object.entries(edit.parameter_updates || {})) {
    operations.push({
      op: 'set_node_parameter',
      node_id: node.id,
      parameter,
      value,
      expected_previous_value: node.parameters?.[parameter],
    });
  }

  if (edit.replacement_model_id) {
    const profile = getArchitectNodeProfile(node.category, edit.replacement_model_id, context.catalog);
    if (!profile) {
      const error = new Error(`Model "${edit.replacement_model_id}" is not an Architect-enabled ${node.category} alternative.`);
      error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
      throw error;
    }
    operations.push({
      op: 'set_node_model',
      node_id: node.id,
      model_id: edit.replacement_model_id,
    });
  }

  compileDisconnects(edit, context, preconditions, operations);
  compileInsertedChain(edit, context, preconditions, operations);
  compileExplicitConnections(edit, context, preconditions, operations);

  if (operations.length === 0) {
    const error = new Error('No supported bounded edit was found.');
    error.code = 'ARCHITECT_EMPTY_EDIT';
    throw error;
  }

  return createWorkflowPatch({
    baseRevision: context.graph.revision,
    preconditions,
    operations,
  });
}

export function summarizeBoundedEditProposal(edit, context) {
  const node = context.selectedNode;
  const changes = [];
  const parameterNames = Object.keys(edit.parameter_updates || {});
  if (parameterNames.length > 0) changes.push(`${parameterNames.length} parameter update${parameterNames.length === 1 ? '' : 's'}`);
  if (edit.replacement_model_id) changes.push(`model replacement to ${edit.replacement_model_id}`);
  if ((edit.insert_nodes || []).length > 1) {
    changes.push(`${edit.insert_nodes.length} inserted nodes`);
  } else if (edit.insert_node) {
    changes.push(`one ${edit.insert_node.category} node ${edit.insert_node.position}`);
  }
  if ((edit.replace_edge_ids || []).length > 0) {
    changes.push(`${edit.replace_edge_ids.length} branch edge replacement${edit.replace_edge_ids.length === 1 ? '' : 's'}`);
  } else if (edit.replace_edge_id) {
    changes.push('controlled branch replacement');
  }
  if ((edit.disconnect_edge_ids || []).length > 0) changes.push(`${edit.disconnect_edge_ids.length} disconnect operation${edit.disconnect_edge_ids.length === 1 ? '' : 's'}`);
  if ((edit.connections || []).length > 0) changes.push(`${edit.connections.length} controlled rewire${edit.connections.length === 1 ? '' : 's'}`);
  return {
    title: `Edit ${formatNode(node)}`,
    message: `Update ${formatNode(node)} with ${changes.join(' and ')}.`,
    assumptions: edit.assumptions || [],
    warnings: [],
    selected_subgraph: context.summary?.selected_subgraph || null,
  };
}

export function buildWorkflowExplanation(context) {
  const { graph, summary, validation } = context;
  const outputNodes = graph.nodes.filter((node) => node.exposure?.makeOutput);
  const inputNodes = graph.nodes.filter((node) => node.exposure?.makeInput);
  return {
    title: summary.name || 'Workflow explanation',
    message: `${summary.node_count} node${summary.node_count === 1 ? '' : 's'} and ${summary.edge_count} connection${summary.edge_count === 1 ? '' : 's'}.`,
    assumptions: [],
    warnings: validation.valid ? [] : ['The workflow has validation issues.'],
    workflow: {
      name: summary.name,
      category: summary.category || null,
      inputs: inputNodes.map((node) => ({ node_id: node.id, title: node.title, category: node.category })),
      outputs: outputNodes.map((node) => ({ node_id: node.id, title: node.title, category: node.category, model_id: node.modelId || null })),
      steps: graph.nodes.map((node) => ({
        node_id: node.id,
        title: node.title,
        kind: node.kind,
        category: node.category,
        model_id: node.modelId || null,
      })),
    },
  };
}

export function createNoopPatchForContext(context) {
  return createWorkflowPatch({
    baseRevision: context.graph.revision,
    preconditions: context.graph.revision != null
      ? [{ type: 'workflow_revision_equals', revision: context.graph.revision }]
      : [],
    operations: [],
  });
}

export function curatedAlternativeForNode(node) {
  const profiles = [defaultArchitectModelProfile(node.category)].filter(Boolean);
  return profiles.find((profile) => profile.modelId !== node.modelId)?.modelId || null;
}
