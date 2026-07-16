import { cloneJson } from './graphSchema.js';

export class WorkflowRevisionConflict extends Error {
  constructor(currentRevision, expectedRevision) {
    super('The workflow changed after this operation was started.');
    this.name = 'WorkflowRevisionConflict';
    this.code = 'WORKFLOW_REVISION_CONFLICT';
    this.currentRevision = currentRevision;
    this.expectedRevision = expectedRevision;
  }
}

export function assertRevisionMatches(currentRevision, expectedRevision) {
  if (expectedRevision == null) return;
  if (currentRevision !== expectedRevision) {
    throw new WorkflowRevisionConflict(currentRevision, expectedRevision);
  }
}

export function createInitialRevision({ workflowId, graph, source = 'manual', createdAt = new Date().toISOString() } = {}) {
  return {
    workflowId,
    revision: 1,
    parentRevision: null,
    source,
    graph: { ...cloneJson(graph), revision: 1 },
    createdAt,
  };
}

export function createNextRevision({
  workflowId,
  currentRevision = 0,
  graph,
  source = 'manual',
  proposalId = undefined,
  compilerVersion = undefined,
  catalogVersion = undefined,
  createdAt = new Date().toISOString(),
} = {}) {
  const revision = Number(currentRevision || 0) + 1;
  return {
    workflowId,
    revision,
    parentRevision: currentRevision || null,
    source,
    ...(proposalId ? { proposalId } : {}),
    ...(compilerVersion ? { compilerVersion } : {}),
    ...(catalogVersion ? { catalogVersion } : {}),
    graph: { ...cloneJson(graph), revision },
    createdAt,
  };
}

export function createRevertRevision({
  workflowId,
  currentRevision,
  targetRevision,
  targetGraph,
  createdAt = new Date().toISOString(),
} = {}) {
  const next = createNextRevision({
    workflowId,
    currentRevision,
    graph: targetGraph,
    source: 'revert',
    createdAt,
  });
  return {
    ...next,
    revertedToRevision: targetRevision,
  };
}
