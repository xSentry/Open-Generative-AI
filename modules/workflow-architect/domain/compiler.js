import { createWorkflowPatch } from '../../workflow-domain/patchSchema.js';
import { makeConstantBinding, makeConnectionBinding } from '../../workflow-domain/graphSchema.js';
import { nodeTypeForCategory } from '../../workflow-domain/portRegistry.js';
import { getArchitectModelProfile } from './capabilityCatalog.js';

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
