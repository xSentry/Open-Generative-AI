import assert from 'node:assert/strict';
import test from 'node:test';
import { minimaxManifest } from '../modules/providers/minimax/manifest.js';
import { minimaxAdapter } from '../modules/providers/minimax/server/adapter.js';
import { minimaxModelLists } from '../modules/providers/minimax/server/catalog.js';
import { buildMiniMaxRequest, runMiniMaxPrediction } from '../modules/providers/minimax/server/run.js';

test('MiniMax manifest and catalog expose every supported application modality', async () => {
  assert.deepEqual(minimaxManifest.modes, ['t2t', 't2i', 'i2i', 't2v', 'i2v', 'audio']);
  assert.ok(minimaxModelLists.t2t.some((model) => model.metadata.nativeId === 'MiniMax-M3'));
  assert.ok(minimaxModelLists.t2i.some((model) => model.metadata.operation === 'image-generation'));
  assert.ok(minimaxModelLists.i2v.some((model) => model.metadata.nativeId === 'S2V-01'));
  for (const operation of ['text-to-speech', 'voice-clone', 'voice-design', 'voice-list', 'voice-delete', 'music-generation']) {
    assert.ok(minimaxModelLists.audio.some((model) => model.metadata.operation === operation), `missing ${operation}`);
  }
  const lists = await minimaxAdapter.catalog.getModelLists();
  assert.ok(Object.values(lists).flat().length >= 30);
});

test('MiniMax request translation does not mutate generic params', () => {
  const params = Object.freeze({ prompt: 'hello', image_url: 'https://example.test/input.png', n: 2 });
  const request = buildMiniMaxRequest(minimaxModelLists.i2i[0], params);
  assert.equal(request.model, 'image-01');
  assert.equal(request.subject_reference[0].image_file, params.image_url);
  assert.equal(request.response_format, 'url');
  assert.deepEqual(params, { prompt: 'hello', image_url: 'https://example.test/input.png', n: 2 });
});

test('MiniMax text uses the Anthropic client and stores a provider-prefixed runtime id', async () => {
  const samples = [];
  const starts = [];
  const model = minimaxModelLists.t2t[0];
  const result = await runMiniMaxPrediction({
    apiKey: 'test-key', model, params: { prompt: 'hello' },
    anthropicFactory: () => ({ messages: { create: async (request) => ({
      id: 'msg_123', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: `reply:${request.messages[0].content[0].text}` }],
      usage: { input_tokens: 2, output_tokens: 3 },
    }) } }),
    onStarted: (start) => starts.push(start),
    saveRuntimeSampleFn: (sample) => samples.push(sample),
  });
  assert.equal(result.provider, 'minimax');
  assert.equal(result.providerRef, 'msg_123');
  assert.equal(result.text, 'reply:hello');
  assert.equal(result.text.includes('private'), false);
  assert.equal(samples[0].predictionId, 'minimax:msg_123');
  assert.equal(samples[0].provider, 'minimax');
  assert.equal(starts.length, 1);
});

test('MiniMax custom image endpoint normalizes URLs without returning raw payloads', async () => {
  const model = minimaxModelLists.t2i[0];
  const fetchFn = async () => new Response(JSON.stringify({
    id: 'image_123', data: { image_urls: ['https://cdn.example.test/out.png'] }, base_resp: { status_code: 0, status_msg: 'success' }, secret_internal: 'omit-me',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const result = await runMiniMaxPrediction({ apiKey: 'test-key', model, params: { prompt: 'x' }, fetchFn });
  assert.equal(result.url, 'https://cdn.example.test/out.png');
  assert.equal(result.providerRef, 'image_123');
  assert.equal(JSON.stringify(result).includes('omit-me'), false);
});
