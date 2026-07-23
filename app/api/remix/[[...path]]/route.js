import { NextResponse } from 'next/server';
import { requireUser } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';
import { getUserProviderCredential } from '@/modules/providers/server/credentials';
import { createPresignedGetUrl, deleteObject, getS3Config, uploadObject } from '@/modules/storage/server/s3';
import {
  MAX_SOURCE_BYTES, RemixError, createRemixObjectKey, numberInRange, planEditScope, requireReplicateUser,
} from '@/modules/remix/contracts';
import {
  createAsset, createFrameEdit, createJob, createProject, createVideoVersion,
  deleteFrameEditRows, deleteProjectRow, deleteVideoVersionRows, getProjectGraph,
  listProjectObjectKeys, listProjects, listVersionDependentObjectKeys, requireAsset, requireFrameEdit, requireJob, requireProject,
  requireVideoVersion, updateJob, updateProject,
} from '@/modules/remix/server/repo';
import { getEligibleImageModels } from '@/modules/remix/server/modelCatalog';
import { listRemixVideoModels, resolveRemixVideoModel } from '@/modules/remix/server/videoModelRegistry';
import {
  processExtractFrame, processFrameEdit, processPrepareVideo, processVideoEdit,
} from '@/modules/remix/server/processors';
import { enqueueRemixJob } from '@/modules/remix/server/jobQueue';

export const runtime = 'nodejs';

const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function json(data, status = 200) {
  return NextResponse.json(data, { status });
}

function pathParts(context) {
  return Promise.resolve(context.params).then((params) => params.path || []);
}

async function bodyJson(request) {
  return request.json().catch(() => {
    throw new RemixError('remix_invalid_json', 'A valid JSON body is required.');
  });
}

function signed(key) {
  return key ? createPresignedGetUrl({ config: getS3Config(), key }) : null;
}

function serializeVideoVersion(version) {
  if (!version) return null;
  return {
    ...version,
    url: signed(version.playback_object_key || version.object_key),
    downloadUrl: signed(version.object_key),
    thumbnailUrl: signed(version.thumbnail_object_key),
  };
}

function serializeFrameEdit(edit) {
  if (!edit) return null;
  return {
    ...edit,
    sourceUrl: signed(edit.source_object_key),
    outputUrl: signed(edit.output_object_key),
  };
}

async function dispatchRemixJob(data, inlineProcessor) {
  if (String(process.env.REMIX_ASYNC_JOBS || '').toLowerCase() === 'true') {
    await enqueueRemixJob(data);
    return;
  }
  void inlineProcessor().catch((error) => {
    console.error('Remix inline job failed', {
      jobId: data.jobId, projectId: data.projectId, type: data.type, error: error.message,
    });
  });
}

function serializeGraph(graph) {
  const assets = graph.assets.map((asset) => ({ ...asset, url: signed(asset.object_key) }));
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return {
    project: graph.project,
    assets,
    videoVersions: graph.videoVersions.map(serializeVideoVersion),
    frameEdits: graph.frameEdits.map((edit) => ({
      ...serializeFrameEdit(edit),
      outputAsset: byId.get(edit.output_asset_id) || null,
    })),
    jobs: graph.jobs,
  };
}

function respondError(error) {
  const normalized = error instanceof RemixError
    ? error
    : error;
  const response = errorResponse(normalized);
  return json(response.body, response.status);
}

async function authenticated(request) {
  const user = await requireUser(request);
  requireReplicateUser(user);
  return user;
}

async function uploadProjectAsset({ user, project, file, kind }) {
  const allowed = kind === 'source_video' ? VIDEO_TYPES : IMAGE_TYPES;
  if (!allowed.has(file.type)) {
    throw new RemixError(
      'remix_unsupported_media',
      kind === 'source_video' ? 'Choose an MP4, MOV, or WebM video.' : 'Choose a PNG, JPEG, or WebP image.',
      415,
    );
  }
  const maxBytes = kind === 'source_video' ? MAX_SOURCE_BYTES : 20 * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new RemixError('remix_upload_too_large', `This file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`, 413);
  }
  const objectKey = createRemixObjectKey({
    userId: user.id, projectId: project.id, kind, filename: file.name,
  });
  await uploadObject({
    config: getS3Config(), key: objectKey,
    body: Buffer.from(await file.arrayBuffer()), contentType: file.type,
  });
  return createAsset({
    projectId: project.id, userId: user.id, kind, objectKey,
    contentType: file.type, sizeBytes: file.size, metadata: { filename: file.name },
  });
}

export async function GET(request, context) {
  try {
    const user = await authenticated(request);
    const parts = await pathParts(context);
    if (parts[0] === 'models') {
      const [imageModels, videoModels, credential] = await Promise.all([
        getEligibleImageModels('replicate'),
        listRemixVideoModels(),
        getUserProviderCredential(user.id, 'replicate'),
      ]);
      return json({ provider: 'replicate', hasCredential: Boolean(credential), imageModels, videoModels });
    }
    if (parts[0] === 'projects' && !parts[1]) {
      const projects = await listProjects(user.id);
      return json({ projects: projects.map((project) => ({ ...project, previewUrl: signed(project.preview_object_key) })) });
    }
    if (parts[0] === 'projects' && parts[1] && parts[2] === 'jobs' && parts[3]) {
      let project = await requireProject(parts[1], user.id);
      const job = await requireJob(parts[3], project.id, user.id);
      const result = { job };
      if (job.type === 'edit-frame' && job.subject_id) {
        result.frameEdit = serializeFrameEdit(await requireFrameEdit(job.subject_id, project.id));
      } else if (job.type === 'edit-video' && job.subject_id) {
        result.videoVersion = serializeVideoVersion(await requireVideoVersion(job.subject_id, project.id));
        if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
          project = await requireProject(parts[1], user.id);
          result.project = project;
        }
      } else if (job.type === 'prepare-video') {
        project = await requireProject(parts[1], user.id);
        result.project = project;
        if (project.active_video_version_id) {
          result.videoVersion = serializeVideoVersion(
            await requireVideoVersion(project.active_video_version_id, project.id),
          );
        }
      }
      return json(result);
    }
    if (parts[0] === 'projects' && parts[1]) {
      return json(serializeGraph(await getProjectGraph(parts[1], user.id)));
    }
    throw new RemixError('remix_route_not_found', 'Remix endpoint not found.', 404);
  } catch (error) {
    return respondError(error);
  }
}

export async function POST(request, context) {
  try {
    const user = await authenticated(request);
    const parts = await pathParts(context);
    const idempotencyKey = request.headers.get('idempotency-key');

    if (parts[0] === 'projects' && !parts[1]) {
      const body = await bodyJson(request);
      const name = String(body.name || 'Untitled Remix').trim().slice(0, 120);
      return json({ project: await createProject({ userId: user.id, name }) }, 201);
    }

    if (parts[0] === 'projects' && parts[1] && parts[2] === 'assets') {
      const project = await requireProject(parts[1], user.id);
      const form = await request.formData();
      const file = form.get('file');
      const kind = form.get('kind') === 'reference_image' ? 'reference_image' : 'source_video';
      if (!(file instanceof File)) throw new RemixError('remix_file_required', 'Choose a file to upload.');
      if (kind === 'source_video' && project.source_asset_id) {
        throw new RemixError('remix_source_exists', 'This project already has an original video.', 409);
      }
      const asset = await uploadProjectAsset({ user, project, file, kind });
      if (kind === 'source_video') {
        await updateProject(project.id, { sourceAssetId: asset.id, status: 'preparing' });
        const job = await createJob({
          projectId: project.id, userId: user.id, type: 'prepare-video',
          subjectId: asset.id, idempotencyKey,
        });
        await dispatchRemixJob({
          jobId: job.id, projectId: project.id, userId: user.id,
          type: 'prepare-video', subjectId: asset.id,
        }, () => processPrepareVideo({ projectId: project.id, userId: user.id, sourceAsset: asset, job }));
        return json({ asset: { ...asset, url: signed(asset.object_key) }, job }, 202);
      }
      return json({ asset: { ...asset, url: signed(asset.object_key) } }, 201);
    }

    if (parts[0] === 'projects' && parts[1] && parts[2] === 'frames') {
      const project = await requireProject(parts[1], user.id);
      const body = await bodyJson(request);
      const version = await requireVideoVersion(body.videoVersionId, project.id);
      const duration = Number(version.duration_seconds || version.metadata?.source?.durationSeconds || 0);
      const timestampSeconds = numberInRange(body.timestampSeconds, 'Timestamp', 0, duration);
      const job = await createJob({
        projectId: project.id, userId: user.id, type: 'extract-frame',
        subjectId: version.id, idempotencyKey,
      });
      const asset = await processExtractFrame({
        projectId: project.id, userId: user.id, videoVersionId: version.id,
        timestampSeconds, job,
      });
      return json({ asset: { ...asset, url: signed(asset.object_key) }, job }, 201);
    }

    if (parts[0] === 'projects' && parts[1] && parts[2] === 'frame-edits') {
      const project = await requireProject(parts[1], user.id);
      const body = await bodyJson(request);
      const version = await requireVideoVersion(body.videoVersionId, project.id);
      const frame = await requireAsset(body.frameAssetId, project.id, user.id, ['frame']);
      const metadata = frame.metadata || {};
      if (metadata.videoVersionId !== version.id) {
        throw new RemixError('remix_frame_version_mismatch', 'The selected frame does not belong to this video version.', 409);
      }
      for (const referenceId of body.referenceAssetIds || []) {
        await requireAsset(referenceId, project.id, user.id, ['reference_image']);
      }
      const referenceIds = new Set(body.referenceAssetIds || []);
      const imageAssignments = body.imageAssignments && typeof body.imageAssignments === 'object'
        ? Object.fromEntries(Object.entries(body.imageAssignments).map(([field, tokens]) => {
          const safeTokens = Array.isArray(tokens) ? tokens.map(String) : [];
          for (const token of safeTokens) {
            if (token === 'frame') continue;
            if (!token.startsWith('reference:') || !referenceIds.has(token.slice('reference:'.length))) {
              throw new RemixError('remix_image_assignment_invalid', 'An image input contains an invalid project asset.', 422);
            }
          }
          return [field, safeTokens];
        }))
        : null;
      const frameAssignments = Object.values(imageAssignments || {}).flat().filter((token) => token === 'frame').length;
      if (imageAssignments && frameAssignments !== 1) {
        throw new RemixError('remix_frame_assignment_required', 'Assign the selected frame to exactly one image input.', 422);
      }
      const edit = await createFrameEdit({
        projectId: project.id, sourceVideoVersionId: version.id,
        sourceFrameAssetId: frame.id,
        requestedTimestampSeconds: Number(metadata.requestedTimestampSeconds),
        actualTimestampSeconds: Number(metadata.actualTimestampSeconds),
        provider: 'replicate', model: body.model, mode: body.mode,
        prompt: String(body.prompt || '').trim(),
        params: { ...(body.params || {}), __remixImageAssignments: imageAssignments },
        referenceAssetIds: body.referenceAssetIds || [],
      });
      const job = await createJob({
        projectId: project.id, userId: user.id, type: 'edit-frame',
        subjectId: edit.id, idempotencyKey,
      });
      await dispatchRemixJob({
        jobId: job.id, projectId: project.id, userId: user.id,
        type: 'edit-frame', subjectId: edit.id,
      }, () => processFrameEdit({ projectId: project.id, userId: user.id, frameEditId: edit.id, job }));
      return json({ frameEdit: edit, job }, 202);
    }

    if (parts[0] === 'projects' && parts[1] && parts[2] === 'video-edits') {
      const project = await requireProject(parts[1], user.id);
      const body = await bodyJson(request);
      if (body.sourceVideoVersionId !== project.active_video_version_id) {
        throw new RemixError('remix_active_version_changed', 'The active video changed. Review the edit and submit again.', 409);
      }
      const source = await requireVideoVersion(body.sourceVideoVersionId, project.id);
      const frameEdit = await requireFrameEdit(body.frameEditId, project.id);
      if (frameEdit.source_video_version_id !== source.id) {
        throw new RemixError('remix_frame_version_mismatch', 'This frame edit belongs to a different video version.', 409);
      }
      if (frameEdit.status !== 'succeeded') {
        throw new RemixError('remix_frame_edit_not_ready', 'Select a completed frame edit.', 409);
      }
      const resolved = await resolveRemixVideoModel(body.videoModelKey || 'aleph-2');
      const selectedTimestamp = Number(frameEdit.actual_timestamp_seconds);
      const sourceDuration = Number(source.duration_seconds || source.metadata?.source?.durationSeconds);
      const scopePlan = planEditScope({
        scope: body.scope,
        durationSeconds: sourceDuration,
        selectedTimeSeconds: selectedTimestamp,
        rangeEndSeconds: body.sectionEndSeconds,
        minSegmentSeconds: resolved.segment.minSeconds,
        maxSegmentSeconds: resolved.segment.maxSeconds,
        modelLabel: resolved.label,
      });
      const version = await createVideoVersion({
        projectId: project.id, parentVersionId: source.id, videoAssetId: null,
        frameEditId: frameEdit.id, scope: body.scope,
        selectedTimestampSeconds: selectedTimestamp,
        rangeStartSeconds: scopePlan.rangeStartSeconds,
        rangeEndSeconds: scopePlan.rangeEndSeconds,
        provider: resolved.provider, model: resolved.key,
        prompt: String(body.prompt || frameEdit.prompt || '').trim(),
        params: body.params || {}, status: 'queued',
        frameEditSnapshot: {
          id: frameEdit.id, timestampSeconds: selectedTimestamp,
          provider: frameEdit.provider, model: frameEdit.model,
          prompt: frameEdit.prompt, params: frameEdit.params,
        },
      });
      const job = await createJob({
        projectId: project.id, userId: user.id, type: 'edit-video',
        subjectId: version.id, idempotencyKey,
      });
      await dispatchRemixJob({
        jobId: job.id, projectId: project.id, userId: user.id,
        type: 'edit-video', subjectId: version.id,
      }, () => processVideoEdit({ projectId: project.id, userId: user.id, versionId: version.id, job }));
      return json({ videoVersion: version, job }, 202);
    }

    if (parts[0] === 'jobs' && parts[1] && parts[2] === 'cancel') {
      const body = await bodyJson(request).catch(() => ({}));
      if (!body.projectId) throw new RemixError('remix_project_required', 'projectId is required.');
      await requireProject(body.projectId, user.id);
      await requireJob(parts[1], body.projectId, user.id);
      const job = await updateJob(parts[1], {
        status: 'canceled', stage: 'canceled', completedAt: new Date(),
      });
      return json({ job });
    }
    throw new RemixError('remix_route_not_found', 'Remix endpoint not found.', 404);
  } catch (error) {
    return respondError(error);
  }
}

export async function PATCH(request, context) {
  try {
    const user = await authenticated(request);
    const parts = await pathParts(context);
    const body = await bodyJson(request);
    if (parts[0] === 'projects' && parts[1] && parts[2] === 'video-versions' && parts[3]) {
      const project = await requireProject(parts[1], user.id);
      const version = await requireVideoVersion(parts[3], project.id);
      if (body.active !== true || version.status !== 'succeeded') {
        throw new RemixError('remix_version_not_selectable', 'Only completed versions can be selected.', 409);
      }
      await updateProject(project.id, { activeVideoVersionId: version.id });
      return json({ activeVideoVersionId: version.id });
    }
    if (parts[0] === 'projects' && parts[1] && !parts[2]) {
      const project = await requireProject(parts[1], user.id);
      const name = String(body.name || '').trim();
      if (!name) throw new RemixError('remix_name_required', 'Project name is required.');
      return json({ project: await updateProject(project.id, { name: name.slice(0, 120) }) });
    }
    throw new RemixError('remix_route_not_found', 'Remix endpoint not found.', 404);
  } catch (error) {
    return respondError(error);
  }
}

export async function DELETE(request, context) {
  try {
    const user = await authenticated(request);
    const parts = await pathParts(context);
    if (parts[0] !== 'projects' || !parts[1]) throw new RemixError('remix_route_not_found', 'Remix endpoint not found.', 404);
    const project = await requireProject(parts[1], user.id);
    const config = getS3Config();

    if (parts[2] === 'frame-edits' && parts[3]) {
      const edit = await requireFrameEdit(parts[3], project.id);
      if (edit.output_object_key) await deleteObject({ config, key: edit.output_object_key });
      await deleteFrameEditRows(edit.id, project.id);
      return json({ deleted: true });
    }

    if (parts[2] === 'video-versions' && parts[3]) {
      const version = await requireVideoVersion(parts[3], project.id);
      const dependentKeys = await listVersionDependentObjectKeys(version.id, project.id);
      for (const key of [...new Set([version.thumbnail_object_key, version.playback_object_key, version.object_key, ...dependentKeys].filter(Boolean))]) {
        await deleteObject({ config, key });
      }
      const result = await deleteVideoVersionRows(version.id, project.id);
      return json({ deleted: true, activeVideoVersionId: result.fallback });
    }

    if (!parts[2]) {
      await updateProject(project.id, { status: 'deleting' });
      const keys = await listProjectObjectKeys(project.id);
      for (const key of keys) await deleteObject({ config, key });
      await deleteProjectRow(project.id, user.id);
      return json({ deleted: true });
    }
    throw new RemixError('remix_route_not_found', 'Remix endpoint not found.', 404);
  } catch (error) {
    return respondError(error);
  }
}
