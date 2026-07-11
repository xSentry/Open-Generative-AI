// Data-access layer for workflow_runs and workflow_node_runs (Phase 3/4).
//
// A run is one execution of a whole graph; each node produces one (or, across
// repeated single-node runs, several) workflow_node_runs rows. Everything is
// scoped by user_id so ownership is enforced at the query level, mirroring
// modules/studio/server/generationsRepo.js.
import { query } from '../../db/server/db.js';

const RUN_COLUMNS = `
  id, workflow_id, user_id, provider, target_node_id, status, inputs, error,
  created_at, updated_at
`;

const NODE_RUN_COLUMNS = `
  id, run_id, node_id, status, model, params, result, output_keys, provider_ref,
  error, created_at, updated_at, completed_at
`;

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    workflowId: row.workflow_id,
    userId: row.user_id,
    provider: row.provider,
    targetNodeId: row.target_node_id,
    status: row.status,
    inputs: row.inputs || {},
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNodeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    status: row.status,
    model: row.model,
    params: row.params || {},
    result: row.result || null,
    outputKeys: row.output_keys || [],
    providerRef: row.provider_ref,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

// ---- Runs ----

export async function createRun({
  workflowId,
  userId,
  provider = null,
  targetNodeId = null,
  inputs = {},
  status = 'processing',
}) {
  const result = await query(
    `insert into workflow_runs (workflow_id, user_id, provider, target_node_id, status, inputs)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     returning ${RUN_COLUMNS}`,
    [workflowId, userId, provider, targetNodeId, status, JSON.stringify(inputs || {})]
  );
  return mapRun(result.rows[0]);
}

// Atomically claim a single pending run (processing -> running). Returns the row
// only if this caller won the claim, so an inline enqueue and the worker loop
// never double-process the same run.
export async function claimRun(id) {
  const result = await query(
    `update workflow_runs
       set status = 'running', updated_at = now()
     where id = $1 and status = 'processing'
     returning ${RUN_COLUMNS}`,
    [id]
  );
  return mapRun(result.rows[0]);
}

// Atomically claim a batch of pending runs for the worker using SKIP LOCKED so
// multiple workers/instances never grab the same run.
export async function claimPendingRuns(limit = 4) {
  const result = await query(
    `update workflow_runs
       set status = 'running', updated_at = now()
     where id in (
       select id from workflow_runs
       where status = 'processing'
       order by created_at asc
       for update skip locked
       limit $1
     )
     returning ${RUN_COLUMNS}`,
    [limit]
  );
  return result.rows.map(mapRun);
}

// Fail runs stuck in a non-terminal state past the timeout (crashed worker /
// server restart mid-run). Their queued/running node-runs are failed too.
export async function reapStaleRuns(timeoutMinutes = 30) {
  const result = await query(
    `update workflow_runs
       set status = 'failed', error = 'timeout', updated_at = now()
     where status in ('processing','running')
       and updated_at < now() - ($1 || ' minutes')::interval
     returning ${RUN_COLUMNS}`,
    [String(timeoutMinutes)]
  );
  const runs = result.rows.map(mapRun);
  if (runs.length > 0) {
    await query(
      `update workflow_node_runs
         set status = 'failed', error = 'timeout', updated_at = now(), completed_at = now()
       where run_id = any($1::uuid[]) and status in ('queued','processing','running')`,
      [runs.map((r) => r.id)]
    );
  }
  return runs;
}

// A run is readable if the caller owns it. When `userId` is omitted (internal
// background execution) the ownership filter is skipped.
export async function getRun(id, { userId } = {}) {
  const params = userId ? [id, userId] : [id];
  const clause = userId ? 'where id = $1 and user_id = $2' : 'where id = $1';
  const result = await query(
    `select ${RUN_COLUMNS} from workflow_runs ${clause}`,
    params
  );
  return mapRun(result.rows[0]);
}

export async function updateRun(id, { status, error }) {
  const result = await query(
    `update workflow_runs
       set status = coalesce($2, status),
           error = coalesce($3, error),
           updated_at = now()
     where id = $1
     returning ${RUN_COLUMNS}`,
    [id, status || null, error ? String(error).slice(0, 2000) : null]
  );
  return mapRun(result.rows[0]);
}

// ---- Node runs ----

export async function createNodeRun({ runId, nodeId, model = null, params = {}, status = 'processing' }) {
  const result = await query(
    `insert into workflow_node_runs (run_id, node_id, model, params, status)
     values ($1, $2, $3, $4::jsonb, $5)
     returning ${NODE_RUN_COLUMNS}`,
    [runId, nodeId, model, JSON.stringify(params || {}), status]
  );
  return mapNodeRun(result.rows[0]);
}

export async function updateNodeRun(id, { status, result = undefined, error, providerRef, outputKeys = undefined }) {
  const sets = ['status = coalesce($2, status)', 'updated_at = now()'];
  const values = [id, status || null];

  if (result !== undefined) {
    values.push(result === null ? null : JSON.stringify(result));
    sets.push(`result = $${values.length}::jsonb`);
  }
  if (error !== undefined) {
    values.push(error ? String(error).slice(0, 2000) : null);
    sets.push(`error = $${values.length}`);
  }
  if (providerRef !== undefined) {
    values.push(providerRef || null);
    sets.push(`provider_ref = $${values.length}`);
  }
  if (outputKeys !== undefined) {
    values.push(JSON.stringify(outputKeys || []));
    sets.push(`output_keys = $${values.length}::jsonb`);
  }
  // Stamp completion time on terminal states so the reaper/UI can reason about it.
  if (status === 'succeeded' || status === 'failed' || status === 'completed') {
    sets.push('completed_at = now()');
  }

  const res = await query(
    `update workflow_node_runs set ${sets.join(', ')}
     where id = $1
     returning ${NODE_RUN_COLUMNS}`,
    values
  );
  return mapNodeRun(res.rows[0]);
}

// A single node-run scoped by owner (via the parent run) for cleanup/reads.
export async function getNodeRun(id, { userId } = {}) {
  const params = userId ? [id, userId] : [id];
  const clause = userId
    ? `where nr.id = $1 and r.user_id = $2`
    : `where nr.id = $1`;
  const result = await query(
    `select ${NODE_RUN_COLUMNS.split(',').map((c) => `nr.${c.trim()}`).join(', ')}
     from workflow_node_runs nr
     join workflow_runs r on r.id = nr.run_id
     ${clause}`,
    params
  );
  return mapNodeRun(result.rows[0]);
}

// All node-run rows for a run, chronological so the UI's outputHistory order is
// correct and the "latest run wins" logic (runs[runs.length - 1]) holds.
export async function listNodeRuns(runId) {
  const result = await query(
    `select ${NODE_RUN_COLUMNS} from workflow_node_runs
     where run_id = $1
     order by created_at asc, id asc`,
    [runId]
  );
  return result.rows.map(mapNodeRun);
}

// Delete a single node-run row, but only if the parent run belongs to the user.
// Returns the deleted id plus its stored S3 output keys so the caller can remove
// the media from the bucket.
export async function deleteNodeRun(id, { userId }) {
  const result = await query(
    `delete from workflow_node_runs nr
     using workflow_runs r
     where nr.id = $1 and nr.run_id = r.id and r.user_id = $2
     returning nr.id, nr.output_keys`,
    [id, userId]
  );
  const row = result.rows[0];
  return row ? { id: row.id, outputKeys: row.output_keys || [] } : null;
}

// Every S3 output key stored under a workflow (across all its runs/node-runs),
// so deleting the workflow can purge the media before the rows cascade away.
export async function getWorkflowOutputKeys(workflowId, { userId } = {}) {
  const params = userId ? [workflowId, userId] : [workflowId];
  const clause = userId ? 'and r.user_id = $2' : '';
  const result = await query(
    `select nr.output_keys
     from workflow_node_runs nr
     join workflow_runs r on r.id = nr.run_id
     where r.workflow_id = $1 ${clause}`,
    params
  );
  const keys = [];
  for (const row of result.rows) {
    for (const key of row.output_keys || []) if (key) keys.push(key);
  }
  return keys;
}

// All S3 output keys stored under a single run (for run-level cleanup).
export async function getRunOutputKeys(runId, { userId } = {}) {
  const params = userId ? [runId, userId] : [runId];
  const clause = userId ? 'and r.user_id = $2' : '';
  const result = await query(
    `select nr.output_keys
     from workflow_node_runs nr
     join workflow_runs r on r.id = nr.run_id
     where nr.run_id = $1 ${clause}`,
    params
  );
  const keys = [];
  for (const row of result.rows) {
    for (const key of row.output_keys || []) if (key) keys.push(key);
  }
  return keys;
}

// The latest succeeded result per node across a whole workflow. Used to resolve
// a single-node run's upstream inputs from whatever was generated previously.
export async function latestResultsForWorkflow(workflowId) {  const result = await query(
    `select distinct on (nr.node_id) nr.node_id, nr.result
     from workflow_node_runs nr
     join workflow_runs r on r.id = nr.run_id
     where r.workflow_id = $1 and nr.status = 'succeeded' and nr.result is not null
     order by nr.node_id, nr.created_at desc`,
    [workflowId]
  );
  const map = {};
  for (const row of result.rows) {
    if (row.result?.outputs) map[row.node_id] = row.result.outputs;
  }
  return map;
}

// The most recent run for a workflow (any status), owner-scoped. Lets the load
// path tell the UI whether a run is still in progress (so it can resume the SSE
// watcher) and which run_id the node history belongs to.
export async function getLatestRunForWorkflow(workflowId, { userId } = {}) {
  const params = userId ? [workflowId, userId] : [workflowId];
  const clause = userId ? 'and user_id = $2' : '';
  const result = await query(
    `select ${RUN_COLUMNS} from workflow_runs
     where workflow_id = $1 ${clause}
     order by created_at desc
     limit 1`,
    params
  );
  return mapRun(result.rows[0]);
}

// Every node-run for a workflow (across all its runs), chronological and owner-
// scoped. Powers the per-node output history + current output/state shown when a
// workflow is reopened (the DB is the source of truth, not saved node data).
export async function listWorkflowNodeRuns(workflowId, { userId, limit = 1000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  const params = userId ? [workflowId, userId, safeLimit] : [workflowId, safeLimit];
  const clause = userId ? 'and r.user_id = $2' : '';
  const limitParam = userId ? '$3' : '$2';
  const result = await query(
    `select ${NODE_RUN_COLUMNS.split(',').map((c) => `nr.${c.trim()}`).join(', ')}
     from workflow_node_runs nr
     join workflow_runs r on r.id = nr.run_id
     where r.workflow_id = $1 ${clause}
     order by nr.created_at asc, nr.id asc
     limit ${limitParam}`,
    params
  );
  return result.rows.map(mapNodeRun);
}

// Node-runs for a user whose row changed after `since` — powers the SSE stream
// so the workflow UI gets pushed updates instead of polling (mirrors studio's
// listUpdatedGenerations).
export async function listUpdatedNodeRuns({ userId, since, limit = 200 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const result = await query(
    `select ${NODE_RUN_COLUMNS.split(',').map((c) => `nr.${c.trim()}`).join(', ')},
            r.workflow_id, r.status as run_status,
            greatest(nr.updated_at, r.updated_at) as stream_updated_at
     from workflow_node_runs nr
     join workflow_runs r on r.id = nr.run_id
     where r.user_id = $1 and greatest(nr.updated_at, r.updated_at) > $2
     order by greatest(nr.updated_at, r.updated_at) asc
     limit $3`,
    [userId, since, safeLimit]
  );
  return result.rows.map((row) => ({
    ...mapNodeRun(row),
    workflowId: row.workflow_id,
    runStatus: row.run_status,
    streamUpdatedAt: row.stream_updated_at,
  }));
}



