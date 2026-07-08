import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalWorkflow } from '../modules/workflow/server/router.js';
import {
  buildArchitectMessages,
  parseWorkflowJson,
  normalizeWorkflowDef,
  buildCatalogSummary,
  generateWorkflowDef,
} from '../modules/workflow/server/architect.js';

function ctxFor(userId = 'user-1', provider = 'replicate') {
  return { user: { id: userId }, provider, apiKey: 'r8_test' };
}
function routeCtx(path) {
  return { params: Promise.resolve({ path }) };
}
function request(url = 'http://test.local/api/workflow', body) {
  return new Request(url, body ? { method: 'POST', body: JSON.stringify(body) } : {});
}
async function readJson(response) {
  return JSON.parse(await response.text());
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('buildCatalogSummary lists model ids per category', () => {
  const catalog = buildCatalogSummary('replicate', 3);
  for (const cat of ['text', 'image', 'video', 'audio', 'utility']) {
    assert.ok(Array.isArray(catalog[cat]), `missing category ${cat}`);
  }
  assert.ok(catalog.image.length <= 3);
  assert.ok(catalog.text.includes('text-passthrough'));
});

test('buildArchitectMessages includes system rules, history and the prompt', () => {
  const messages = buildArchitectMessages({
    prompt: 'make a cat video',
    history: [{ role: 'agent', content: 'hi' }, { role: 'user', content: 'earlier' }],
    catalog: { image: ['flux'] },
  });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /STRICT JSON/);
  // agent role is mapped to assistant.
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[messages.length - 1].content, 'make a cat video');
});

test('parseWorkflowJson tolerates code fences and surrounding prose', () => {
  const fenced = 'Here you go:\n```json\n{"message":"ok","workflow":{"nodes":[],"edges":[]}}\n```';
  const parsed = parseWorkflowJson(fenced);
  assert.equal(parsed.message, 'ok');
  assert.throws(() => parseWorkflowJson('no json here'), /not JSON/);
});

test('normalizeWorkflowDef fills defaults and drops dangling edges', () => {
  const normalized = normalizeWorkflowDef({
    message: 'done',
    suggestions: ['add audio', 42],
    workflow: {
      nodes: [
        { id: 'text1', category: 'text', input_params: { prompt: 'a cat' } },
        { id: 'img1', category: 'image', model: 'flux' },
        { category: 'video' }, // no id -> dropped
      ],
      edges: [
        { source: 'text1', target: 'img1' },
        { source: 'text1', target: 'ghost' }, // dangling -> dropped
      ],
    },
  });

  assert.equal(normalized.message, 'done');
  assert.deepEqual(normalized.suggestions, ['add audio']);
  assert.equal(normalized.workflow.nodes.length, 2);
  // Missing model defaults to a passthrough for its category.
  const text = normalized.workflow.nodes.find((n) => n.id === 'text1');
  assert.equal(text.model, 'text-passthrough');
  assert.ok(text.position && typeof text.position.x === 'number');
  // Only the valid edge survives.
  assert.deepEqual(
    normalized.workflow.edges.map((e) => `${e.source}->${e.target}`),
    ['text1->img1']
  );
});

test('generateWorkflowDef runs the injected LLM and normalizes its output', async () => {
  let seenMessages = null;
  const llm = async (messages) => {
    seenMessages = messages;
    return JSON.stringify({
      message: 'built',
      suggestions: [],
      workflow: { nodes: [{ id: 'a', category: 'text', input_params: { prompt: 'hi' } }], edges: [] },
    });
  };
  const result = await generateWorkflowDef({ prompt: 'hi', provider: 'replicate', llm });
  assert.equal(result.message, 'built');
  assert.equal(result.workflow.nodes[0].id, 'a');
  assert.ok(seenMessages, 'llm should be called');
});

test('POST architect persists the generated graph and returns request_id', async () => {
  const store = new Map();
  let generated = null;
  const deps = {
    createArchitectRequest: async () => ({ id: 'req-1' }),
    updateArchitectRequest: async (id, patch) => {
      store.set(id, patch);
      return { id, ...patch };
    },
    generateWorkflowDef: async ({ prompt }) => {
      generated = prompt;
      return { message: 'ok', suggestions: [], workflow: { nodes: [], edges: [] } };
    },
  };

  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { prompt: 'make art', history: [] }),
    routeCtx(['architect']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { request_id: 'req-1', status: 'processing' });
  assert.equal(generated, 'make art');
  await flush();
  assert.equal(store.get('req-1').status, 'completed');
});

test('POST architect marks the request failed when the LLM throws', async () => {
  const store = new Map();
  const deps = {
    createArchitectRequest: async () => ({ id: 'req-2' }),
    updateArchitectRequest: async (id, patch) => { store.set(id, patch); return { id }; },
    generateWorkflowDef: async () => { throw new Error('no LLM key'); },
  };

  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { prompt: 'x' }),
    routeCtx(['architect']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  await flush();
  assert.equal(store.get('req-2').status, 'failed');
  assert.match(store.get('req-2').error, /no LLM key/);
});

test('POST architect rejects an empty prompt', async () => {
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { prompt: '   ' }),
    routeCtx(['architect']),
    'POST',
    ctxFor()
  );
  assert.equal(response.status, 400);
});

test('GET poll-architect/{id}/result spreads the stored result with status', async () => {
  const deps = {
    getArchitectRequest: async () => ({
      id: 'req-1',
      status: 'completed',
      result: { message: 'done', suggestions: ['x'], workflow: { nodes: [], edges: [] } },
    }),
  };
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['poll-architect', 'req-1', 'result']),
    'GET',
    ctxFor(),
    deps
  );
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, 'completed');
  assert.equal(body.message, 'done');
  assert.ok(body.workflow);
});

test('GET poll-architect returns 404 for an unknown request', async () => {
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['poll-architect', 'missing', 'result']),
    'GET',
    ctxFor(),
    { getArchitectRequest: async () => null }
  );
  assert.equal(response.status, 404);
});

test('POST {id}/thumbnail persists the cover URL and returns success', async () => {
  let saved = null;
  const deps = {
    setThumbnail: async (id, { thumbnailKey }) => {
      saved = { id, thumbnailKey };
      return { id, thumbnailKey };
    },
  };
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { thumbnail: 'https://img/cover.png' }),
    routeCtx(['wf-1', 'thumbnail']),
    'POST',
    ctxFor(),
    deps
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { success: true });
  assert.deepEqual(saved, { id: 'wf-1', thumbnailKey: 'https://img/cover.png' });
});

test('POST {id}/thumbnail rejects a missing URL', async () => {
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {}),
    routeCtx(['wf-1', 'thumbnail']),
    'POST',
    ctxFor()
  );
  assert.equal(response.status, 400);
});

