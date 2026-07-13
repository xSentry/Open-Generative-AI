import { createWorkflowPatch } from '../../workflow-domain/patchSchema.js';
import { makeConstantBinding, makeConnectionBinding } from '../../workflow-domain/graphSchema.js';
import {
  getInputPortDefinitions,
  getOutputPortDefinitions,
  inferNodeKind,
  nodeTypeForCategory,
  portTypesCompatible,
} from '../../workflow-domain/portRegistry.js';
import { defaultArchitectModelProfile, getArchitectModelProfile } from './capabilityCatalog.js';

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

export function compileCreateWorkflowIrToPatch(ir, {
  provider = 'replicate',
  baseRevision = null,
} = {}) {
  const profile = getArchitectModelProfile(ir.target_category, ir.model_id);
  if (!profile) {
    const error = new Error(`Model "${ir.model_id}" is not enabled for Architect workflows.`);
    error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
    throw error;
  }

  const promptNodeId = 'architect-input-prompt';
  const generationNodeId = `architect-${safeId(ir.target_category)}-generation`;
  const promptPort = profile.promptPort || 'prompt';
  const outputPort = outputPortForCategory(ir.target_category);
  const edgeId = `edge-${promptNodeId}-${generationNodeId}-${promptPort}`;

  const promptNode = {
    id: promptNodeId,
    nodeType: 'textNode',
    category: 'text',
    kind: 'input',
    title: 'Prompt',
    provider,
    modelId: 'text-passthrough',
    parameters: { prompt: ir.prompt },
    inputs: { prompt: makeConstantBinding(ir.prompt) },
    outputs: { text: { type: 'text', label: 'Text' } },
    exposure: { makeInput: true, makeOutput: false },
    layout: { x: 80, y: 120 },
  };

  const generationNode = {
    id: generationNodeId,
    nodeType: nodeTypeForCategory(ir.target_category, ir.model_id),
    category: ir.target_category,
    kind: 'generation',
    title: `${ir.target_category[0].toUpperCase()}${ir.target_category.slice(1)} Generator`,
    provider,
    modelId: ir.model_id,
    parameters: { ...(ir.parameters || {}) },
    inputs: {
      ...constantInputs(ir.parameters || {}),
      [promptPort]: makeConnectionBinding(promptNodeId, 'text'),
    },
    outputs: { [outputPort]: { type: outputTypeForCategory(ir.target_category), label: ir.target_category } },
    exposure: { makeInput: false, makeOutput: true },
    layout: { x: 440, y: 120 },
  };

  return createWorkflowPatch({
    baseRevision,
    preconditions: baseRevision != null
      ? [{ type: 'workflow_revision_equals', revision: baseRevision }]
      : [],
    operations: [
      { op: 'set_workflow_metadata', metadata: { name: ir.workflow_name, category: ir.target_category, source: 'architect' } },
      { op: 'add_node', node: promptNode },
      { op: 'add_node', node: generationNode },
      {
        op: 'connect',
        edge_id: edgeId,
        source: { node_id: promptNodeId, port: 'text' },
        target: { node_id: generationNodeId, port: promptPort },
        mode: 'fail_if_occupied',
      },
    ],
  });
}

export function summarizeCreateWorkflowProposal(ir) {
  return {
    title: ir.workflow_name,
    message: `Create a ${ir.target_category} workflow using ${ir.model_id}.`,
    assumptions: ir.assumptions || [],
    warnings: [],
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

function uniqueNodeId(graph, prefix) {
  const base = safeId(prefix) || 'architect-node';
  const ids = new Set(graph.nodes.map((node) => node.id));
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

function buildInsertedNode(insert, context) {
  const category = insert.category;
  const modelId = insert.model_id;
  const profile = getArchitectModelProfile(category, modelId);
  if (!profile) {
    const error = new Error(`Model "${modelId}" is not enabled for Architect ${category} insertion.`);
    error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
    throw error;
  }
  const parameters = { ...(profile.defaultParameters || {}), ...(insert.parameters || {}) };
  const nodeId = uniqueNodeId(context.graph, insert.node_id || `architect-${category}-${modelId}`);
  const nodeType = nodeTypeForCategory(category, modelId);
  return {
    id: nodeId,
    nodeType,
    category,
    kind: inferNodeKind(category, modelId),
    title: insert.title || `${category[0].toUpperCase()}${category.slice(1)} Generator`,
    provider: context.selectedNode.provider,
    modelId,
    parameters,
    inputs: constantInputs(parameters),
    outputs: getOutputPortDefinitions({ category, modelId }),
    exposure: { makeInput: false, makeOutput: false },
    layout: layoutNear(context.selectedNode, insert.position),
  };
}

function compileInsertAfter(insert, context, insertedNode, preconditions, operations) {
  const selectedOutputs = getOutputPortDefinitions({
    category: context.selectedNode.category,
    modelId: context.selectedNode.modelId,
  });
  for (const [sourcePort, sourceDef] of Object.entries(selectedOutputs)) {
    const target = firstCompatibleInput(insertedNode, sourceDef.type, context.catalog);
    if (!target) continue;
    const [targetPort] = target;
    insertedNode.inputs[targetPort] = makeConnectionBinding(context.selectedNode.id, sourcePort);
    const edgeId = `edge-${context.selectedNode.id}-${insertedNode.id}-${targetPort}`;
    preconditions.push({ type: 'node_not_exists', node_id: insertedNode.id });
    preconditions.push({ type: 'edge_not_exists', edge_id: edgeId });
    operations.push({ op: 'add_node', node: insertedNode });
    operations.push({
      op: 'connect',
      edge_id: edgeId,
      source: { node_id: context.selectedNode.id, port: sourcePort },
      target: { node_id: insertedNode.id, port: targetPort },
      mode: 'fail_if_occupied',
    });
    return;
  }
  const error = new Error(`No compatible input on "${insertedNode.modelId}" for the selected node output.`);
  error.code = 'ARCHITECT_NO_COMPATIBLE_PORT';
  throw error;
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
    if (occupied.has(targetPort)) continue;
    const source = firstCompatibleOutput(insertedNode, targetDef.type);
    if (!source) continue;
    const [sourcePort] = source;
    const edgeId = `edge-${insertedNode.id}-${context.selectedNode.id}-${targetPort}`;
    preconditions.push({ type: 'node_not_exists', node_id: insertedNode.id });
    preconditions.push({ type: 'edge_not_exists', edge_id: edgeId });
    preconditions.push({ type: 'target_port_unoccupied', node_id: context.selectedNode.id, port: targetPort });
    operations.push({ op: 'add_node', node: insertedNode });
    operations.push({
      op: 'connect',
      edge_id: edgeId,
      source: { node_id: insertedNode.id, port: sourcePort },
      target: { node_id: context.selectedNode.id, port: targetPort },
      mode: 'fail_if_occupied',
    });
    return;
  }
  const error = new Error(`No unoccupied compatible input on "${context.selectedNode.id}" for the inserted node output.`);
  error.code = 'ARCHITECT_NO_COMPATIBLE_PORT';
  throw error;
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
    const profile = getArchitectModelProfile(node.category, edit.replacement_model_id);
    if (!profile) {
      const error = new Error(`Model "${edit.replacement_model_id}" is not a curated ${node.category} alternative.`);
      error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
      throw error;
    }
    operations.push({
      op: 'set_node_model',
      node_id: node.id,
      model_id: edit.replacement_model_id,
    });
  }

  if (edit.insert_node) {
    const insertedNode = buildInsertedNode(edit.insert_node, context);
    if (edit.insert_node.position === 'before') {
      compileInsertBefore(edit.insert_node, context, insertedNode, preconditions, operations);
    } else {
      compileInsertAfter(edit.insert_node, context, insertedNode, preconditions, operations);
    }
  }

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
  if (edit.insert_node) changes.push(`one ${edit.insert_node.category} node ${edit.insert_node.position}`);
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
