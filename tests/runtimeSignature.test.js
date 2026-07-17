import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeSignature, createRelaxedRuntimeSignature } from '../modules/providers/runtime/server/signature.js';

const model = { id: 'test-model', inputs: {
  prompt: { type: 'string', title: 'Prompt' }, width: { type: 'integer' }, steps: { type: 'integer' },
  quality: { type: 'string' }, image: { type: 'string', format: 'uri' }, seed: { type: 'integer' },
} };

test('runtime signature excludes user content and canonicalizes relevant settings', () => {
  const first = createRuntimeSignature({ model, params: { prompt: 'private words', image: 'https://example.test/a.png', seed: 1, width: '1023', steps: '20', quality: ' High ' } });
  const second = createRuntimeSignature({ model, params: { prompt: 'different words', image: 'https://elsewhere.test/b.png', seed: 999, width: 1024, steps: 20, quality: 'high' } });
  assert.deepEqual(first.signature, { fields: { quality: 'high', steps: 20, width: 1024 }, media: {} });
  assert.equal(first.signatureHash, second.signatureHash);
});

test('runtime signature buckets media metadata without retaining source URLs', () => {
  const signature = createRuntimeSignature({ model, params: {}, mediaMetadata: { source: { type: 'video', duration: 4.2, width: 1919, height: 1081, fps: 29.8, url: 'secret' } } });
  assert.equal(signature.signature.media.source.duration, 4);
  assert.equal(signature.signature.media.source.width, 1920);
  assert.equal(JSON.stringify(signature.signature).includes('secret'), false);
  assert.ok(createRelaxedRuntimeSignature(signature.signature).signatureHash);
});

test('runtime field overrides replace generic discovery and may explicitly include seed', () => {
  const signature = createRuntimeSignature({
    model: {
      ...model,
      runtimeFields: ['seed', 'quality'],
    },
    params: { width: 1024, steps: 20, quality: 'high', seed: 42 },
  });
  assert.deepEqual(signature.signature.fields, { quality: 'high', seed: 42 });
});

test('runtime signature keeps prefixed dimensions but always excludes raw media and user content', () => {
  const signature = createRuntimeSignature({
    model: {
      id: 'media-dimensions',
      inputs: {
        image_size: { type: 'string' },
        image_width: { type: 'integer' },
        video_fps: { type: 'number' },
        image: { type: 'string', format: 'uri', mediaKind: 'image' },
        text: { type: 'string', description: 'Text whose length and quality vary.' },
      },
    },
    params: {
      image_size: '1K',
      image_width: 1024,
      video_fps: 30,
      image: 'https://example.test/private.png',
      text: 'private content',
    },
  });
  assert.deepEqual(signature.signature.fields, {
    image_size: '1k',
    image_width: 1024,
    video_fps: 30,
  });
});
