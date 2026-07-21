import { savedPayloadToWorkflowGraph } from '../../workflow-domain/workflowAdapters.js';
import { validateWorkflowGraph } from '../../workflow-domain/graphValidator.js';
import { requireProviderFeature } from '../../providers/publicRegistry.js';

function assertEditableProviderWorkflow(job, workflow) {
  requireProviderFeature(job.provider, 'workflowArchitect');
  if (!workflow || workflow.userId !== job.userId || workflow.provider !== job.provider || workflow.isTemplate) {
    const error = new Error('Editable workflow not found.');
    error.code = 'WORKFLOW_NOT_FOUND';
    throw error;
  }
}

function workflowToGraph(workflow, catalog) {
  return savedPayloadToWorkflowGraph(
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
}

function compactNode(node) {
  if (!node) return null;
  return {
    id: node.id,
    title: node.title,
    category: node.category,
    kind: node.kind,
    model_id: node.modelId || null,
  };
}

function selectedNeighborhood(graph, selectedNode) {
  if (!selectedNode) return null;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = graph.edges
    .filter((edge) => edge.target.nodeId === selectedNode.id)
    .map((edge) => ({
      edge_id: edge.id,
      source: compactNode(nodesById.get(edge.source.nodeId)),
      source_port: edge.source.port,
      target_port: edge.target.port,
    }));
  const outgoing = graph.edges
    .filter((edge) => edge.source.nodeId === selectedNode.id)
    .map((edge) => ({
      edge_id: edge.id,
      target: compactNode(nodesById.get(edge.target.nodeId)),
      source_port: edge.source.port,
      target_port: edge.target.port,
    }));
  return {
    selected: compactNode(selectedNode),
    incoming,
    outgoing,
  };
}

export function buildCreateWorkflowContext(job, workflow, { catalog }) {
  assertEditableProviderWorkflow(job, workflow);
  if (job.operation !== 'create') {
    const error = new Error('Create workflow context requires a create job.');
    error.code = 'ARCHITECT_OPERATION_UNSUPPORTED';
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

export function buildWorkflowContext(job, workflow, { catalog, selectedNodeId = null } = {}) {
  assertEditableProviderWorkflow(job, workflow);
  const graph = workflowToGraph(workflow, catalog);
  const validation = validateWorkflowGraph(graph, { catalog });
  const selectedNode = selectedNodeId
    ? graph.nodes.find((node) => node.id === selectedNodeId) || null
    : null;

  if (selectedNodeId && !selectedNode) {
    const error = new Error(`Selected node "${selectedNodeId}" was not found.`);
    error.code = 'ARCHITECT_SELECTED_NODE_NOT_FOUND';
    throw error;
  }

  return {
    graph,
    catalog,
    validation,
    selectedNode,
    summary: {
      workflow_id: workflow.id,
      revision: graph.revision,
      name: graph.metadata?.name || workflow.name,
      category: graph.metadata?.category || workflow.category,
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      selected_subgraph: selectedNeighborhood(graph, selectedNode),
      nodes: graph.nodes.map(compactNode),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    },
  };
}
