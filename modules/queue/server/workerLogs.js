import { query } from '../../db/server/db.js';

export async function createWorkerLog({ type, data }, deps = {}) {
  const runQuery = deps.query || query;
  const result = await runQuery(
    `insert into worker_logs (type, data)
     values ($1, $2::jsonb)
     returning id, type, data, created_at`,
    [type, JSON.stringify(data || {})]
  );
  const row = result.rows[0];
  return {
    id: row.id,
    type: row.type,
    data: row.data || {},
    createdAt: row.created_at,
  };
}

export function isFinalJobAttempt(job) {
  const attempts = Number(job?.opts?.attempts || 1);
  const attemptsMade = Number(job?.attemptsMade || 0);
  return attemptsMade >= attempts;
}

export async function createFinalAttemptWorkerLog(job, { type, data }, deps = {}) {
  if (!isFinalJobAttempt(job)) return null;
  return createWorkerLog({ type, data }, deps);
}
