// Data-access layer for studio_generations. Every read/mutation is scoped by
// user_id so ownership is enforced at the query level.
import { query } from '../../db/server/db.js';

const SELECT_COLUMNS = `
  id, user_id, mode, media_type, provider, model, prompt, params, input_assets,
  status, provider_ref, error, output_key, output_type, output_meta,
  created_at, updated_at, completed_at
`;

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    mediaType: row.media_type,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    params: row.params || {},
    inputAssets: row.input_assets || [],
    status: row.status,
    providerRef: row.provider_ref,
    error: row.error,
    outputKey: row.output_key,
    outputType: row.output_type,
    outputMeta: row.output_meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export async function createGeneration({
  userId,
  mode,
  mediaType,
  provider,
  model,
  prompt = null,
  params = {},
  inputAssets = [],
  status = 'generating',
}) {
  const result = await query(
    `insert into studio_generations
       (user_id, mode, media_type, provider, model, prompt, params, input_assets, status)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     returning ${SELECT_COLUMNS}`,
    [
      userId,
      mode,
      mediaType,
      provider,
      model,
      prompt,
      JSON.stringify(params || {}),
      JSON.stringify(inputAssets || []),
      status,
    ]
  );
  return mapRow(result.rows[0]);
}

export async function getGeneration(id, userId) {
  const params = userId ? [id, userId] : [id];
  const clause = userId ? 'where id = $1 and user_id = $2' : 'where id = $1';
  const result = await query(
    `select ${SELECT_COLUMNS} from studio_generations ${clause}`,
    params
  );
  return mapRow(result.rows[0]);
}

export async function listGenerations({ userId, mediaType, mode, status, limit = 50, cursor } = {}) {
  const conditions = ['user_id = $1'];
  const values = [userId];

  if (mediaType) {
    values.push(mediaType);
    conditions.push(`media_type = $${values.length}`);
  }
  // `mode` may be a single mode or a list of modes (e.g. Video Studio spans
  // t2v/i2v/v2v). Build an IN clause so each tool only sees its own history.
  const modes = Array.isArray(mode) ? mode.filter(Boolean) : mode ? [mode] : [];
  if (modes.length === 1) {
    values.push(modes[0]);
    conditions.push(`mode = $${values.length}`);
  } else if (modes.length > 1) {
    const placeholders = modes.map((m) => {
      values.push(m);
      return `$${values.length}`;
    });
    conditions.push(`mode in (${placeholders.join(', ')})`);
  }
  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  if (cursor?.createdAt && cursor?.id) {
    values.push(cursor.createdAt);
    values.push(cursor.id);
    conditions.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  values.push(safeLimit + 1);

  const result = await query(
    `select ${SELECT_COLUMNS} from studio_generations
     where ${conditions.join(' and ')}
     order by created_at desc, id desc
     limit $${values.length}`,
    values
  );

  const rows = result.rows.map(mapRow);
  let nextCursor = null;
  if (rows.length > safeLimit) {
    const last = rows[safeLimit - 1];
    nextCursor = { createdAt: last.createdAt, id: last.id };
    rows.length = safeLimit;
  }

  return { items: rows, nextCursor };
}

// Rows for a user whose updated_at is strictly newer than `since` — used by the
// SSE stream to push incremental status changes.
export async function listUpdatedGenerations({ userId, since, limit = 100 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await query(
    `select ${SELECT_COLUMNS} from studio_generations
     where user_id = $1 and updated_at > $2
     order by updated_at asc
     limit $3`,
    [userId, since, safeLimit]
  );
  return result.rows.map(mapRow);
}

export async function updateGenerationResult(id, {
  status = 'succeeded',
  outputKey = null,
  outputType = null,
  outputMeta = null,
  providerRef = null,
  inputAssets,
}) {
  const sets = [
    'status = $2',
    'output_key = $3',
    'output_type = $4',
    'output_meta = $5::jsonb',
    'provider_ref = coalesce($6, provider_ref)',
    'updated_at = now()',
    'completed_at = now()',
  ];
  const values = [
    id,
    status,
    outputKey,
    outputType,
    outputMeta ? JSON.stringify(outputMeta) : null,
    providerRef,
  ];

  if (inputAssets !== undefined) {
    values.push(JSON.stringify(inputAssets || []));
    sets.push(`input_assets = $${values.length}::jsonb`);
  }

  const result = await query(
    `update studio_generations set ${sets.join(', ')}
     where id = $1
     returning ${SELECT_COLUMNS}`,
    values
  );
  return mapRow(result.rows[0]);
}

export async function markGenerationFailed(id, { error, status = 'failed', inputAssets } = {}) {
  const sets = [
    'status = $2',
    'error = $3',
    'updated_at = now()',
    'completed_at = now()',
  ];
  const values = [id, status, error ? String(error).slice(0, 2000) : null];

  if (inputAssets !== undefined) {
    values.push(JSON.stringify(inputAssets || []));
    sets.push(`input_assets = $${values.length}::jsonb`);
  }

  const result = await query(
    `update studio_generations set ${sets.join(', ')}
     where id = $1
     returning ${SELECT_COLUMNS}`,
    values
  );
  return mapRow(result.rows[0]);
}

export async function setProviderRef(id, providerRef) {
  await query(
    `update studio_generations set provider_ref = $2, updated_at = now() where id = $1`,
    [id, providerRef]
  );
}

export async function deleteGeneration(id, userId) {
  const result = await query(
    `delete from studio_generations where id = $1 and user_id = $2 returning ${SELECT_COLUMNS}`,
    [id, userId]
  );
  return mapRow(result.rows[0]);
}

// Atomically claim a batch of pending rows for a worker using SKIP LOCKED so
// multiple workers/instances never process the same row. Claimed rows get a
// sentinel provider_ref so they are not re-claimed while processing.
export async function claimPendingGenerations(limit = 4, claimToken = 'processing') {
  const result = await query(
    `update studio_generations
       set provider_ref = $2, updated_at = now()
     where id in (
       select id from studio_generations
       where status = 'generating' and provider_ref is null
       order by created_at asc
       for update skip locked
       limit $1
     )
     returning ${SELECT_COLUMNS}`,
    [limit, claimToken]
  );
  return result.rows.map(mapRow);
}

// Atomically claim a single row by id. Returns the row if this caller won the
// claim, otherwise null (already claimed / not pending).
export async function claimGeneration(id, claimToken = 'processing') {
  const result = await query(
    `update studio_generations
       set provider_ref = $2, updated_at = now()
     where id = $1 and status = 'generating' and provider_ref is null
     returning ${SELECT_COLUMNS}`,
    [id, claimToken]
  );
  return mapRow(result.rows[0]);
}

