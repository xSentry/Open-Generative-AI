import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalWorkflow } from '../modules/workflow/server/router.js';

// These tests exercise the "local engine" branch of the workflow dispatcher
// (provider !== 'muapi'). The MuAPI branch lives in the route handler and simply
// proxies, so here we verify the local execution contract the UI depends on.

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

test('POST {id}/run seeds one node-run per node and enqueues the run', async () => {
  const created = [];
  const enqueued = [];
  let createdRun = null;
  const deps = {
    getWorkflow: async () => ({
      id: 'wf-1',
      nodes: [{ id: 'text-1', model: 'text-passthrough' }, { id: 'img-1', model: 'flux' }],
      edges: [{ source: 'text-1', target: 'img-1' }],
    }),
    createRun: async (args) => {
      createdRun = args;
      return { id: 'run-1' };
    },
    createNodeRun: async ({ nodeId }) => {
      created.push(nodeId);
      return { id: `nr-${nodeId}` };
    },
    enqueueRun: async (runId) => {
      enqueued.push(runId);
    },
  };

  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { cost: 0 }),
    routeCtx(['wf-1', 'run']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { run_id: 'run-1' });
  assert.deepEqual(created, ['text-1', 'img-1']);
  assert.equal(createdRun.provider, 'replicate');
  assert.deepEqual(enqueued, ['run-1']);
});

test('GET run/{id}/status returns the MuAPI-compatible envelope', async () => {
  const deps = {
    getRun: async () => ({ id: 'run-1', status: 'running' }),
    listNodeRuns: async () => [
      { id: 'nr1', nodeId: 'img-1', status: 'succeeded', result: { id: 'r', outputs: [{ type: 'image_url', value: 'u', id: 'o' }] } },
    ],
  };

  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['run', 'run-1', 'status']),
    'GET',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, 'running');
  assert.equal(body.run_id, 'run-1');
  assert.ok(Array.isArray(body.nodes['img-1']));
  const latest = body.nodes['img-1'][0];
  assert.equal(latest.status, 'succeeded');
  assert.equal(latest.result.outputs[0].type, 'image_url');
  assert.equal(latest.result.outputs[0].value, 'u');
});

test('GET run/{id}/status re-signs stored S3 output keys when S3 is wired', async () => {
  const deps = {
    getRun: async () => ({ id: 'run-1', status: 'completed' }),
    listNodeRuns: async () => [
      { id: 'nr1', nodeId: 'img-1', status: 'succeeded', result: { id: 'r', outputs: [{ type: 'image_url', value: 'stale', key: 'workflow-outputs/u/w/r/nr1-0.png', id: 'o' }] } },
    ],
    getS3Config: () => ({ bucket: 'b' }),
    createPresignedGetUrl: ({ key }) => `https://cdn/${key}?sig=fresh`,
  };

  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['run', 'run-1', 'status']),
    'GET',
    ctxFor(),
    deps
  );

  const body = await readJson(response);
  assert.equal(body.nodes['img-1'][0].result.outputs[0].value, 'https://cdn/workflow-outputs/u/w/r/nr1-0.png?sig=fresh');
});

test('GET run/{id}/status returns 404 for an unknown run', async () => {
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['run', 'missing', 'status']),
    'GET',
    ctxFor(),
    { getRun: async () => null }
  );
  assert.equal(response.status, 404);
});

test('POST {id}/api-execute stores inputs on the run and enqueues it', async () => {
  let createdRun = null;
  const enqueued = [];
  const deps = {
    getWorkflow: async () => ({ id: 'wf-1', nodes: [{ id: 'text-1' }], edges: [] }),
    createRun: async (args) => { createdRun = args; return { id: 'run-9', inputs: args.inputs }; },
    createNodeRun: async ({ nodeId }) => ({ id: `nr-${nodeId}` }),
    enqueueRun: async (runId) => { enqueued.push(runId); },
  };

  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { inputs: { 'text-1': { prompt: 'hi' } } }),
    routeCtx(['wf-1', 'api-execute']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { run_id: 'run-9' });
  assert.deepEqual(createdRun.inputs, { 'text-1': { prompt: 'hi' } });
  assert.deepEqual(enqueued, ['run-9']);
});

test('GET run/{id}/api-outputs returns terminal outputs with run status', async () => {
  const deps = {
    getRun: async () => ({ id: 'run-1', status: 'completed', workflowId: 'wf-1' }),
    listNodeRuns: async () => [
      { nodeId: 'a', status: 'succeeded', result: { outputs: [{ type: 'text', value: 'A', id: '1' }] } },
      { nodeId: 'b', status: 'succeeded', result: { outputs: [{ type: 'image_url', value: 'B', id: '2' }] } },
    ],
    getWorkflow: async () => ({
      id: 'wf-1',
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
    }),
  };

  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['run', 'run-1', 'api-outputs']),
    'GET',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, 'completed');
  // Only terminal node b's output is exposed.
  assert.deepEqual(body.outputs, [{ type: 'image_url', value: 'B', id: '2' }]);
});

test('POST {id}/node/{nodeId}/run creates a targeted run and enqueues it', async () => {
  let createdRun = null;
  let nodeRunArgs = null;
  const enqueued = [];
  const deps = {
    getWorkflow: async () => ({ id: 'wf-1', nodes: [{ id: 'img-1', model: 'flux', params: {} }], edges: [] }),
    createRun: async (args) => { createdRun = args; return { id: 'run-node' }; },
    createNodeRun: async (args) => { nodeRunArgs = args; return { id: 'nr-new' }; },
    enqueueRun: async (runId) => { enqueued.push(runId); },
  };

  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {
      run_id: 'run-existing',
      model: 'flux',
      params: { prompt: 'p' },
      node_id: 'AI Image',
    }),
    routeCtx(['wf-1', 'node', 'img-1', 'run']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { run_id: 'run-node' });
  assert.equal(createdRun.targetNodeId, 'img-1');
  assert.equal(nodeRunArgs.nodeId, 'img-1');
  assert.deepEqual(nodeRunArgs.params, { prompt: 'p' });
  assert.deepEqual(enqueued, ['run-node']);
});

test('DELETE node-run/{id} reports deletion and 404 when missing', async () => {
  const deletedObjects = [];
  const ok = await handleLocalWorkflow(
    request(),
    routeCtx(['node-run', 'nr-1']),
    'DELETE',
    ctxFor(),
    {
      deleteNodeRun: async () => ({ id: 'nr-1', outputKeys: ['workflow-outputs/u/w/r/nr-1-0.png'] }),
      getS3Config: () => ({ bucket: 'b' }),
      deleteObject: async ({ key }) => { deletedObjects.push(key); },
    }
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await readJson(ok), { node_run_id: 'nr-1', deleted: true });
  // The stored media is purged from S3 on delete.
  assert.deepEqual(deletedObjects, ['workflow-outputs/u/w/r/nr-1-0.png']);

  const missing = await handleLocalWorkflow(
    request(),
    routeCtx(['node-run', 'nope']),
    'DELETE',
    ctxFor(),
    { deleteNodeRun: async () => null }
  );
  assert.equal(missing.status, 404);
});

test('DELETE delete-workflow-def/{id} purges stored S3 outputs', async () => {
  const deletedObjects = [];
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['delete-workflow-def', 'wf-1']),
    'DELETE',
    ctxFor(),
    {
      getWorkflowOutputKeys: async () => ['workflow-outputs/u/wf-1/a.png', 'workflow-outputs/u/wf-1/b.mp4'],
      deleteWorkflow: async (id) => ({ id }),
      getS3Config: () => ({ bucket: 'b' }),
      deleteObject: async ({ key }) => { deletedObjects.push(key); },
    }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { workflow_id: 'wf-1', deleted: true });
  assert.deepEqual(deletedObjects, ['workflow-outputs/u/wf-1/a.png', 'workflow-outputs/u/wf-1/b.mp4']);
});

test('POST {id}/thumbnail persists the provided cover URL', async () => {
  let saved = null;
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { thumbnail: 'https://img/cover.png' }),
    routeCtx(['wf-1', 'thumbnail']),
    'POST',
    ctxFor(),
    { setThumbnail: async (id, { thumbnailKey }) => { saved = { id, thumbnailKey }; return { id }; } }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { success: true });
  assert.deepEqual(saved, { id: 'wf-1', thumbnailKey: 'https://img/cover.png' });
});

