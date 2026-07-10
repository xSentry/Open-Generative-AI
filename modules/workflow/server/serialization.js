// Maps internal workflow repo objects (camelCase) to the MuAPI-compatible JSON
// contract the workflow UI consumes. Keeping the shapes identical here is what
// lets the UI stay completely unchanged (see plan §0 / §4).

// Summary shape used by the list endpoints (get-workflow-defs,
// get-template-workflows, get-published-workflows).
export function serializeWorkflowSummary(workflow, callerId = null) {
  if (!workflow) return null;
  return {
    // `id` mirrors what MuAPI returns and is what the WorkflowStudio list uses
    // for React keys, routing, delete and rename (wf.id). `workflow_id` is kept
    // for the documented MuAPI-compatible contract.
    id: workflow.id,
    workflow_id: workflow.id,
    name: workflow.name,
    category: workflow.category || null,
    thumbnail: workflow.thumbnailKey || null,
    published: !!workflow.published,
    is_template: !!workflow.isTemplate,
    // Lets the UI choose between "edit" (owner) and "use template / clone"
    // (everyone else) on the template and community lists.
    is_owner: callerId != null ? workflow.userId === callerId : undefined,
    updated_at: workflow.updatedAt,
    created_at: workflow.createdAt,
  };
}

// Full definition returned by get-workflow-def/{id}. `is_owner` is derived from
// the caller identity, and `data.nodes` mirrors the MuAPI envelope.
export function serializeWorkflowDef(workflow, callerId) {
  if (!workflow) return null;
  return {
    workflow_id: workflow.id,
    name: workflow.name,
    is_owner: workflow.userId === callerId,
    edges: workflow.edges || [],
    data: { nodes: workflow.nodes || [] },
    category: workflow.category || null,
    published: !!workflow.published,
  };
}

// Aggregate node-run rows into the run status envelope the UI polls:
//   { status, run_id, target_node_id, nodes: { <nodeId>: [ { status, result }, ... ] } }
// Rows must be ordered chronologically so the UI's outputHistory is correct.
export function serializeRunStatus(nodeRuns = [], run = null) {
  const nodes = {};
  for (const run of nodeRuns) {
    const key = run.nodeId;
    if (!nodes[key]) nodes[key] = [];
    nodes[key].push({
      node_run_id: run.id,
      status: run.status,
      result: run.result || null,
      error: run.error || null,
    });
  }
  return {
    status: run?.status || null,
    run_id: run?.id || null,
    target_node_id: run?.targetNodeId || null,
    error: run?.error || null,
    nodes,
  };
}

// Group node-run rows into the run_history envelope the builder consumes when a
// workflow is reopened: { <nodeId>: [ { node_run_id, status, result, error,
// started_at }, ... ] }. Chronological so the UI's outputHistory order is right.
export function serializeRunHistory(nodeRuns = []) {
  const history = {};
  for (const run of nodeRuns) {
    const key = run.nodeId;
    if (!history[key]) history[key] = [];
    history[key].push({
      node_run_id: run.id,
      status: run.status,
      result: run.result || null,
      error: run.error || null,
      started_at: run.createdAt || null,
    });
  }
  return history;
}

// Projection for the playground api-outputs endpoint.
export function serializeApiOutputs(run, outputs = [], nodeRuns = []) {
  const nodes = {};
  for (const nodeRun of nodeRuns || []) {
    const key = nodeRun.nodeId;
    if (!key) continue;
    if (!nodes[key]) nodes[key] = [];
    nodes[key].push({
      node_run_id: nodeRun.id,
      status: nodeRun.status,
      result: nodeRun.result || null,
      error: nodeRun.error || null,
    });
  }
  return {
    status: run?.status || 'processing',
    outputs: outputs || [],
    error: run?.error || null,
    nodes,
  };
}

// Projection for poll-architect/{id}/result. The UI reads `status` plus the
// spread result fields (`message`, `suggestions`, `workflow`).
export function serializeArchitectResult(request) {
  if (!request) return { status: 'failed', error: 'Not found' };
  return {
    status: request.status,
    error: request.error || null,
    ...(request.result || {}),
  };
}

