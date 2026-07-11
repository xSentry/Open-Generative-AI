import { query } from '../../db/server/db.js';

function camelSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function camelAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    asset_label: row.asset_label,
    url: row.url,
    kind: row.kind,
    source_tool: row.source_tool,
    model: row.model,
    prompt: row.prompt,
    metadata: row.metadata || {},
    created_at: row.created_at,
  };
}

function camelJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    status: row.status,
    action: row.action,
    approved: row.approved,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function camelEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    cursor: Number(row.cursor),
    type: row.type,
    payload: row.payload || {},
    created_at: row.created_at,
  };
}

export async function listSessions({ userId, provider }) {
  const result = await query(
    `select id, name, created_at, updated_at
       from design_agent_sessions
      where user_id = $1 and provider = $2
      order by updated_at desc`,
    [userId, provider],
  );
  return result.rows.map(camelSession);
}

export async function createSession({ userId, provider, name = 'New Session' }) {
  const result = await query(
    `insert into design_agent_sessions (user_id, provider, name)
     values ($1, $2, $3)
     returning id, name, created_at, updated_at`,
    [userId, provider, name],
  );
  return camelSession(result.rows[0]);
}

export async function getSession(id, { userId, provider }) {
  const result = await query(
    `select id, name, created_at, updated_at
       from design_agent_sessions
      where id = $1 and user_id = $2 and provider = $3
      limit 1`,
    [id, userId, provider],
  );
  return camelSession(result.rows[0]);
}

export async function renameSession(id, { userId, provider, name }) {
  const result = await query(
    `update design_agent_sessions
        set name = $4, updated_at = now()
      where id = $1 and user_id = $2 and provider = $3
      returning id, name, created_at, updated_at`,
    [id, userId, provider, name],
  );
  return camelSession(result.rows[0]);
}

export async function deleteSession(id, { userId, provider }) {
  const result = await query(
    `delete from design_agent_sessions
      where id = $1 and user_id = $2 and provider = $3
      returning id`,
    [id, userId, provider],
  );
  return Boolean(result.rows[0]);
}

export async function getMessages(sessionId, { userId, provider }) {
  const session = await getSession(sessionId, { userId, provider });
  if (!session) return null;
  const result = await query(
    `select messages from design_agent_messages where session_id = $1 limit 1`,
    [sessionId],
  );
  return result.rows[0]?.messages || [];
}

export async function setMessages(sessionId, { userId, provider, messages }) {
  const session = await getSession(sessionId, { userId, provider });
  if (!session) return null;
  await query(
    `insert into design_agent_messages (session_id, messages, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (session_id)
     do update set messages = excluded.messages, updated_at = now()`,
    [sessionId, JSON.stringify(Array.isArray(messages) ? messages : [])],
  );
  await touchSession(sessionId);
  return true;
}

export async function listAssets(sessionId, { userId, provider }) {
  const result = await query(
    `select a.*
       from design_agent_assets a
       join design_agent_sessions s on s.id = a.session_id
      where a.session_id = $1 and a.user_id = $2 and a.provider = $3 and s.user_id = $2
      order by a.created_at asc`,
    [sessionId, userId, provider],
  );
  return result.rows.map(camelAsset);
}

export async function createAsset({
  sessionId,
  userId,
  provider,
  url,
  kind = 'image',
  sourceTool = null,
  model = null,
  prompt = null,
  metadata = {},
}) {
  const count = await query(
    `select count(*)::int as count from design_agent_assets where session_id = $1`,
    [sessionId],
  );
  const label = `asset_${Number(count.rows[0]?.count || 0) + 1}`;
  const result = await query(
    `insert into design_agent_assets
       (session_id, user_id, provider, asset_label, url, kind, source_tool, model, prompt, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     returning *`,
    [sessionId, userId, provider, label, url, kind, sourceTool, model, prompt, JSON.stringify(metadata || {})],
  );
  await touchSession(sessionId);
  return camelAsset(result.rows[0]);
}

export async function findAssetByLabel(sessionId, { userId, provider, label }) {
  const result = await query(
    `select *
       from design_agent_assets
      where session_id = $1 and user_id = $2 and provider = $3 and asset_label = $4
      limit 1`,
    [sessionId, userId, provider, label],
  );
  return camelAsset(result.rows[0]);
}

export async function createJob({ sessionId, userId, provider, action, payload }) {
  const result = await query(
    `insert into design_agent_jobs (session_id, user_id, provider, action, payload)
     values ($1, $2, $3, $4, $5::jsonb)
     returning *`,
    [sessionId, userId, provider, action, JSON.stringify(payload || {})],
  );
  await touchSession(sessionId);
  return camelJob(result.rows[0]);
}

export async function getJob(id, { userId, provider }) {
  const result = await query(
    `select * from design_agent_jobs
      where id = $1 and user_id = $2 and provider = $3
      limit 1`,
    [id, userId, provider],
  );
  return camelJob(result.rows[0]);
}

export async function getJobForProcessing(id) {
  const result = await query(
    `select * from design_agent_jobs where id = $1 limit 1`,
    [id],
  );
  return result.rows[0] || null;
}

export async function listJobs(sessionId, { userId, provider }) {
  const result = await query(
    `select *
       from design_agent_jobs
      where session_id = $1 and user_id = $2 and provider = $3
      order by created_at desc`,
    [sessionId, userId, provider],
  );
  return result.rows.map(camelJob);
}

export async function updateJob(id, fields) {
  const sets = [];
  const values = [id];
  let index = 2;
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${index}`);
    values.push(value);
    index += 1;
  }
  if (fields.status && ['succeeded', 'completed', 'failed', 'cancelled', 'rejected'].includes(fields.status)) {
    sets.push('completed_at = now()');
  }
  sets.push('updated_at = now()');
  const result = await query(
    `update design_agent_jobs set ${sets.join(', ')} where id = $1 returning *`,
    values,
  );
  return camelJob(result.rows[0]);
}

export async function addEvent({ jobId, sessionId, userId, type, payload = {} }) {
  const result = await query(
    `insert into design_agent_job_events (job_id, session_id, user_id, type, payload)
     values ($1, $2, $3, $4, $5::jsonb)
     returning *`,
    [jobId, sessionId, userId, type, JSON.stringify(payload || {})],
  );
  return camelEvent(result.rows[0]);
}

export async function listEvents(jobId, { userId, since = 0 }) {
  const result = await query(
    `select *
       from design_agent_job_events
      where job_id = $1 and user_id = $2 and cursor > $3
      order by cursor asc`,
    [jobId, userId, Number(since) || 0],
  );
  return result.rows.map(camelEvent);
}

export async function touchSession(sessionId) {
  await query(
    `update design_agent_sessions set updated_at = now() where id = $1`,
    [sessionId],
  );
}
