import assert from 'node:assert/strict';
import test from 'node:test';

import { createOutputObjectKey, deleteObject } from '../modules/storage/server/s3.js';
import { inferExtension, mediaTypeForMode } from '../modules/studio/server/generationMedia.js';
import { storeGenerationOutputs, cleanupGenerationInputs } from '../modules/studio/server/processGeneration.js';
import {
  handleDeleteGenerationRequest,
  handleGenerationsStreamRequest,
  handleListGenerationsRequest,
  serializeGeneration,
} from '../modules/studio/server/apiHandlers.js';
import { runWorkerOnce } from '../modules/studio/server/worker.js';

async function readJson(response) {
  return JSON.parse(await response.text());
}

function errorResponse(error) {
  return error.status
    ? { body: { error: error.code || 'error', message: error.message }, status: error.status }
    : { body: { error: 'server_error', message: 'Unexpected.' }, status: 500 };
}

test('mediaTypeForMode maps modes to coarse media types', () => {
  assert.equal(mediaTypeForMode('t2i'), 'image');
  assert.equal(mediaTypeForMode('i2v'), 'video');
  assert.equal(mediaTypeForMode('audio'), 'audio');
  assert.equal(mediaTypeForMode('t2t'), 'text');
  assert.equal(mediaTypeForMode('unknown'), 'image');
});

test('inferExtension derives extension from url, content-type, then media type', () => {
  assert.equal(inferExtension({ url: 'https://x/y/out.PNG?sig=1' }), 'png');
  assert.equal(inferExtension({ contentType: 'video/mp4' }), 'mp4');
  assert.equal(inferExtension({ mediaType: 'audio' }), 'mp3');
  assert.equal(inferExtension({}), 'bin');
});

test('createOutputObjectKey produces the studio-outputs key shape', () => {
  const key = createOutputObjectKey({
    userId: 'user-1',
    generationId: 'gen-9',
    ext: 'png',
    date: new Date('2026-07-04T00:00:00Z'),
  });
  assert.equal(key, 'studio-outputs/user-1/2026/07/04/gen-9.png');
});

test('deleteObject signs a DELETE and treats 404 as success', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: url.toString(), method: options.method, headers: options.headers });
    return { ok: false, status: 404, text: async () => 'gone' };
  };
  try {
    const result = await deleteObject({
      config: {
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        bucket: 'bucket',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        forcePathStyle: true,
      },
      key: 'studio-outputs/user-1/x.png',
    });
    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'DELETE');
    assert.match(calls[0].headers.Authorization, /AWS4-HMAC-SHA256/);
  } finally {
    global.fetch = originalFetch;
  }
});

function makeStoreDeps() {
  const uploaded = [];
  const deleted = [];
  const created = [];
  const updated = [];
  const failed = [];
  return {
    state: { uploaded, deleted, created, updated, failed },
    deps: {
      getS3Config: () => ({ bucket: 'b' }),
      createOutputObjectKey: ({ generationId, ext }) => `studio-outputs/${generationId}.${ext}`,
      uploadObject: async ({ key, contentType }) => {
        uploaded.push({ key, contentType });
      },
      deleteObject: async ({ key }) => {
        deleted.push(key);
      },
      fetchFn: async (url) => ({
        ok: true,
        status: 200,
        headers: { get: () => (url.includes('.mp4') ? 'video/mp4' : 'image/png') },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
      createGeneration: async (row) => {
        const created0 = { ...row, id: `sibling-${created.length + 1}` };
        created.push(created0);
        return created0;
      },
      updateGenerationResult: async (id, patch) => {
        const row = {
          id,
          status: patch.status,
          outputKey: patch.outputKey,
          outputType: patch.outputType,
          outputMeta: patch.outputMeta,
          inputAssets: patch.inputAssets,
        };
        updated.push(row);
        return row;
      },
      markGenerationFailed: async (id, patch) => {
        const row = { id, status: patch.status || 'failed', error: patch.error };
        failed.push(row);
        return row;
      },
    },
  };
}

test('storeGenerationOutputs stores primary, fans out extras, and deletes inputs', async () => {
  const { state, deps } = makeStoreDeps();
  const generation = {
    id: 'gen-1',
    userId: 'user-1',
    mode: 't2i',
    mediaType: 'image',
    provider: 'replicate',
    model: 'flux',
    prompt: 'hi',
    params: {},
    inputAssets: [{ key: 'studio-uploads/user-1/a.png', deleted: false }],
  };
  const result = await storeGenerationOutputs({
    generation,
    providerResult: { outputs: ['https://cdn/a.png', 'https://cdn/b.png'], replicateId: 'rep-1' },
    deps,
    env: { STUDIO_DELETE_INPUTS_AFTER_GENERATION: 'true' },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputKey, 'studio-outputs/gen-1.png');
  // Two uploads: primary + one sibling.
  assert.equal(state.uploaded.length, 2);
  assert.equal(state.created.length, 1);
  // Input deleted.
  assert.deepEqual(state.deleted, ['studio-uploads/user-1/a.png']);
  // Primary row input assets flagged deleted.
  assert.equal(result.inputAssets[0].deleted, true);
});

test('storeGenerationOutputs marks failed when provider returns no output', async () => {
  const { state, deps } = makeStoreDeps();
  const generation = { id: 'gen-2', userId: 'u', mediaType: 'image', inputAssets: [] };
  const result = await storeGenerationOutputs({ generation, providerResult: { outputs: [] }, deps, env: {} });
  assert.equal(result.status, 'failed');
  assert.equal(state.uploaded.length, 0);
});

test('storeGenerationOutputs stores text output metadata without downloading it', async () => {
  const { state, deps } = makeStoreDeps();
  const generation = { id: 'gen-text', userId: 'u', mediaType: 'text', inputAssets: [] };
  const result = await storeGenerationOutputs({
    generation,
    providerResult: { text: 'Hello from t2t', replicateId: 'rep-text' },
    deps,
    env: {},
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(state.uploaded.length, 0);
  assert.equal(state.updated[0].outputType, 'text/plain');
  assert.deepEqual(state.updated[0].outputMeta, { text: 'Hello from t2t' });
});

test('cleanupGenerationInputs respects STUDIO_DELETE_INPUTS_AFTER_GENERATION=false', async () => {
  const { state, deps } = makeStoreDeps();
  const generation = { inputAssets: [{ key: 'studio-uploads/x.png', deleted: false }] };
  const assets = await cleanupGenerationInputs({
    generation,
    config: {},
    deps,
    env: { STUDIO_DELETE_INPUTS_AFTER_GENERATION: 'false' },
  });
  assert.equal(state.deleted.length, 0);
  assert.equal(assets[0].deleted, false);
});

test('handleListGenerationsRequest returns the caller rows with signed urls', async () => {
  const response = await handleListGenerationsRequest(
    new Request('http://test.local/api/studio/generations?mediaType=image'),
    {
      errorResponse,
      requireUser: async () => ({ id: 'user-1' }),
      getS3Config: () => ({ bucket: 'b' }),
      createPresignedGetUrl: ({ key }) => `https://signed/${key}`,
      listGenerations: async ({ userId, mediaType }) => {
        assert.equal(userId, 'user-1');
        assert.equal(mediaType, 'image');
        return {
          items: [
            { id: 'g1', mode: 't2i', mediaType: 'image', status: 'succeeded', outputKey: 'studio-outputs/g1.png', createdAt: 'now' },
          ],
          nextCursor: null,
        };
      },
    }
  );
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.items[0].url, 'https://signed/studio-outputs/g1.png');
});

test('handleDeleteGenerationRequest removes row + output and 404s non-owner', async () => {
  const deletedKeys = [];
  const deps = {
    errorResponse,
    requireUser: async () => ({ id: 'user-1' }),
    getS3Config: () => ({ bucket: 'b' }),
    deleteObject: async ({ key }) => deletedKeys.push(key),
    getGeneration: async (id, userId) =>
      id === 'g1' && userId === 'user-1'
        ? { id: 'g1', outputKey: 'studio-outputs/g1.png', inputAssets: [] }
        : null,
    deleteGeneration: async () => ({ id: 'g1' }),
  };

  const ok = await handleDeleteGenerationRequest(new Request('http://test.local'), { id: 'g1', deps });
  assert.equal(ok.status, 200);
  assert.deepEqual(deletedKeys, ['studio-outputs/g1.png']);

  const notFound = await handleDeleteGenerationRequest(new Request('http://test.local'), { id: 'other', deps });
  assert.equal(notFound.status, 404);
});

test('serializeGeneration includes a signed url when output key present', () => {
  const item = serializeGeneration(
    { id: 'g', mode: 't2i', mediaType: 'image', status: 'succeeded', outputKey: 'k', createdAt: 't' },
    { getS3Config: () => ({}), createPresignedGetUrl: ({ key }) => `https://s/${key}` }
  );
  assert.equal(item.url, 'https://s/k');
});

test('handleGenerationsStreamRequest streams updated generations as SSE', async () => {
  let calls = 0;
  const response = await handleGenerationsStreamRequest(
    new Request('http://test.local/api/studio/generations/stream'),
    {
      errorResponse,
      requireUser: async () => ({ id: 'user-1' }),
      getS3Config: () => ({}),
      createPresignedGetUrl: ({ key }) => `https://s/${key}`,
      intervalMs: 10,
      heartbeatMs: 1000,
      listUpdatedGenerations: async ({ userId }) => {
        assert.equal(userId, 'user-1');
        calls += 1;
        if (calls === 1) {
          return [
            {
              id: 'g1',
              mode: 't2i',
              mediaType: 'image',
              status: 'succeeded',
              outputKey: 'k',
              createdAt: 'now',
              updatedAt: new Date().toISOString(),
            },
          ];
        }
        return [];
      },
    }
  );

  assert.equal(response.headers.get('content-type').startsWith('text/event-stream'), true);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (let i = 0; i < 20; i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    if (buf.includes('"id":"g1"')) break;
  }
  await reader.cancel();

  assert.match(buf, /data: /);
  assert.match(buf, /"url":"https:\/\/s\/k"/);
});

test('runWorkerOnce processes each claimed row without re-claiming', async () => {
  const processed = [];
  const rows = [
    { id: 'g1', userId: 'u', provider: 'replicate', mode: 't2i', mediaType: 'image', model: 'm', params: {}, inputAssets: [] },
  ];
  const count = await runWorkerOnce({
    env: { STUDIO_WORKER_CONCURRENCY: '2' },
    claimPendingGenerations: async () => rows,
    deps: {
      getS3Config: () => ({}),
      resolveProviderKey: async () => 'key',
      getReplicateStudioModel: () => ({ id: 'm' }),
      getStudioModel: () => null,
      runReplicatePrediction: async () => {
        processed.push('g1');
        return { outputs: [] };
      },
      createOutputObjectKey: () => 'k',
      uploadObject: async () => {},
      deleteObject: async () => {},
      fetchFn: async () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(0) }),
      updateGenerationResult: async (id, p) => ({ id, ...p }),
      markGenerationFailed: async (id, p) => ({ id, ...p }),
      createGeneration: async (r) => ({ ...r, id: 's' }),
    },
  });
  assert.equal(count, 1);
  assert.deepEqual(processed, ['g1']);
});

