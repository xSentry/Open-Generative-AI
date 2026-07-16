import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allReplicateModels,
  findReplicateModelByEndpoint,
  getReplicateStudioModel,
  getReplicateUnavailableCounts,
  replicateModelsByMode,
  getSerializableReplicateModelLists,
} from '../modules/providers/replicate/server/catalog.js';
import {
  buildInput,
  runReplicatePrediction,
} from '../modules/providers/replicate/server/run.js';
import {
  createObjectKey,
  createPresignedGetUrl,
  signS3Request,
} from '../modules/storage/server/s3.js';

const seedanceLikeModel = {
  id: 'seedance-like',
  imageField: 'image',
  swapField: 'last_frame_image',
  videoField: 'reference_videos',
  audioField: 'reference_audios',
  inputs: {
    prompt: { type: 'string' },
    aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] },
    image: { type: 'string', mediaKind: 'image' },
    last_frame_image: { type: 'string', mediaKind: 'image' },
    reference_images: { type: 'array', mediaKind: 'image', items: { type: 'string' } },
    reference_videos: { type: 'array', mediaKind: 'video', items: { type: 'string' } },
    reference_audios: { type: 'array', mediaKind: 'audio', items: { type: 'string' } },
  },
};

test('Replicate buildInput keeps declared params, coerces enums, and routes media fields', () => {
  const input = buildInput(seedanceLikeModel, {
    prompt: 'hello',
    aspect_ratio: '9:16',
    image_url: 'https://example.test/image.png',
    swap_url: 'https://example.test/end.png',
    video_url: 'https://example.test/video.mp4',
    audio_url: 'https://example.test/audio.wav',
    ignored: 'drop me',
  });

  assert.deepEqual(input, {
    prompt: 'hello',
    aspect_ratio: '9:16',
    image: 'https://example.test/image.png',
    last_frame_image: 'https://example.test/end.png',
    reference_videos: ['https://example.test/video.mp4'],
    reference_audios: ['https://example.test/audio.wav'],
  });
});

test('Replicate buildInput always omits output-token limit aliases and uses the provider default', () => {
  const model = {
    id: 'text-model',
    inputs: {
      prompt: { type: 'string' },
      max_output_tokens: { type: 'int', minValue: 1, default: 65535 },
      max_completion_tokens: { type: 'int' },
      max_tokens: { type: 'int' },
    },
  };

  assert.deepEqual(buildInput(model, { prompt: 'hello', max_output_tokens: 0 }), {
    prompt: 'hello',
  });
  assert.deepEqual(buildInput(model, {
    prompt: 'hello',
    max_output_tokens: 512,
    max_completion_tokens: 0,
    max_tokens: 0,
  }), {
    prompt: 'hello',
  });
});

test('AI Architect GPT-5.6 nodes omit legacy zero completion-token values', () => {
  const model = getReplicateStudioModel('t2t', 'gpt-5-6-luna');
  if (!model) return;

  const input = buildInput(model, {
    prompt: 'Refine this prompt',
    reasoning_effort: 'none',
    verbosity: 'medium',
    max_completion_tokens: 0,
  });

  assert.equal(input.prompt, 'Refine this prompt');
  assert.equal(input.max_completion_tokens, undefined);
});

test('Replicate buildInput routes multiple unique images to reference arrays', () => {
  const input = buildInput(seedanceLikeModel, {
    image_url: 'https://example.test/a.png',
    images_list: [
      'https://example.test/a.png',
      'https://example.test/b.png',
      'https://example.test/c.png',
    ],
  });

  assert.deepEqual(input.reference_images, [
    'https://example.test/a.png',
    'https://example.test/b.png',
    'https://example.test/c.png',
  ]);
  assert.equal(input.image, undefined);
});

test('Replicate buildInput sends all images when the primary image field is an array', () => {
  const input = buildInput(
    {
      id: 'array-image-model',
      imageField: 'image_input',
      inputs: {
        image_input: { type: 'array', mediaKind: 'image', items: { type: 'string' } },
      },
    },
    {
      image_url: 'https://example.test/a.png',
      images_list: ['https://example.test/b.png'],
    },
  );

  assert.deepEqual(input, {
    image_input: ['https://example.test/a.png', 'https://example.test/b.png'],
  });
});

test('Replicate catalog exposes generated models through the current lookup API', () => {
  const firstModel = allReplicateModels[0];
  assert.ok(firstModel, 'expected generated Replicate catalog to contain models');
  const firstMode = Object.entries(replicateModelsByMode)
    .find(([, models]) => models.some((model) => model.id === firstModel.id))?.[0];
  assert.ok(firstMode, 'expected first generated model to be present in a mode list');

  const byMode = getReplicateStudioModel(firstMode, firstModel.id);
  assert.equal(byMode?.id, firstModel.id);

  const byEndpoint = findReplicateModelByEndpoint(firstModel.endpoint || firstModel.id);
  assert.equal(byEndpoint?.mode, firstMode);
  assert.equal(byEndpoint?.model.id, firstModel.id);

  const serializable = getSerializableReplicateModelLists();
  assert.ok(Array.isArray(serializable[firstMode]));
  assert.deepEqual(getReplicateUnavailableCounts(), {});
});

test('Replicate runner posts predictions, polls, and normalizes URL outputs', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/predictions')) {
      return Response.json({
        id: 'pred-1',
        status: 'starting',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred-1' },
      });
    }
    return Response.json({
      id: 'pred-1',
      status: 'succeeded',
      output: ['https://example.test/out-1.png', 'https://example.test/out-2.png'],
    });
  };

  try {
    const result = await runReplicatePrediction({
      apiKey: 'r8_test',
      model: {
        id: 'test-model',
        replicate: { version: 'version-1' },
        inputs: { prompt: { type: 'string' } },
      },
      params: { prompt: 'hello', ignored: 'drop me' },
      maxAttempts: 2,
      interval: 0,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer r8_test');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      version: 'version-1',
      input: { prompt: 'hello' },
    });
    assert.deepEqual(result, {
      url: 'https://example.test/out-1.png',
      outputs: ['https://example.test/out-1.png', 'https://example.test/out-2.png'],
      text: null,
      status: 'succeeded',
      provider: 'replicate',
      model: 'test-model',
      replicateId: 'pred-1',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate runner normalizes text outputs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id: 'pred-text',
    status: 'succeeded',
    output: [{ text: 'hello ' }, { content: 'world' }],
  });

  try {
    const result = await runReplicatePrediction({
      apiKey: 'r8_test',
      model: {
        id: 'text-model',
        replicate: { version: 'version-1' },
        inputs: { prompt: { type: 'string' } },
      },
      params: { prompt: 'say hi' },
      maxAttempts: 1,
      interval: 0,
    });

    assert.equal(result.url, null);
    assert.deepEqual(result.outputs, []);
    assert.equal(result.text, 'hello world');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate runner injects recast task instructions only for recast mode', async () => {
  const originalFetch = globalThis.fetch;
  let postedBody;
  globalThis.fetch = async (url, options = {}) => {
    postedBody = JSON.parse(options.body);
    return Response.json({
      id: 'pred-recast',
      status: 'succeeded',
      output: 'https://example.test/out.mp4',
    });
  };

  try {
    await runReplicatePrediction({
      apiKey: 'r8_test',
      mode: 'recast',
      model: {
        id: 'recast-model',
        hasPrompt: true,
        replicate: { version: 'version-1' },
        inputs: { instruction_prompt: { type: 'string' } },
      },
      params: { instruction_prompt: 'use the person in red' },
      maxAttempts: 1,
      interval: 0,
    });

    assert.match(postedBody.input.instruction_prompt, /^Body swap task:/);
    assert.match(postedBody.input.instruction_prompt, /use the person in red/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate runner rejects models without a version id', async () => {
  await assert.rejects(
    () => runReplicatePrediction({
      apiKey: 'r8_test',
      model: { id: 'missing-version', inputs: {} },
      params: {},
    }),
    /missing a version id/,
  );
});

test('Replicate runner reports failed predictions and timeouts', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id: 'pred-failed',
    status: 'failed',
    error: 'bad input',
  });

  try {
    await assert.rejects(
      () => runReplicatePrediction({
        apiKey: 'r8_test',
        model: { id: 'fail-model', replicate: { version: 'version-1' }, inputs: {} },
        params: {},
        maxAttempts: 1,
        interval: 0,
      }),
      /bad input/,
    );

    globalThis.fetch = async () => Response.json({
      id: 'pred-processing',
      status: 'processing',
    });

    await assert.rejects(
      () => runReplicatePrediction({
        apiKey: 'r8_test',
        model: { id: 'slow-model', replicate: { version: 'version-1' }, inputs: {} },
        params: {},
        maxAttempts: 1,
        interval: 0,
      }),
      /timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('S3 upload helpers create safe object keys and signed URLs', () => {
  const key = createObjectKey({
    userId: 'user-1',
    filename: '../bad name.png',
    date: new Date('2026-07-02T12:00:00.000Z'),
  });

  assert.match(key, /^studio-uploads\/user-1\/2026\/07\/02\/[0-9a-f-]+-bad-name\.png$/);

  const config = {
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    bucket: 'aistudio',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    forcePathStyle: true,
    signedUrlTtlSeconds: 60,
  };

  const url = createPresignedGetUrl({
    config,
    key: 'studio-uploads/user-1/file.png',
    date: new Date('2026-07-02T12:00:00.000Z'),
  });

  assert.match(url, /^http:\/\/localhost:9000\/aistudio\/studio-uploads\/user-1\/file\.png\?/);
  assert.match(url, /X-Amz-Signature=/);

  const headers = signS3Request({
    method: 'PUT',
    url: new URL('http://localhost:9000/aistudio/studio-uploads/user-1/file.png'),
    region: 'us-east-1',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    payloadHash: 'abc123',
    headers: { 'content-type': 'image/png' },
    date: new Date('2026-07-02T12:00:00.000Z'),
  });

  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=minioadmin\/20260702\/us-east-1\/s3\/aws4_request/);
  assert.equal(headers['x-amz-date'], '20260702T120000Z');
});
