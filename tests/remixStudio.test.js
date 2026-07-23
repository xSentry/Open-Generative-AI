import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALEPH_MAX_SECONDS,
  ALEPH_MIN_SECONDS,
  createRemixObjectKey,
  planEditScope,
  requireReplicateUser,
} from '../modules/remix/contracts.js';
import {
  buildImageEditParams,
  getEligibleImageModels,
} from '../modules/remix/server/modelCatalog.js';
import {
  buildRemixVideoParams,
  listRemixVideoModels,
  resolveRemixVideoModel,
} from '../modules/remix/server/videoModelRegistry.js';
import {
  createInternalPresignedGetUrl,
  createPresignedGetUrl,
} from '../modules/storage/server/s3.js';
import { mergeRemixProjectPatch } from '../packages/studio/src/remixEvents.js';

test('Remix is gated to the selected Replicate provider', () => {
  assert.equal(requireReplicateUser({ preferredProvider: 'replicate' }), 'replicate');
  assert.throws(
    () => requireReplicateUser({ preferredProvider: 'muapi' }),
    (error) => error.code === 'remix_provider_unsupported' && error.status === 403,
  );
});

test('Remix object keys are isolated by user and project', () => {
  const key = createRemixObjectKey({
    userId: 'user-a',
    projectId: 'project-b',
    kind: 'source_video',
    filename: '../../my unsafe video.mp4',
  });
  assert.match(key, /^remix\/user-a\/project-b\/source_video\/[^/]+-my-unsafe-video\.mp4$/);
  assert.doesNotMatch(key, /\.\.\//);
});

test('worker S3 reads ignore the external public base URL', () => {
  const config = {
    endpoint: 'http://minio:9000',
    publicBaseUrl: 'https://assets.example.test',
    bucket: 'media',
    region: 'us-east-1',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    forcePathStyle: true,
    signedUrlTtlSeconds: 60,
  };
  const args = { config, key: 'remix/user/project/source/video.mp4', date: new Date('2026-01-02T03:04:05Z') };
  assert.equal(new URL(createPresignedGetUrl(args)).host, 'assets.example.test');
  assert.equal(new URL(createInternalPresignedGetUrl(args)).host, 'minio:9000');
});

test('scope planning maps whole-video, from-frame, and selected-section keyframes', () => {
  assert.deepEqual(planEditScope({
    scope: 'whole',
    durationSeconds: 10,
    selectedTimeSeconds: 3.25,
  }), {
    scope: 'whole',
    segmentStartSeconds: 0,
    segmentDurationSeconds: 10,
    keyframePosition: '3.25',
    rangeStartSeconds: 0,
    rangeEndSeconds: 10,
  });

  assert.deepEqual(planEditScope({
    scope: 'from-frame',
    durationSeconds: 10,
    selectedTimeSeconds: 3.25,
  }), {
    scope: 'from-frame',
    segmentStartSeconds: 3.25,
    segmentDurationSeconds: 6.75,
    keyframePosition: 'first',
    rangeStartSeconds: 3.25,
    rangeEndSeconds: 10,
  });
  assert.deepEqual(planEditScope({
    scope: 'range',
    durationSeconds: 10,
    selectedTimeSeconds: 3.25,
    rangeEndSeconds: 7.5,
  }), {
    scope: 'range',
    segmentStartSeconds: 3.25,
    segmentDurationSeconds: 4.25,
    keyframePosition: 'first',
    rangeStartSeconds: 3.25,
    rangeEndSeconds: 7.5,
  });
});

test('scope planning enforces the current Aleph duration contract', () => {
  assert.equal(ALEPH_MIN_SECONDS, 2);
  assert.equal(ALEPH_MAX_SECONDS, 30);
  assert.throws(
    () => planEditScope({ scope: 'from-frame', durationSeconds: 5, selectedTimeSeconds: 4 }),
    (error) => error.code === 'remix_video_duration_unsupported',
  );
  assert.throws(
    () => planEditScope({ scope: 'whole', durationSeconds: 31, selectedTimeSeconds: 2 }),
    (error) => error.code === 'remix_video_duration_unsupported',
  );
  assert.throws(
    () => planEditScope({
      scope: 'range',
      durationSeconds: 20,
      selectedTimeSeconds: 5,
      rangeEndSeconds: 6,
    }),
    (error) => error.code === 'remix_video_duration_unsupported',
  );
});

test('Replicate image-edit model discovery is capability driven and de-duplicated', async () => {
  const models = await getEligibleImageModels('replicate');
  assert.ok(models.length > 0);
  assert.equal(new Set(models.map((model) => model.replicate?.ref || model.id)).size, models.length);
  for (const model of models) {
    assert.equal(model.provider, 'replicate');
    assert.equal(model.outputKind, 'image');
    assert.equal(model.acceptsInputImages, true);
    assert.ok(model.inputs[model.promptField]);
    assert.ok(model.inputs[model.mediaField]);
    assert.ok(
      model.inputs[model.mediaField].mediaKind === 'image'
      || model.inputs[model.mediaField].field === 'image'
      || model.inputs[model.mediaField].field === 'images_list',
    );
    assert.ok(model.maxImages >= 1);
  }
});

test('image parameter mapping preserves dynamic options and enforces reference capacity', () => {
  const model = {
    id: 'edit',
    inputs: {
      instruction: { type: 'string' },
      init_images: { type: 'array', mediaKind: 'image', field: 'images_list', maxItems: 2 },
    },
    required: ['init_images'],
    promptField: 'instruction',
    mediaField: 'init_images',
    maxImages: 2,
    mediaMapping: { multiple: true },
  };
  assert.deepEqual(buildImageEditParams({
    model,
    prompt: 'Make the sky green',
    imageInputs: { init_images: ['https://assets.test/frame.png', 'https://assets.test/reference.png'] },
    params: { seed: 42 },
  }), {
    seed: 42,
    instruction: 'Make the sky green',
    init_images: ['https://assets.test/frame.png', 'https://assets.test/reference.png'],
  });
  assert.throws(
    () => buildImageEditParams({
      model,
      prompt: 'x',
      imageInputs: { init_images: ['1', '2', '3'] },
    }),
    (error) => error.code === 'remix_image_capacity_exceeded',
  );
});

test('image parameter mapping targets each catalog image field independently', () => {
  const model = {
    id: 'multi-input-edit',
    inputs: {
      prompt: { type: 'string' },
      image: { type: 'string', mediaKind: 'image', field: 'image' },
      mask: { type: 'string', mediaKind: 'image', field: 'image' },
      seed: { type: 'integer' },
    },
    required: ['image'],
    promptField: 'prompt',
    mediaField: 'image',
  };
  assert.deepEqual(buildImageEditParams({
    model,
    prompt: 'Replace the subject',
    imageInputs: {
      image: ['https://assets.test/frame.png'],
      mask: ['https://assets.test/mask.png'],
    },
    params: { image: 'stale', mask: 'stale', seed: 7 },
  }), {
    prompt: 'Replace the subject',
    image: 'https://assets.test/frame.png',
    mask: 'https://assets.test/mask.png',
    seed: 7,
  });
  assert.throws(
    () => buildImageEditParams({
      model,
      prompt: 'x',
      imageInputs: { mask: ['https://assets.test/mask.png'] },
    }),
    (error) => error.code === 'remix_image_input_required',
  );
});

test('Aleph registry resolves against the checked-in catalog and exposes only optional controls', async () => {
  const resolved = await resolveRemixVideoModel('aleph-2');
  assert.equal(resolved.provider, 'replicate');
  assert.equal(resolved.mode, 'v2v');
  assert.equal(resolved.model.outputKind, 'video');
  assert.deepEqual(Object.keys(resolved.optionalInputs), ['seed']);
  const models = await listRemixVideoModels();
  assert.deepEqual(models[0], {
    key: 'aleph-2',
    label: 'Aleph 2.0',
    provider: 'replicate',
    mode: 'v2v',
    model: 'aleph-2',
    inputs: resolved.optionalInputs,
    segment: { minSeconds: 2, maxSeconds: 30 },
  });
});

test('Kling Omni registry maps Remix edits to its base-video contract', async () => {
  const resolved = await resolveRemixVideoModel('kling-v3-omni-video');
  assert.equal(resolved.provider, 'replicate');
  assert.equal(resolved.mode, 'v2v');
  assert.deepEqual(Object.keys(resolved.optionalInputs), ['keep_original_sound', 'mode']);
  assert.deepEqual(resolved.optionalInputs.mode.enum, ['standard', 'pro']);
  assert.deepEqual(resolved.segment, { minSeconds: 3, maxSeconds: 10 });

  assert.deepEqual(buildRemixVideoParams({
    resolved,
    prompt: 'Make the jacket red.',
    videoUrl: 'https://assets.test/source.mp4',
    keyframeUrl: 'https://assets.test/frame.webp',
    keyframePosition: 'first',
    params: {
      mode: 'pro',
      video_reference_type: 'feature',
      generate_audio: true,
      aspect_ratio: '1:1',
    },
  }), {
    mode: 'pro',
    video_reference_type: 'base',
    generate_audio: false,
    prompt: 'Make the jacket red. Use <<<image_1>>> as the visual reference for the edit.',
    reference_video: 'https://assets.test/source.mp4',
    reference_images: ['https://assets.test/frame.webp'],
  });

  const models = await listRemixVideoModels();
  assert.deepEqual(models.map((model) => model.key), ['aleph-2', 'kling-v3-omni-video']);
});

test('targeted Remix generation patches preserve the active video identity', () => {
  const activeVideo = { id: 'video-original', status: 'succeeded', url: 'https://assets.test/original.mp4' };
  const graph = {
    project: { id: 'project-a', active_video_version_id: activeVideo.id },
    jobs: [{ id: 'job-frame', status: 'queued' }],
    frameEdits: [{ id: 'frame-edit', status: 'queued' }],
    videoVersions: [activeVideo],
  };
  const next = mergeRemixProjectPatch(graph, {
    job: { id: 'job-frame', status: 'active' },
    frameEdit: { id: 'frame-edit', status: 'processing' },
  });

  assert.strictEqual(next.project, graph.project);
  assert.strictEqual(next.videoVersions, graph.videoVersions);
  assert.strictEqual(next.videoVersions[0], activeVideo);
  assert.equal(next.frameEdits[0].status, 'processing');
});

test('a completed Remix video patch switches the active video once', () => {
  const graph = {
    project: { id: 'project-a', active_video_version_id: 'video-original' },
    jobs: [{ id: 'job-video', status: 'active' }],
    frameEdits: [],
    videoVersions: [{ id: 'video-original', url: 'https://assets.test/original.mp4' }],
  };
  const next = mergeRemixProjectPatch(graph, {
    project: { id: 'project-a', active_video_version_id: 'video-generated' },
    job: { id: 'job-video', status: 'succeeded' },
    videoVersion: {
      id: 'video-generated',
      status: 'succeeded',
      url: 'https://assets.test/generated.mp4',
    },
  });

  assert.equal(next.project.active_video_version_id, 'video-generated');
  assert.equal(next.videoVersions.length, 2);
  assert.equal(next.videoVersions[1].url, 'https://assets.test/generated.mp4');
});
