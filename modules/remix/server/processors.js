import {
  createInternalPresignedGetUrl, createPresignedGetUrl, getS3Config, uploadObject,
} from '../../storage/server/s3.js';
import { requireProviderOperation } from '../../providers/server/registry.js';
import { getUserProviderCredential } from '../../providers/server/credentials.js';
import { createRemixObjectKey, planEditScope, RemixError } from '../contracts.js';
import {
  createAlephInput, createPlaybackProxy, createThumbnail, downloadToFile,
  extractExactFrame, normalizeGeneratedVideo, probeVideo, readMediaFile,
  spliceAndMux, withTempDir,
} from './mediaPipeline.js';
import {
  createAsset, createOriginalVersion, findCachedFrame, requireAsset,
  requireFrameEdit, requireProject, requireVideoVersion, updateFrameEdit,
  updateJob, updateProject, updateVideoVersion,
} from './repo.js';
import { buildImageEditParams, imageInputFields, requireEligibleImageModel } from './modelCatalog.js';
import { buildRemixVideoParams, resolveRemixVideoModel } from './videoModelRegistry.js';

function signedUrl(objectKey) {
  return createInternalPresignedGetUrl({ config: getS3Config(), key: objectKey });
}

function providerAssetUrl(objectKey) {
  const url = createPresignedGetUrl({ config: getS3Config(), key: objectKey });
  if (!/^https:\/\//i.test(url)) {
    throw new RemixError(
      'remix_public_storage_required',
      'Replicate needs a public HTTPS S3 URL. Configure S3_PUBLIC_BASE_URL before generating.',
      503,
    );
  }
  return url;
}

async function uploadFileAsset({ projectId, userId, kind, filePath, filename, contentType, metadata, media }) {
  const { body, sizeBytes } = await readMediaFile(filePath);
  const objectKey = createRemixObjectKey({ userId, projectId, kind, filename });
  await uploadObject({ config: getS3Config(), key: objectKey, body, contentType });
  return createAsset({
    projectId, userId, kind, objectKey, contentType, sizeBytes,
    width: media?.width, height: media?.height, durationSeconds: media?.durationSeconds,
    fps: media?.fps, metadata,
  });
}

function providerOutputUrl(result) {
  return result?.url || result?.outputs?.find((value) => /^https?:\/\//i.test(value));
}

async function failJob(job, error) {
  if (job?.id) {
    await updateJob(job.id, {
      status: 'failed', progress: 1, stage: 'failed',
      errorCode: error.code || 'remix_job_failed', errorMessage: error.message,
      completedAt: new Date(),
    }).catch(() => {});
  }
}

export async function processPrepareVideo({ projectId, userId, sourceAsset, job }) {
  try {
    await updateJob(job.id, { status: 'active', progress: 0.1, stage: 'probing', startedAt: new Date() });
    await updateProject(projectId, { status: 'preparing', error: null });
    return await withTempDir('remix-prepare-', async (dir) => {
      const sourcePath = `${dir}/source`;
      const proxyPath = `${dir}/playback.mp4`;
      await downloadToFile(signedUrl(sourceAsset.object_key), sourcePath);
      const sourceMedia = await probeVideo(sourcePath);
      if (sourceMedia.durationSeconds > 60 * 60) {
        throw new RemixError('remix_video_too_long', 'Remix Studio accepts videos up to one hour.', 422);
      }
      await updateJob(job.id, { status: 'active', progress: 0.4, stage: 'creating-playback-proxy' });
      const proxyMedia = await createPlaybackProxy(sourcePath, proxyPath);
      const playbackAsset = await uploadFileAsset({
        projectId, userId, kind: 'playback_proxy', filePath: proxyPath,
        filename: 'playback.mp4', contentType: 'video/mp4',
        metadata: { role: 'editor-playback', sourceAssetId: sourceAsset.id }, media: proxyMedia,
      });
      const version = await createOriginalVersion({
        projectId, assetId: sourceAsset.id, playbackAssetId: playbackAsset.id,
        metadata: { source: sourceMedia, playback: proxyMedia },
      });
      await updateProject(projectId, {
        sourceAssetId: sourceAsset.id, activeVideoVersionId: version.id, status: 'ready', error: null,
      });
      await updateJob(job.id, { status: 'succeeded', progress: 1, stage: 'ready', completedAt: new Date() });
      return version;
    });
  } catch (error) {
    await updateProject(projectId, { status: 'failed', error: error.message }).catch(() => {});
    await failJob(job, error);
    throw error;
  }
}

export async function processExtractFrame({ projectId, userId, videoVersionId, timestampSeconds, job }) {
  try {
    await updateJob(job.id, { status: 'active', progress: 0.2, stage: 'extracting-frame', startedAt: new Date() });
    const version = await requireVideoVersion(videoVersionId, projectId);
    const duration = Number(version.duration_seconds || version.metadata?.source?.durationSeconds);
    const fps = Number(version.fps || version.metadata?.source?.fps || 30);
    const requested = Math.min(Math.max(0, Number(timestampSeconds)), duration);
    const actual = Math.min(duration, Math.round(requested * fps) / fps);
    const cached = await findCachedFrame({ projectId, videoAssetId: version.video_asset_id, timestampSeconds: actual });
    if (cached) {
      await updateJob(job.id, { status: 'succeeded', progress: 1, stage: 'cached', completedAt: new Date() });
      return cached;
    }
    return await withTempDir('remix-frame-', async (dir) => {
      const videoPath = `${dir}/video.mp4`;
      const framePath = `${dir}/frame.png`;
      await downloadToFile(signedUrl(version.playback_object_key || version.object_key), videoPath);
      const extracted = await extractExactFrame(videoPath, framePath, actual, fps);
      const asset = await uploadFileAsset({
        projectId, userId, kind: 'frame', filePath: framePath, filename: 'frame.png',
        contentType: 'image/png',
        metadata: {
          videoAssetId: version.video_asset_id,
          videoVersionId, requestedTimestampSeconds: requested,
          actualTimestampSeconds: extracted.actualTimestampSeconds,
        },
      });
      await updateJob(job.id, { status: 'succeeded', progress: 1, stage: 'ready', completedAt: new Date() });
      return asset;
    });
  } catch (error) {
    await failJob(job, error);
    throw error;
  }
}

export async function processFrameEdit({ projectId, userId, frameEditId, job }) {
  try {
    await updateJob(job.id, { status: 'active', progress: 0.1, stage: 'validating', startedAt: new Date() });
    await updateFrameEdit(frameEditId, { status: 'processing', error: null });
    const edit = await requireFrameEdit(frameEditId, projectId);
    const model = await requireEligibleImageModel({ provider: edit.provider, mode: edit.mode, modelId: edit.model });
    const referenceIds = Array.isArray(edit.reference_asset_ids) ? edit.reference_asset_ids : [];
    const references = await Promise.all(referenceIds.map((id) =>
      requireAsset(id, projectId, userId, ['reference_image']),
    ));
    const referenceUrls = new Map(references.map((asset) => [asset.id, providerAssetUrl(asset.object_key)]));
    const frameUrl = providerAssetUrl(edit.source_object_key);
    const storedParams = edit.params || {};
    const { __remixImageAssignments: assignmentSpec, ...modelParams } = storedParams;
    const availableFields = imageInputFields(model);
    const imageInputs = {};
    if (assignmentSpec && typeof assignmentSpec === 'object') {
      for (const field of availableFields) {
        const tokens = Array.isArray(assignmentSpec[field.name]) ? assignmentSpec[field.name] : [];
        imageInputs[field.name] = tokens.map((token) => {
          if (token === 'frame') return frameUrl;
          if (typeof token === 'string' && token.startsWith('reference:')) {
            const url = referenceUrls.get(token.slice('reference:'.length));
            if (url) return url;
          }
          throw new RemixError('remix_image_assignment_invalid', 'An assigned reference image is no longer available.', 409);
        });
      }
    } else {
      imageInputs[model.mediaField] = [frameUrl, ...references.map((asset) => referenceUrls.get(asset.id))];
    }
    const providerParams = buildImageEditParams({
      model, prompt: edit.prompt, imageInputs, params: modelParams,
    });
    const apiKey = await getUserProviderCredential(userId, edit.provider);
    if (!apiKey) throw new RemixError('remix_provider_credential_missing', 'Add your Replicate API token in Settings.', 401);
    const adapter = requireProviderOperation(edit.provider, 'studio');
    await updateJob(job.id, { status: 'active', progress: 0.35, stage: 'editing-frame' });
    const result = await adapter.predictions.run({
      apiKey, model, mode: edit.mode, params: providerParams,
      onStarted: async ({ predictionId, providerRef }) => {
        await updateFrameEdit(frameEditId, { providerRef: providerRef || predictionId });
      },
    });
    const outputUrl = providerOutputUrl(result);
    if (!outputUrl) throw new RemixError('remix_provider_empty_output', 'The image model returned no image.', 502);
    return await withTempDir('remix-edit-frame-', async (dir) => {
      const outputPath = `${dir}/edited-frame`;
      await downloadToFile(outputUrl, outputPath);
      const asset = await uploadFileAsset({
        projectId, userId, kind: 'edited_frame', filePath: outputPath,
        filename: 'edited-frame.webp', contentType: 'image/webp',
        metadata: { frameEditId, provider: edit.provider, model: edit.model },
      });
      await updateFrameEdit(frameEditId, {
        status: 'succeeded', outputAssetId: asset.id, completedAt: new Date(),
        providerRef: result.providerRef || result.replicateId || edit.provider_ref,
      });
      await updateJob(job.id, { status: 'succeeded', progress: 1, stage: 'ready', completedAt: new Date() });
      return asset;
    });
  } catch (error) {
    await updateFrameEdit(frameEditId, { status: 'failed', error: error.message, completedAt: new Date() }).catch(() => {});
    await failJob(job, error);
    throw error;
  }
}

export async function processVideoEdit({ projectId, userId, versionId, job }) {
  try {
    await updateJob(job.id, { status: 'active', progress: 0.05, stage: 'validating', startedAt: new Date() });
    await updateVideoVersion(versionId, { status: 'processing', error: null });
    const queuedVersion = await requireVideoVersion(versionId, projectId);
    const source = await requireVideoVersion(queuedVersion.parent_version_id, projectId);
    const frameEdit = await requireFrameEdit(queuedVersion.frame_edit_id, projectId);
    if (frameEdit.status !== 'succeeded' || !frameEdit.output_object_key) {
      throw new RemixError('remix_frame_edit_not_ready', 'Select a completed frame edit before generating video.', 409);
    }
    const durationSeconds = Number(source.duration_seconds || source.metadata?.source?.durationSeconds);
    const width = Number(source.width || source.metadata?.source?.width);
    const height = Number(source.height || source.metadata?.source?.height);
    const fps = Number(source.fps || source.metadata?.source?.fps || 30);
    const resolved = await resolveRemixVideoModel(queuedVersion.model);
    const scopePlan = planEditScope({
      scope: queuedVersion.scope,
      durationSeconds,
      selectedTimeSeconds: Number(queuedVersion.selected_timestamp_seconds),
      rangeEndSeconds: Number(queuedVersion.range_end_seconds),
      minSegmentSeconds: resolved.segment.minSeconds,
      maxSegmentSeconds: resolved.segment.maxSeconds,
      modelLabel: resolved.label,
    });
    const apiKey = await getUserProviderCredential(userId, resolved.provider);
    if (!apiKey) throw new RemixError('remix_provider_credential_missing', 'Add your Replicate API token in Settings.', 401);
    return await withTempDir('remix-edit-video-', async (dir) => {
      const sourcePath = `${dir}/source.mp4`;
      const alephPath = `${dir}/aleph-input.mp4`;
      const generatedPath = `${dir}/generated.mp4`;
      const normalizedPath = `${dir}/normalized.mp4`;
      const finalPath = `${dir}/final.mp4`;
      const thumbnailPath = `${dir}/thumbnail.jpg`;
      await downloadToFile(signedUrl(source.object_key), sourcePath);
      await updateJob(job.id, { status: 'active', progress: 0.15, stage: 'preparing-aleph-input' });
      const alephMedia = await createAlephInput({
        inputPath: sourcePath, outputPath: alephPath,
        startSeconds: scopePlan.segmentStartSeconds,
        durationSeconds: scopePlan.segmentDurationSeconds, width, height, fps,
      });
      const alephAsset = await uploadFileAsset({
        projectId, userId, kind: 'playback_proxy', filePath: alephPath,
        filename: 'aleph-input.mp4', contentType: 'video/mp4',
        metadata: { role: 'aleph-input', versionId, sourceVersionId: source.id }, media: alephMedia,
      });
      const providerParams = buildRemixVideoParams({
        resolved,
        prompt: queuedVersion.prompt,
        videoUrl: providerAssetUrl(alephAsset.object_key),
        keyframeUrl: providerAssetUrl(frameEdit.output_object_key),
        keyframePosition: scopePlan.keyframePosition,
        params: queuedVersion.params,
      });
      await updateJob(job.id, { status: 'active', progress: 0.3, stage: 'generating-video' });
      const adapter = requireProviderOperation(resolved.provider, 'studio');
      const result = await adapter.predictions.run({
        apiKey, model: resolved.model, mode: resolved.mode, params: providerParams,
      });
      const outputUrl = providerOutputUrl(result);
      if (!outputUrl) throw new RemixError('remix_provider_empty_output', `${resolved.label} returned no video.`, 502);
      await downloadToFile(outputUrl, generatedPath);
      await updateJob(job.id, { status: 'active', progress: 0.75, stage: 'normalizing-and-splicing' });
      await normalizeGeneratedVideo({
        generatedPath, outputPath: normalizedPath, width, height, fps,
        durationSeconds: scopePlan.segmentDurationSeconds,
      });
      await spliceAndMux({
        sourcePath, generatedPath: normalizedPath, outputPath: finalPath,
        scope: queuedVersion.scope,
        selectedTimeSeconds: Number(queuedVersion.selected_timestamp_seconds),
        rangeEndSeconds: scopePlan.rangeEndSeconds,
        durationSeconds, fps,
      });
      const finalMedia = await probeVideo(finalPath);
      if (Math.abs(finalMedia.durationSeconds - durationSeconds) > 0.2) {
        throw new RemixError('remix_output_duration_mismatch', 'The generated video duration drifted too far to preserve audio sync.', 422);
      }
      await createThumbnail(finalPath, thumbnailPath);
      const [videoAsset, thumbnailAsset] = await Promise.all([
        uploadFileAsset({
          projectId, userId, kind: 'video_output', filePath: finalPath,
          filename: 'remix.mp4', contentType: 'video/mp4',
          metadata: { versionId, providerRef: result.providerRef || result.replicateId }, media: finalMedia,
        }),
        uploadFileAsset({
          projectId, userId, kind: 'thumbnail', filePath: thumbnailPath,
          filename: 'thumbnail.jpg', contentType: 'image/jpeg', metadata: { versionId },
        }),
      ]);
      await updateVideoVersion(versionId, {
        videoAssetId: videoAsset.id, playbackAssetId: videoAsset.id,
        thumbnailAssetId: thumbnailAsset.id, status: 'succeeded',
        completedAt: new Date(), metadata: {
          ...queuedVersion.metadata, providerRef: result.providerRef || result.replicateId,
          media: finalMedia, scopePlan,
        },
      });
      await updateProject(projectId, { activeVideoVersionId: versionId });
      await updateJob(job.id, { status: 'succeeded', progress: 1, stage: 'ready', completedAt: new Date() });
      return videoAsset;
    });
  } catch (error) {
    await updateVideoVersion(versionId, { status: 'failed', error: error.message, completedAt: new Date() }).catch(() => {});
    await failJob(job, error);
    throw error;
  }
}

export async function assertProjectOwnership(projectId, userId) {
  return requireProject(projectId, userId);
}
