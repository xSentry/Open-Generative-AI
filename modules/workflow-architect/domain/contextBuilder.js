import { savedPayloadToWorkflowGraph } from '../../workflow-domain/workflowAdapters.js';
import { validateWorkflowGraph } from '../../workflow-domain/graphValidator.js';

export function buildCreateWorkflowContext(job, workflow, { catalog }) {
  if (job.provider !== 'replicate') {
    const error = new Error('Workflow Architect is only available for Replicate workflows.');
    error.code = 'UNSUPPORTED_PROVIDER';
    throw error;
  }
  if (job.operation !== 'create') {
    const error = new Error('Phase 2 supports create workflow jobs only.');
    error.code = 'ARCHITECT_OPERATION_UNSUPPORTED';
    throw error;
  }
  if (!workflow || workflow.userId !== job.userId || workflow.provider !== job.provider || workflow.isTemplate) {
    const error = new Error('Editable workflow not found.');
    error.code = 'WORKFLOW_NOT_FOUND';
    throw error;
  }

  const graph = savedPayloadToWorkflowGraph(
    {
      workflow_id: workflow.id,
      revision: workflow.revision || 1,
      name: workflow.name,
      category: workflow.category,
      edges: workflow.edges || [],
      data: { nodes: workflow.nodes || [] },
    },
    { provider: workflow.provider, catalog }
  );

  if (graph.nodes.length > 0 || graph.edges.length > 0) {
    const error = new Error('Phase 2 create workflow jobs require an empty saved workflow.');
    error.code = 'ARCHITECT_CREATE_REQUIRES_EMPTY_WORKFLOW';
    throw error;
  }

  const validation = validateWorkflowGraph(graph, { catalog });
  if (!validation.valid) {
    const error = new Error('Current workflow is not valid enough to use as Architect context.');
    error.code = 'ARCHITECT_CONTEXT_INVALID';
    error.validation = validation;
    throw error;
  }

  return {
    graph,
    request: {
      prompt: String(job.request?.prompt_redacted || job.request?.prompt || '').trim(),
    },
  };
}
