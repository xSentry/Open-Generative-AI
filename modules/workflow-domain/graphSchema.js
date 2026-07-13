export const WORKFLOW_GRAPH_VERSION = 'workflow-graph/v1';

export const NODE_KINDS = new Set(['input', 'generation', 'utility', 'api']);
export const NODE_CATEGORIES = new Set(['text', 'image', 'video', 'audio', 'utility', 'api']);
export const PROVIDERS = new Set(['replicate', 'muapi', 'custom']);

export function cloneJson(value) {
  if (value == null) return value;
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function createWorkflowGraph({
  workflowId = undefined,
  revision = undefined,
  name = 'Untitled',
  category = undefined,
  source = 'manual',
  nodes = [],
  edges = [],
} = {}) {
  return {
    version: WORKFLOW_GRAPH_VERSION,
    ...(workflowId ? { workflowId } : {}),
    ...(revision != null ? { revision } : {}),
    metadata: {
      name,
      ...(category ? { category } : {}),
      source,
    },
    nodes,
    edges,
  };
}

export function isWorkflowGraphV1(value) {
  return !!value && value.version === WORKFLOW_GRAPH_VERSION && Array.isArray(value.nodes) && Array.isArray(value.edges);
}

export function makeConnectionBinding(sourceNodeId, sourcePort = 'result') {
  return { type: 'connection', sourceNodeId, sourcePort };
}

export function makeConstantBinding(value) {
  return { type: 'constant', value };
}

export function isConnectionBinding(value) {
  return value?.type === 'connection' && typeof value.sourceNodeId === 'string';
}

export function isConstantBinding(value) {
  return value?.type === 'constant';
}

export function nodeCategory(node) {
  if (node?.category) return node.category;
  if (node?.kind === 'utility') return 'utility';
  if (node?.kind === 'api') return 'api';
  return null;
}
