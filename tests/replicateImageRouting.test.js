import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInput, runReplicatePrediction } from '../modules/providers/replicate/server/run.js';

// A Seedance-like model: a single first-frame `image`, a `last_frame_image`
// (swap) and a `reference_images` array (found via its mediaKind/field hints).
const seedance = {
  imageField: 'image',
  swapField: 'last_frame_image',
  videoField: 'reference_videos',
  audioField: 'reference_audios',
  inputs: {
    prompt: { type: 'string' },
    image: { type: 'string', mediaKind: 'image', field: 'image' },
    last_frame_image: { type: 'string', mediaKind: 'image', field: 'image' },
    reference_images: { type: 'array', mediaKind: 'image', field: 'images_list', items: { type: 'string' } },
    reference_videos: { type: 'array', mediaKind: 'video', field: 'videos_list', items: { type: 'string' } },
    reference_audios: { type: 'array', mediaKind: 'audio', field: 'audios_list', items: { type: 'string' } },
  },
};

// A nano-banana-like model whose primary image field is itself an array.
const nanoBanana = {
  imageField: 'image_input',
  inputs: {
    prompt: { type: 'string' },
    image_input: { type: 'array', mediaKind: 'image', field: 'images_list', items: { type: 'string' } },
  },
};

test('a single image goes to the single image field, not reference images', () => {
  const input = buildInput(seedance, { prompt: 'p', image_url: 'u1' });
  assert.equal(input.image, 'u1');
  assert.equal(input.reference_images, undefined);
});

test('two or more images go to the reference-images array, leaving the single slot empty', () => {
  const input = buildInput(seedance, { images_list: ['u1', 'u2', 'u3'] });
  assert.deepEqual(input.reference_images, ['u1', 'u2', 'u3']);
  assert.equal(input.image, undefined);
});

test('images from the single handle and the list handle are pooled by total count', () => {
  // 1 via image_url + 1 via images_list = 2 total -> reference images.
  const input = buildInput(seedance, { image_url: 'u1', images_list: ['u2'] });
  assert.deepEqual(input.reference_images, ['u1', 'u2']);
  assert.equal(input.image, undefined);
});

test('a single image provided via images_list still uses the single image field', () => {
  const input = buildInput(seedance, { images_list: ['only'] });
  assert.equal(input.image, 'only');
  assert.equal(input.reference_images, undefined);
});

test('duplicate image urls are de-duplicated before routing', () => {
  const input = buildInput(seedance, { image_url: 'same', images_list: ['same'] });
  // One unique image -> single field.
  assert.equal(input.image, 'same');
  assert.equal(input.reference_images, undefined);
});

test('models whose primary image field is an array receive the whole list', () => {
  assert.deepEqual(buildInput(nanoBanana, { images_list: ['a', 'b'] }).image_input, ['a', 'b']);
  assert.deepEqual(buildInput(nanoBanana, { image_url: 'a' }).image_input, ['a']);
});

test('non-image params pass through unchanged', () => {
  const input = buildInput(seedance, { prompt: 'hello', image_url: 'u1' });
  assert.equal(input.prompt, 'hello');
});

test('Replicate string-array iterator outputs are returned as concatenated text', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({
      id: 'prediction-1',
      status: 'succeeded',
      output: ['Hello', ', ', 'world'],
      urls: { get: 'https://api.replicate.com/v1/predictions/prediction-1' },
    });
  };

  try {
    const result = await runReplicatePrediction({
      apiKey: 'r8_test',
      model: {
        id: 'llm',
        replicate: { version: 'version-1' },
        inputs: { prompt: { type: 'string' } },
      },
      params: { prompt: 'Say hello' },
    });

    assert.equal(result.text, 'Hello, world');
    assert.deepEqual(result.outputs, []);
    assert.equal(result.url, null);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
