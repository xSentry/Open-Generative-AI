// Data-access layer for workflow_architect_requests (Phase 5). Scoped by user_id.
import { query } from '../../db/server/db.js';

const COLUMNS = `
  id, user_id, provider, workflow_id, prompt, status, result, error,
  created_at, updated_at
`;

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    workflowId: row.workflow_id,
    prompt: row.prompt,
    status: row.status,
    result: row.result || null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createArchitectRequest({ userId, provider, workflowId = null, prompt }) {
  const result = await query(
    `insert into workflow_architect_requests (user_id, provider, workflow_id, prompt)
     values ($1, $2, $3, $4)
     returning ${COLUMNS}`,
    [userId, provider, workflowId, prompt]
  );
  return mapRow(result.rows[0]);
}

export async function getArchitectRequest(id, { userId } = {}) {
  const params = userId ? [id, userId] : [id];
  const clause = userId ? 'where id = $1 and user_id = $2' : 'where id = $1';
  const result = await query(
    `select ${COLUMNS} from workflow_architect_requests ${clause}`,
    params
  );
  return mapRow(result.rows[0]);
}

export async function updateArchitectRequest(id, { status, result = undefined, error }) {
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

  const res = await query(
    `update workflow_architect_requests set ${sets.join(', ')}
     where id = $1
     returning ${COLUMNS}`,
    values
  );
  return mapRow(res.rows[0]);
}

