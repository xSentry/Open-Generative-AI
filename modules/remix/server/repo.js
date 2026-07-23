import { query } from '../../db/server/db.js';
import { RemixError } from '../contracts.js';

const PROJECT_COLUMNS = `
  p.id, p.user_id, p.name, p.source_asset_id, p.active_video_version_id,
  p.status, p.error, p.created_at, p.updated_at
`;

export async function createProject({ userId, name }) {
  const result = await query(
    `insert into remix_projects (user_id, name) values ($1, $2)
     returning id, user_id, name, source_asset_id, active_video_version_id,
       status, error, created_at, updated_at`,
    [userId, name],
  );
  return result.rows[0];
}

export async function listProjects(userId, limit = 20) {
  const result = await query(
    `select ${PROJECT_COLUMNS},
       (select a.object_key from remix_video_versions v
        join remix_assets a on a.id = coalesce(v.thumbnail_asset_id, v.playback_asset_id, v.video_asset_id)
        where v.id = p.active_video_version_id) as preview_object_key
     from remix_projects p where p.user_id = $1
     order by p.updated_at desc limit $2`,
    [userId, Math.min(50, Math.max(1, Number(limit) || 20))],
  );
  return result.rows;
}

export async function requireProject(projectId, userId) {
  const result = await query(
    `select ${PROJECT_COLUMNS} from remix_projects p where p.id = $1 and p.user_id = $2`,
    [projectId, userId],
  );
  if (!result.rows[0]) throw new RemixError('remix_project_not_found', 'Remix project not found.', 404);
  return result.rows[0];
}

export async function updateProject(projectId, fields) {
  const allowed = new Map([
    ['name', 'name'], ['sourceAssetId', 'source_asset_id'],
    ['activeVideoVersionId', 'active_video_version_id'], ['status', 'status'], ['error', 'error'],
  ]);
  const sets = [];
  const values = [projectId];
  for (const [key, column] of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return null;
  const result = await query(
    `update remix_projects set ${sets.join(', ')}, updated_at = now()
     where id = $1 returning *`,
    values,
  );
  return result.rows[0] || null;
}

export async function createAsset(input) {
  const result = await query(
    `insert into remix_assets
      (project_id, user_id, kind, object_key, content_type, size_bytes, width, height,
       duration_seconds, fps, sha256, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning *`,
    [
      input.projectId, input.userId, input.kind, input.objectKey, input.contentType || null,
      input.sizeBytes ?? null, input.width ?? null, input.height ?? null,
      input.durationSeconds ?? null, input.fps ?? null, input.sha256 || null,
      input.metadata || {},
    ],
  );
  return result.rows[0];
}

export async function requireAsset(assetId, projectId, userId, kinds = null) {
  const result = await query(
    `select * from remix_assets where id = $1 and project_id = $2 and user_id = $3`,
    [assetId, projectId, userId],
  );
  const asset = result.rows[0];
  if (!asset || (kinds && !kinds.includes(asset.kind))) {
    throw new RemixError('remix_asset_not_found', 'Remix asset not found.', 404);
  }
  return asset;
}

export async function findCachedFrame({ projectId, videoAssetId, timestampSeconds }) {
  const result = await query(
    `select * from remix_assets
     where project_id = $1 and kind = 'frame'
       and metadata->>'videoAssetId' = $2
       and abs((metadata->>'actualTimestampSeconds')::numeric - $3::numeric) < 0.0005
     order by created_at desc limit 1`,
    [projectId, videoAssetId, timestampSeconds],
  );
  return result.rows[0] || null;
}

export async function createOriginalVersion({ projectId, assetId, playbackAssetId, metadata }) {
  const result = await query(
    `insert into remix_video_versions
      (project_id, video_asset_id, playback_asset_id, scope, status, metadata, completed_at)
     values ($1,$2,$3,'original','succeeded',$4,now()) returning *`,
    [projectId, assetId, playbackAssetId || null, metadata || {}],
  );
  return result.rows[0];
}

export async function createVideoVersion(input) {
  const result = await query(
    `insert into remix_video_versions
      (project_id, parent_version_id, video_asset_id, frame_edit_id, scope,
       selected_timestamp_seconds, range_start_seconds, range_end_seconds,
       provider, model, prompt, params, frame_edit_snapshot, status, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning *`,
    [
      input.projectId, input.parentVersionId, input.videoAssetId, input.frameEditId,
      input.scope, input.selectedTimestampSeconds, input.rangeStartSeconds,
      input.rangeEndSeconds, input.provider, input.model, input.prompt,
      input.params || {}, input.frameEditSnapshot || {}, input.status || 'queued',
      input.metadata || {},
    ],
  );
  return result.rows[0];
}

export async function requireVideoVersion(versionId, projectId) {
  const result = await query(
    `select v.*, a.object_key, a.content_type, a.size_bytes, a.width, a.height,
       a.duration_seconds, a.fps, p.object_key as playback_object_key,
       t.object_key as thumbnail_object_key
     from remix_video_versions v
     left join remix_assets a on a.id = v.video_asset_id
     left join remix_assets p on p.id = v.playback_asset_id
     left join remix_assets t on t.id = v.thumbnail_asset_id
     where v.id = $1 and v.project_id = $2`,
    [versionId, projectId],
  );
  if (!result.rows[0]) throw new RemixError('remix_video_version_not_found', 'Video version not found.', 404);
  return result.rows[0];
}

export async function updateVideoVersion(versionId, fields) {
  const allowed = new Map([
    ['videoAssetId', 'video_asset_id'], ['playbackAssetId', 'playback_asset_id'],
    ['thumbnailAssetId', 'thumbnail_asset_id'], ['status', 'status'],
    ['error', 'error'], ['metadata', 'metadata'], ['completedAt', 'completed_at'],
  ]);
  const sets = [];
  const values = [versionId];
  for (const [key, column] of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  const result = await query(
    `update remix_video_versions set ${sets.join(', ')} where id = $1 returning *`,
    values,
  );
  return result.rows[0] || null;
}

export async function createFrameEdit(input) {
  const result = await query(
    `insert into remix_frame_edits
      (project_id, source_video_version_id, source_frame_asset_id,
       requested_timestamp_seconds, actual_timestamp_seconds, provider, model,
       mode, prompt, params, reference_asset_ids)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [
      input.projectId, input.sourceVideoVersionId, input.sourceFrameAssetId,
      input.requestedTimestampSeconds, input.actualTimestampSeconds, input.provider,
      input.model, input.mode, input.prompt, input.params || {},
      input.referenceAssetIds || [],
    ],
  );
  return result.rows[0];
}

export async function requireFrameEdit(frameEditId, projectId) {
  const result = await query(
    `select f.*, o.object_key as output_object_key, s.object_key as source_object_key
     from remix_frame_edits f
     join remix_assets s on s.id = f.source_frame_asset_id
     left join remix_assets o on o.id = f.output_asset_id
     where f.id = $1 and f.project_id = $2`,
    [frameEditId, projectId],
  );
  if (!result.rows[0]) throw new RemixError('remix_frame_edit_not_found', 'Frame edit not found.', 404);
  return result.rows[0];
}

export async function updateFrameEdit(frameEditId, fields) {
  const allowed = new Map([
    ['status', 'status'], ['error', 'error'], ['providerRef', 'provider_ref'],
    ['outputAssetId', 'output_asset_id'], ['completedAt', 'completed_at'],
  ]);
  const sets = [];
  const values = [frameEditId];
  for (const [key, column] of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  const result = await query(
    `update remix_frame_edits set ${sets.join(', ')} where id = $1 returning *`,
    values,
  );
  return result.rows[0] || null;
}

export async function createJob({ projectId, userId, type, subjectId, idempotencyKey }) {
  const result = await query(
    `insert into remix_jobs (project_id, user_id, type, subject_id, idempotency_key)
     values ($1,$2,$3,$4,$5)
     on conflict (user_id, type, idempotency_key)
     do update set idempotency_key = excluded.idempotency_key
     returning *`,
    [projectId, userId, type, subjectId || null, idempotencyKey || null],
  );
  return result.rows[0];
}

export async function updateJob(jobId, fields) {
  const allowed = new Map([
    ['status', 'status'], ['progress', 'progress'], ['stage', 'stage'],
    ['errorCode', 'error_code'], ['errorMessage', 'error_message'],
    ['startedAt', 'started_at'], ['completedAt', 'completed_at'],
  ]);
  const sets = [];
  const values = [jobId];
  for (const [key, column] of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  sets.push('attempt_count = attempt_count + 1');
  const result = await query(
    `update remix_jobs set ${sets.join(', ')} where id = $1 returning *`,
    values,
  );
  return result.rows[0] || null;
}

export async function requireJob(jobId, projectId, userId) {
  const result = await query(
    'select * from remix_jobs where id = $1 and project_id = $2 and user_id = $3',
    [jobId, projectId, userId],
  );
  if (!result.rows[0]) throw new RemixError('remix_job_not_found', 'Remix job not found.', 404);
  return result.rows[0];
}

export async function getProjectGraph(projectId, userId) {
  const project = await requireProject(projectId, userId);
  const [assets, versions, frameEdits, jobs] = await Promise.all([
    query(`select * from remix_assets where project_id = $1 order by created_at`, [projectId]),
    query(
      `select v.*, a.object_key, a.content_type, a.size_bytes, a.width, a.height,
         a.duration_seconds, a.fps, p.object_key as playback_object_key,
         t.object_key as thumbnail_object_key
       from remix_video_versions v left join remix_assets a on a.id = v.video_asset_id
       left join remix_assets p on p.id = v.playback_asset_id
       left join remix_assets t on t.id = v.thumbnail_asset_id
       where v.project_id = $1 order by v.created_at`,
      [projectId],
    ),
    query(
      `select f.*, o.object_key as output_object_key, s.object_key as source_object_key
       from remix_frame_edits f join remix_assets s on s.id = f.source_frame_asset_id
       left join remix_assets o on o.id = f.output_asset_id
       where f.project_id = $1 order by f.created_at desc`,
      [projectId],
    ),
    query(`select * from remix_jobs where project_id = $1 order by created_at desc limit 100`, [projectId]),
  ]);
  return { project, assets: assets.rows, videoVersions: versions.rows, frameEdits: frameEdits.rows, jobs: jobs.rows };
}

export async function deleteFrameEditRows(frameEditId, projectId) {
  const edit = await requireFrameEdit(frameEditId, projectId);
  await query('delete from remix_frame_edits where id = $1 and project_id = $2', [frameEditId, projectId]);
  if (edit.output_asset_id) await query('delete from remix_assets where id = $1', [edit.output_asset_id]);
  return edit;
}

export async function deleteVideoVersionRows(versionId, projectId) {
  const version = await requireVideoVersion(versionId, projectId);
  if (version.scope === 'original') {
    throw new RemixError('remix_original_immutable', 'The original version cannot be deleted.', 409);
  }
  const fallback = version.parent_version_id || (
    await query(`select id from remix_video_versions where project_id = $1 and scope = 'original' limit 1`, [projectId])
  ).rows[0]?.id;
  const dependentEdits = await query(
    `delete from remix_frame_edits
     where project_id = $1 and source_video_version_id = $2
     returning source_frame_asset_id, output_asset_id`,
    [projectId, versionId],
  );
  for (const row of dependentEdits.rows) {
    for (const assetId of [row.source_frame_asset_id, row.output_asset_id].filter(Boolean)) {
      await query('delete from remix_assets where id = $1', [assetId]);
    }
  }
  await query('update remix_projects set active_video_version_id = $2 where id = $1 and active_video_version_id = $3', [projectId, fallback, versionId]);
  await query('delete from remix_video_versions where id = $1 and project_id = $2', [versionId, projectId]);
  for (const assetId of [version.thumbnail_asset_id, version.playback_asset_id, version.video_asset_id].filter(Boolean)) {
    await query('delete from remix_assets where id = $1', [assetId]);
  }
  return { version, fallback };
}

export async function listVersionDependentObjectKeys(versionId, projectId) {
  const result = await query(
    `select distinct a.object_key
     from remix_frame_edits f
     join remix_assets a on a.id in (f.source_frame_asset_id, f.output_asset_id)
     where f.project_id = $1 and f.source_video_version_id = $2`,
    [projectId, versionId],
  );
  return result.rows.map((row) => row.object_key);
}

export async function listProjectObjectKeys(projectId) {
  const result = await query('select object_key from remix_assets where project_id = $1', [projectId]);
  return result.rows.map((row) => row.object_key);
}

export async function deleteProjectRow(projectId, userId) {
  const result = await query(
    'delete from remix_projects where id = $1 and user_id = $2 returning *',
    [projectId, userId],
  );
  return result.rows[0] || null;
}
