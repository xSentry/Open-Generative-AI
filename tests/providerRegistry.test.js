import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePredictionResult } from '../modules/providers/core/normalizeResult.js';
import { publicManifest } from '../modules/providers/core/publicManifest.js';
import { createPublicRegistry, listProviderManifests } from '../modules/providers/publicRegistry.js';
import { createServerRegistry } from '../modules/providers/server/registry.js';

const fakeManifest = publicManifest({
  id: 'fake',
  label: 'Fake',
  description: 'Test provider',
  credential: { label: 'Fake secret', placeholder: 'fake_', required: true },
  features: { studio: true, workflow: true, workflowArchitect: false, agents: false, designAgent: false, clipping: false, vibeMotion: false, apps: false },
  modes: ['t2i'],
});

const fakeModel = { id: 'fake-image-v1', name: 'Fake image', provider: 'fake', mode: 't2i', inputs: { prompt: { type: 'string' } }, required: ['prompt'] };
const fakeAdapter = {
  id: 'fake',
  credentials: { validate: async (secret) => secret.startsWith('fake_') },
  catalog: {
    getModelLists: async () => ({ t2i: [fakeModel] }),
    getModel: async (mode, id) => mode === 't2i' && id === fakeModel.id ? fakeModel : null,
    getModelById: async (id) => id === fakeModel.id ? fakeModel : null,
  },
  predictions: { run: async () => normalizePredictionResult('fake', { id: 'fake-job', output: 'https://fake.test/out.png' }) },
  transports: {},
};

test('public registry rejects duplicate and unknown provider ids without fallback', () => {
  assert.throws(() => createPublicRegistry([fakeManifest, fakeManifest]), /Duplicate provider/);
  const registry = createPublicRegistry([fakeManifest]);
  assert.equal(registry.getProviderManifest('replicate'), null);
  assert.throws(() => registry.requireProviderManifest('replicate'), (error) => error.code === 'unknown_provider');
});

test('server registry accepts a distinct fake adapter without application changes', async () => {
  const registry = createServerRegistry([fakeAdapter], { manifests: [fakeManifest] });
  const adapter = registry.requireProviderAdapter('fake');
  const model = await adapter.catalog.getModel('t2i', 'fake-image-v1');
  const result = await adapter.predictions.run({ apiKey: 'fake_secret', model, params: { prompt: 'x' } });
  assert.equal(result.provider, 'fake');
  assert.equal(result.providerRef, 'fake-job');
  assert.equal(result.url, 'https://fake.test/out.png');
  assert.throws(() => registry.requireProviderAdapter('replicate'), (error) => error.code === 'unknown_provider');
});

test('public manifests contain no adapters, secrets, or authorization headers', () => {
  const serialized = JSON.stringify(listProviderManifests()).toLowerCase();
  assert.doesNotMatch(serialized, /authorization|server\/adapter|api[_-]?key\s*:/);
  for (const manifest of listProviderManifests()) {
    assert.equal('adapter' in manifest, false);
    assert.equal('secret' in manifest.credential, false);
  }
});

test('prediction normalization covers url arrays, text, and empty output without raw data', () => {
  assert.deepEqual(normalizePredictionResult('fake', { id: '1', output: ['https://a.test/1.png', 'https://a.test/2.png'] }).outputs.length, 2);
  assert.equal(normalizePredictionResult('fake', { request_id: '2', output: 'hello' }).text, 'hello');
  const empty = normalizePredictionResult('fake', {});
  assert.equal(empty.url, null);
  assert.equal('raw' in empty, false);
});

