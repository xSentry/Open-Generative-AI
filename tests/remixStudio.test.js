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
  listRemixVideoModels,
  resolveRemixVideoModel,
} from '../modules/remix/server/videoModelRegistry.js';
import {
  createInternalPresignedGetUrl,
  createPresignedGetUrl,
} from '../modules/storage/server/s3.js';

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

test('scope planning maps whole-video timestamps and from-frame first keyframes', () => {
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
  assert.deepEqual(await listRemixVideoModels(), [{
    key: 'aleph-2',
    label: 'Aleph 2.0',
    provider: 'replicate',
    mode: 'v2v',
    model: 'aleph-2',
    inputs: resolved.optionalInputs,
  }]);
});
