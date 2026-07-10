import assert from 'node:assert/strict';
import test from 'node:test';
import {
  storeNodeOutputs,
  signResultOutputs,
  collectResultKeys,
} from '../modules/workflow/server/outputStorage.js';
import { executeNode } from '../modules/workflow/server/nodeExecutors.js';
import { runClaimedRun, processRun } from '../modules/workflow/server/runProcessor.js';
import { runWorkerOnce } from '../modules/workflow/server/worker.js';

// A minimal fake fetch Response for downloading provider outputs.
function fakeResponse({ ok = true, contentType = 'image/png', bytes = 8 } = {}) {
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  };
}

// ---------------------------------------------------------------------------
// outputStorage
// ---------------------------------------------------------------------------

test('storeNodeOutputs mirrors media outputs into S3 and passes text through', async () => {
  const uploaded = [];
  const deps = {
    fetchFn: async () => fakeResponse({ contentType: 'video/mp4' }),
    createWorkflowOutputObjectKey: ({ nodeRunId, index, ext }) => `workflow-outputs/u/wf/run/${nodeRunId}-${index}.${ext}`,
    uploadObject: async ({ key }) => { uploaded.push(key); return `https://cdn/${key}?sig=1`; },
  };

  const { result, keys } = await storeNodeOutputs({
    result: {
      id: 'r',
      outputs: [
        { type: 'text', value: 'a caption', id: 't' },
        { type: 'video_url', value: 'https://provider/out.mp4', id: 'v' },
      ],
    },
    userId: 'u',
    workflowId: 'wf',
    runId: 'run',
    nodeRunId: 'nr1',
    config: { bucket: 'b' },
    deps,
  });

  // Text is untouched; media is stored and rewritten to our presigned URL + key.
  assert.equal(result.outputs[0].value, 'a caption');
  assert.equal(result.outputs[0].key, undefined);
  assert.equal(result.outputs[1].key, 'workflow-outputs/u/wf/run/nr1-0.mp4');
  assert.equal(result.outputs[1].value, 'https://cdn/workflow-outputs/u/wf/run/nr1-0.mp4?sig=1');
  assert.deepEqual(keys, ['workflow-outputs/u/wf/run/nr1-0.mp4']);
  assert.deepEqual(uploaded, ['workflow-outputs/u/wf/run/nr1-0.mp4']);
});

test('storeNodeOutputs keeps the provider URL when mirroring fails', async () => {
  const deps = {
    fetchFn: async () => fakeResponse({ ok: false }),
    createWorkflowOutputObjectKey: () => 'k',
    uploadObject: async () => 'never',
  };
  const { result, keys } = await storeNodeOutputs({
    result: { outputs: [{ type: 'image_url', value: 'https://provider/x.png', id: 'i' }] },
    userId: 'u', workflowId: 'wf', runId: 'run', nodeRunId: 'nr', config: {}, deps,
  });
  assert.equal(result.outputs[0].value, 'https://provider/x.png');
  assert.equal(result.outputs[0].key, undefined);
  assert.deepEqual(keys, []);
});

test('signResultOutputs refreshes values from stored keys only', () => {
  const signed = signResultOutputs(
    { outputs: [
      { type: 'image_url', value: 'stale', key: 'k1', id: '1' },
      { type: 'text', value: 'hello', id: '2' },
    ] },
    { config: { bucket: 'b' }, createPresignedGetUrl: ({ key }) => `https://cdn/${key}` }
  );
  assert.equal(signed.outputs[0].value, 'https://cdn/k1');
  assert.equal(signed.outputs[1].value, 'hello');
});

test('collectResultKeys extracts every stored key', () => {
  assert.deepEqual(
    collectResultKeys({ outputs: [{ key: 'a' }, { value: 'x' }, { key: 'b' }] }),
    ['a', 'b']
  );
});

test('executeNode runs real text models and returns text outputs', async () => {
  const result = await executeNode({
    provider: 'replicate',
    apiKey: 'r8_test',
    node: { category: 'text', model: 'llm', params: { prompt: 'Hello' } },
    runModel: async () => ({ text: 'Generated text' }),
  });

  assert.equal(result.outputs[0].type, 'text');
  assert.equal(result.outputs[0].value, 'Generated text');
});

// ---------------------------------------------------------------------------
// runProcessor
// ---------------------------------------------------------------------------

function baseRunDeps(overrides = {}) {
  return {
    getWorkflowById: async () => ({
      id: 'wf', provider: 'replicate',
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
    }),
    resolveProviderKey: async () => 'key',
    getS3Config: () => ({ bucket: 'b' }),
    listNodeRuns: async () => [{ id: 'nrA', nodeId: 'a' }, { id: 'nrB', nodeId: 'b' }],
    latestResultsForWorkflow: async () => ({}),
    updateRun: async () => {},
    updateNodeRun: async () => {},
    createWorkflowOutputObjectKey: ({ nodeRunId }) => `k-${nodeRunId}`,
    uploadObject: async ({ key }) => `https://cdn/${key}`,
    fetchFn: async () => fakeResponse(),
    executeGraph: async () => ({ status: 'completed' }),
    executeSingleNode: async () => ({ status: 'succeeded' }),
    executeNode: async () => ({ outputs: [] }),
    ...overrides,
  };
}

test('runClaimedRun executes the full graph with seeded node-run ids and stored inputs', async () => {
  let captured = null;
  const deps = baseRunDeps({ executeGraph: async (args) => { captured = args; return { status: 'completed' }; } });
  const run = { id: 'run1', userId: 'u1', workflowId: 'wf', provider: 'replicate', inputs: { a: { prompt: 'x' } }, targetNodeId: null };

  await runClaimedRun(run, deps);

  assert.deepEqual(captured.nodeRunIds, { a: 'nrA', b: 'nrB' });
  assert.deepEqual(captured.inputOverrides, { a: { prompt: 'x' } });
  assert.equal(captured.provider, 'replicate');
  assert.equal(captured.apiKey, 'key');
  // The storeOutputs hook mirrors media into S3.
  const stored = await captured.storeOutputs({
    result: { outputs: [{ type: 'image_url', value: 'https://p/x.png' }] },
    nodeRunId: 'nrA',
  });
  assert.deepEqual(stored.keys, ['k-nrA']);
});

test('runClaimedRun runs a single targeted node using prior workflow results', async () => {
  let captured = null;
  const deps = baseRunDeps({
    listNodeRuns: async () => [{ id: 'nrB', nodeId: 'b', model: 'flux', params: { prompt: 'p' } }],
    latestResultsForWorkflow: async () => ({ a: [{ type: 'text', value: 'from-a' }] }),
    executeSingleNode: async (args) => { captured = args; return { status: 'succeeded' }; },
  });
  const run = { id: 'run2', userId: 'u1', workflowId: 'wf', provider: 'replicate', targetNodeId: 'b' };

  await runClaimedRun(run, deps);

  assert.equal(captured.nodeRunId, 'nrB');
  assert.equal(captured.node.id, 'b');
  assert.equal(captured.node.params.prompt, 'p');
  assert.deepEqual(captured.resultsByNodeId, { a: [{ type: 'text', value: 'from-a' }] });
});

test('runClaimedRun fails the run when no provider key is available', async () => {
  const updates = [];
  const deps = baseRunDeps({
    resolveProviderKey: async () => null,
    updateRun: async (id, patch) => { updates.push(patch); },
  });
  const run = { id: 'run3', userId: 'u1', workflowId: 'wf', provider: 'replicate' };
  const result = await runClaimedRun(run, deps);
  assert.equal(result.status, 'failed');
  assert.equal(updates[0].status, 'failed');
});

test('processRun returns null when the run cannot be claimed', async () => {
  const deps = baseRunDeps({ claimRun: async () => null });
  const result = await processRun('run-x', deps);
  assert.equal(result, null);
});

test('processRun runs the claimed run', async () => {
  let ran = false;
  const deps = baseRunDeps({
    claimRun: async (id) => ({ id, userId: 'u1', workflowId: 'wf', provider: 'replicate' }),
    executeGraph: async () => { ran = true; return { status: 'completed' }; },
  });
  await processRun('run1', deps);
  assert.equal(ran, true);
});

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

test('runWorkerOnce claims pending runs and processes them', async () => {
  const processed = [];
  const claimed = [{ id: 'r1', userId: 'u', workflowId: 'wf', provider: 'replicate' }];
  const deps = baseRunDeps({
    executeGraph: async () => { processed.push('r1'); return { status: 'completed' }; },
  });
  const count = await runWorkerOnce({
    env: { WORKFLOW_WORKER_CONCURRENCY: '1' },
    deps,
    claimPendingRuns: async () => claimed,
  });
  assert.equal(count, 1);
  assert.deepEqual(processed, ['r1']);
});

test('runWorkerOnce returns 0 when there is nothing to claim', async () => {
  const count = await runWorkerOnce({
    env: {},
    deps: baseRunDeps(),
    claimPendingRuns: async () => [],
  });
  assert.equal(count, 0);
});
