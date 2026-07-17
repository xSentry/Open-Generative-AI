import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleMuapiV1PostRequest,
  handleStudioGenerateRequest,
  handleStudioModelsRequest,
  handleStudioUploadDeleteRequest,
  handleStudioUploadRequest,
} from '../modules/studio/server/apiHandlers.js';

async function readJson(response) {
  return JSON.parse(await response.text());
}

function errorResponse(error) {
  if (error.status) {
    return {
      body: { error: { code: error.code || 'test_error', message: error.message } },
      status: error.status,
    };
  }

  return {
    body: { error: { code: 'server_error', message: 'Unexpected server error.' } },
    status: 500,
  };
}

test('/api/studio/models returns MuAPI catalog unchanged for MuAPI provider', async () => {
  const response = await handleStudioModelsRequest(new Request('http://test.local/api/studio/models'), {
    errorResponse,
    getActiveProviderKey: async () => ({ provider: 'muapi', apiKey: 'muapi-key' }),
    getReplicateUnavailableCounts: () => ({ t2i: 1 }),
    getSerializableReplicateModelLists: () => {
      throw new Error('Replicate catalog should not be read for MuAPI.');
    },
    getSerializableStudioModelLists: () => ({ t2i: [{ id: 'flux-schnell', endpoint: 'flux-schnell-image' }] }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    provider: 'muapi',
    models: { t2i: [{ id: 'flux-schnell', endpoint: 'flux-schnell-image' }] },
    unavailableCounts: {},
  });
});

test('/api/studio/models returns provider metadata for Replicate mappings', async () => {
  const response = await handleStudioModelsRequest(new Request('http://test.local/api/studio/models'), {
    errorResponse,
    getActiveProviderKey: async () => ({ provider: 'replicate', apiKey: 'r8_test' }),
    getReplicateUnavailableCounts: () => ({ i2i: 2 }),
    getSerializableReplicateModelLists: () => ({
      t2i: [{
        id: 'flux-schnell',
        name: 'Flux Schnell',
        endpoint: 'flux-schnell-image',
        provider: 'replicate',
        providerModel: 'black-forest-labs/flux-schnell',
        mappingStatus: 'supported',
        confidence: 0.95,
        unsupportedInputs: ['seed'],
      }],
    }),
    getSerializableStudioModelLists: () => {
      throw new Error('MuAPI catalog should not be read for Replicate.');
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    provider: 'replicate',
    models: {
      t2i: [{
        id: 'flux-schnell',
        name: 'Flux Schnell',
        endpoint: 'flux-schnell-image',
        provider: 'replicate',
        providerModel: 'black-forest-labs/flux-schnell',
        mappingStatus: 'supported',
        confidence: 0.95,
        unsupportedInputs: ['seed'],
      }],
    },
    unavailableCounts: { i2i: 2 },
  });
});

test('/api/studio/generate returns 401 when selected provider has no key', async () => {
  const response = await handleStudioGenerateRequest(
    new Request('http://test.local/api/studio/generate', {
      method: 'POST',
      body: JSON.stringify({ mode: 't2i', model: 'flux-schnell', params: {} }),
    }),
    {
      errorResponse,
      getActiveProviderKey: async () => ({ provider: 'replicate', apiKey: null }),
      getReplicateStudioModel: () => null,
      getProviderMissingKeyMessage: () => 'missing replicate',
      getStudioModel: () => null,
      runMuapiPrediction: async () => null,
      runReplicatePrediction: async () => null,
    }
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await readJson(response), {
    error: 'missing_provider_key',
    message: 'missing replicate',
  });
});

test('/api/studio/generate rejects unsupported Replicate mappings', async () => {
  const response = await handleStudioGenerateRequest(
    new Request('http://test.local/api/studio/generate', {
      method: 'POST',
      body: JSON.stringify({ mode: 't2i', model: 'bad-model', params: { prompt: 'x' } }),
    }),
    {
      errorResponse,
      getActiveProviderKey: async () => ({ provider: 'replicate', apiKey: 'r8_test' }),
      getReplicateStudioModel: () => null,
      getProviderMissingKeyMessage: () => 'missing',
      getStudioModel: () => ({ id: 'bad-model', endpoint: 'bad-model' }),
      runMuapiPrediction: async () => null,
      runReplicatePrediction: async () => {
        throw new Error('Unsupported mapping should not run.');
      },
    }
  );

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).error, 'unsupported_replicate_model');
});

test('/api/studio/generate routes supported Replicate generation server-side', async () => {
  let call;
  const response = await handleStudioGenerateRequest(
    new Request('http://test.local/api/studio/generate', {
      method: 'POST',
      body: JSON.stringify({ mode: 't2i', model: 'flux-schnell', params: { prompt: 'hello' } }),
    }),
    {
      errorResponse,
      getActiveProviderKey: async () => ({ provider: 'replicate', apiKey: 'r8_test' }),
      getReplicateStudioModel: () => ({ id: 'flux-schnell', endpoint: 'flux-schnell-image' }),
      getProviderMissingKeyMessage: () => 'missing',
      getStudioModel: () => ({ id: 'flux-schnell', endpoint: 'flux-schnell-image' }),
      runMuapiPrediction: async () => null,
      runReplicatePrediction: async (input) => {
        call = input;
        return { provider: 'replicate', url: 'https://example.test/out.png' };
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(call.apiKey, 'r8_test');
  assert.deepEqual(call.model, { id: 'flux-schnell', endpoint: 'flux-schnell-image' });
  assert.deepEqual(call.params, { prompt: 'hello' });
  assert.equal(call.mode, 't2i');
  assert.deepEqual(await readJson(response), {
    provider: 'replicate',
    model: 'flux-schnell',
    url: 'https://example.test/out.png',
  });
});

test('/api/studio/generate marks a persisted generation failed when the provider rejects it', async () => {
  let failed;
  const response = await handleStudioGenerateRequest(
    new Request('http://test.local/api/studio/generate', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'i2i',
        model: 'edit-model',
        params: {
          prompt: 'edit',
          images_list: ['https://bucket/studio-uploads/u/canvas.jpg'],
        },
      }),
    }),
    {
      errorResponse,
      getActiveProviderKey: async () => ({
        provider: 'replicate',
        apiKey: 'r8_test',
        user: { id: 'u' },
      }),
      getReplicateStudioModel: () => ({ id: 'edit-model' }),
      getProviderMissingKeyMessage: () => 'missing',
      createGeneration: async (generation) => ({
        ...generation,
        id: 'gen-draw',
        status: 'generating',
      }),
      mediaTypeForMode: () => 'image',
      runReplicatePrediction: async () => {
        throw new Error('provider failed');
      },
      failGeneration: async (input) => {
        failed = input;
      },
      env: { STUDIO_ASYNC_GENERATIONS: 'false' },
    },
  );

  assert.equal(response.status, 500);
  assert.equal(failed.generation.id, 'gen-draw');
  assert.equal(failed.generation.inputAssets[0].key, 'studio-uploads/u/canvas.jpg');
  assert.equal(failed.error.message, 'provider failed');
});

test('/api/studio/generate persists and returns the runtime estimate for async polling', async () => {
  const estimate = {
    seconds: 45,
    rangeSeconds: [40, 55],
    sampleCount: 4,
    confidence: 'medium',
    basis: 'model_exact_signature',
  };
  let created;
  const response = await handleStudioGenerateRequest(
    new Request('http://test.local/api/studio/generate', {
      method: 'POST',
      body: JSON.stringify({
        mode: 't2i',
        model: 'runtime-model',
        params: { width: 1024 },
      }),
    }),
    {
      errorResponse,
      getActiveProviderKey: async () => ({
        provider: 'replicate',
        apiKey: 'r8_test',
        user: { id: 'user-1' },
      }),
      getProviderMissingKeyMessage: () => 'missing',
      getReplicateStudioModel: () => ({
        id: 'runtime-model',
        inputs: { width: { type: 'integer' } },
      }),
      createRuntimeSignature: () => ({ version: 1, signature: {}, signatureHash: 'hash' }),
      estimatePredictionRuntime: async () => estimate,
      createGeneration: async (generation) => {
        created = generation;
        return { ...generation, id: 'generation-1', status: 'generating' };
      },
      mediaTypeForMode: () => 'image',
      enqueueGeneration: async () => {},
      env: {
        STUDIO_ASYNC_GENERATIONS: 'true',
      },
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(created.runtimeEstimate, estimate);
  assert.deepEqual((await readJson(response)).generations[0].runtimeEstimate, estimate);
});

test('/api/studio/generate returns typed Replicate parameter errors', async () => {
  const response = await handleStudioGenerateRequest(
    new Request('http://test.local/api/studio/generate', {
      method: 'POST',
      body: JSON.stringify({ mode: 't2i', model: 'flux-schnell', params: {} }),
    }),
    {
      errorResponse,
      getActiveProviderKey: async () => ({ provider: 'replicate', apiKey: 'r8_test' }),
      getReplicateStudioModel: () => ({ id: 'flux-schnell', endpoint: 'flux-schnell-image' }),
      getProviderMissingKeyMessage: () => 'missing',
      getStudioModel: () => ({ id: 'flux-schnell', endpoint: 'flux-schnell-image' }),
      runMuapiPrediction: async () => null,
      runReplicatePrediction: async () => {
        const error = new Error('Model "flux-schnell" cannot run on Replicate because required mapped input "prompt" is missing.');
        error.code = 'missing_replicate_input';
        error.status = 400;
        throw error;
      },
    }
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await readJson(response), {
    error: 'missing_replicate_input',
    message: 'Model "flux-schnell" cannot run on Replicate because required mapped input "prompt" is missing.',
  });
});

test('/api/studio/upload returns auth and validation errors', async () => {
  const unauthorized = await handleStudioUploadRequest(
    new Request('http://test.local/api/studio/upload', { method: 'POST', body: new FormData() }),
    {
      createObjectKey: () => 'key',
      errorResponse,
      getActiveProviderKey: async () => ({ provider: 'muapi' }),
      getS3Config: () => ({}),
      maxUploadBytes: 10,
      requireUser: async () => {
        const error = new Error('Authentication is required.');
        error.status = 401;
        error.code = 'unauthorized';
        throw error;
      },
      uploadObject: async () => null,
    }
  );

  assert.equal(unauthorized.status, 401);

  const invalid = await handleStudioUploadRequest(
    new Request('http://test.local/api/studio/upload', { method: 'POST', body: new FormData() }),
    {
      createObjectKey: () => 'key',
      errorResponse,
      getActiveProviderKey: async () => ({ provider: 'muapi' }),
      getS3Config: () => ({}),
      maxUploadBytes: 10,
      requireUser: async () => ({ id: 'user-1' }),
      uploadObject: async () => null,
    }
  );

  assert.equal(invalid.status, 400);
  assert.equal((await readJson(invalid)).error, 'invalid_file');
});

test('/api/studio/upload requires HTTPS-readable URLs for Replicate and returns uploaded URL on success', async () => {
  const formData = new FormData();
  formData.set('file', new Blob(['abc'], { type: 'text/plain' }), 'test.txt');

  const badConfig = await handleStudioUploadRequest(
    new Request('http://test.local/api/studio/upload', { method: 'POST', body: formData }),
    {
      createObjectKey: () => 'key',
      errorResponse,
      getActiveProviderKey: async () => ({ provider: 'replicate' }),
      getS3Config: () => ({ endpoint: 'http://localhost:9000' }),
      maxUploadBytes: 10,
      requireUser: async () => ({ id: 'user-1' }),
      uploadObject: async () => null,
    }
  );

  assert.equal(badConfig.status, 500);
  assert.equal((await readJson(badConfig)).error, 'upload_url_not_public');

  const successFormData = new FormData();
  successFormData.set('file', new Blob(['abc'], { type: 'text/plain' }), 'test.txt');
  const success = await handleStudioUploadRequest(
    new Request('http://test.local/api/studio/upload', { method: 'POST', body: successFormData }),
    {
      createObjectKey: ({ userId, filename }) => `studio-uploads/${userId}/${filename}`,
      errorResponse,
      getActiveProviderKey: async () => ({ provider: 'replicate' }),
      getS3Config: () => ({ endpoint: 'http://localhost:9000', publicBaseUrl: 'https://cdn.example.test' }),
      maxUploadBytes: 10,
      requireUser: async () => ({ id: 'user-1' }),
      uploadObject: async ({ key }) => `https://cdn.example.test/${key}`,
    }
  );

  assert.equal(success.status, 200);
  assert.deepEqual(await readJson(success), {
    url: 'https://cdn.example.test/studio-uploads/user-1/test.txt',
    file_url: 'https://cdn.example.test/studio-uploads/user-1/test.txt',
    key: 'studio-uploads/user-1/test.txt',
  });
});

test('/api/api/v1 compatibility bridge routes Replicate-supported Studio endpoints', async () => {
  let call;
  const response = await handleMuapiV1PostRequest(
    new Request('http://test.local/api/api/v1/flux-schnell-image', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'bridge' }),
    }),
    {
      path: 'flux-schnell-image',
      deps: {
        errorResponse,
        findReplicateModelByEndpoint: () => ({ mode: 't2i', model: { id: 'flux-schnell' } }),
        getActiveProviderKey: async () => ({ provider: 'replicate', apiKey: 'r8_test' }),
        getProviderMissingKeyMessage: () => 'missing',
        getRequestApiKey: () => null,
        proxyMuapiV1Request: async () => {
          throw new Error('MuAPI proxy should not run for supported Replicate endpoint.');
        },
        runReplicatePrediction: async (input) => {
          call = input;
          return { provider: 'replicate', url: 'https://example.test/out.png' };
        },
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(call.apiKey, 'r8_test');
  assert.deepEqual(call.model, { id: 'flux-schnell' });
  assert.deepEqual(call.params, { prompt: 'bridge' });
  assert.equal(call.mode, 't2i');
  assert.deepEqual(await readJson(response), {
    provider: 'replicate',
    model: 'flux-schnell',
    url: 'https://example.test/out.png',
  });
});

test('/api/studio/upload cleanup only deletes temporary inputs owned by the caller', async () => {
  const deleted = [];
  const response = await handleStudioUploadDeleteRequest(
    new Request('http://test.local/api/studio/upload', {
      method: 'DELETE',
      body: JSON.stringify({
        params: {
          images_list: [
            'https://cdn.example.test/studio-uploads/user-1/canvas.jpg',
            'https://cdn.example.test/studio-uploads/other-user/secret.jpg',
          ],
        },
      }),
    }),
    {
      deleteObject: async ({ key }) => deleted.push(key),
      errorResponse,
      getS3Config: () => ({ bucket: 'studio' }),
      requireUser: async () => ({ id: 'user-1' }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(deleted, ['studio-uploads/user-1/canvas.jpg']);
  assert.deepEqual(await readJson(response), { deleted: 1 });
});

test('/api/api/v1 compatibility bridge returns missing-key errors before MuAPI proxying', async () => {
  const response = await handleMuapiV1PostRequest(
    new Request('http://test.local/api/api/v1/flux-schnell-image', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'bridge' }),
    }),
    {
      path: 'flux-schnell-image',
      deps: {
        errorResponse,
        findReplicateModelByEndpoint: () => ({ mode: 't2i', model: { id: 'flux-schnell' } }),
        getActiveProviderKey: async () => ({ provider: 'muapi', apiKey: null }),
        getProviderMissingKeyMessage: () => 'missing muapi',
        getRequestApiKey: () => null,
        proxyMuapiV1Request: async () => {
          throw new Error('MuAPI proxy should not run without a selected MuAPI key.');
        },
        runReplicatePrediction: async () => null,
      },
    }
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await readJson(response), {
    error: 'missing_provider_key',
    message: 'missing muapi',
  });
});
