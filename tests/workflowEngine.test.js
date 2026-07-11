import assert from 'node:assert/strict';
import test from 'node:test';
import {
  topoSort,
  resolveValue,
  resolveParams,
  executeGraph,
  executeSingleNode,
  latestResultsFromRuns,
  collectTerminalOutputs,
} from '../modules/workflow/server/engine.js';

// In-memory repo capturing run/node-run mutations so executeGraph can run under
// node --test without a database.
function makeRepo() {
  const runs = new Map();
  const nodeRuns = new Map();
  return {
    runs,
    nodeRuns,
    async updateRun(id, patch) {
      const row = runs.get(id) || { id };
      Object.assign(row, patch);
      runs.set(id, row);
      return row;
    },
    async updateNodeRun(id, patch) {
      const row = nodeRuns.get(id) || { id };
      Object.assign(row, patch);
      nodeRuns.set(id, row);
      return row;
    },
  };
}

test('topoSort orders nodes by dependency and detects cycles', () => {
  const nodes = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ];
  const ordered = topoSort(nodes, edges).map((n) => n.id);
  assert.deepEqual(ordered, ['a', 'b', 'c']);

  assert.throws(
    () => topoSort([{ id: 'x' }, { id: 'y' }], [
      { source: 'x', target: 'y' },
      { source: 'y', target: 'x' },
    ]),
    /cycle/i
  );
});

test('topoSort also honours node.inputs as dependencies', () => {
  const nodes = [
    { id: 'downstream', inputs: ['upstream'] },
    { id: 'upstream' },
  ];
  const ordered = topoSort(nodes, []).map((n) => n.id);
  assert.deepEqual(ordered, ['upstream', 'downstream']);
});

test('resolveValue substitutes whole-string, embedded and nested templates', () => {
  const results = {
    n1: [{ value: 'https://img/1.png' }],
    n2: [{ value: 'a cat' }],
  };
  // Whole-string template returns the raw value.
  assert.equal(resolveValue('{{ n1.outputs[0].value }}', results), 'https://img/1.png');
  // Embedded template interpolates into the surrounding string.
  assert.equal(resolveValue('prompt: {{ n2.outputs[0].value }}!', results), 'prompt: a cat!');
  // Arrays drop empty/unresolved entries and resolve each item.
  assert.deepEqual(
    resolveValue(['{{ n1.outputs[0].value }}', ''], results),
    ['https://img/1.png']
  );
  // Objects recurse.
  assert.deepEqual(
    resolveParams({ image_url: '{{ n1.outputs[0].value }}', prompt: 'x' }, results),
    { image_url: 'https://img/1.png', prompt: 'x' }
  );
  // Unknown references are left untouched.
  assert.equal(resolveValue('{{ ghost.outputs[0].value }}', results), '{{ ghost.outputs[0].value }}');
});

test('executeGraph runs nodes in order and propagates outputs via templates', async () => {
  const repo = makeRepo();
  const nodes = [
    { id: 'text-1', category: 'text', params: { prompt: 'hello' } },
    { id: 'img-1', category: 'image', model: 'flux', params: { prompt: '{{ text-1.outputs[0].value }}' } },
  ];
  const edges = [{ source: 'text-1', target: 'img-1' }];

  const executeNode = async ({ node }) => {
    if (node.category === 'text') {
      return { id: `r-${node.id}`, outputs: [{ type: 'text', value: node.params.prompt, id: 'o' }] };
    }
    return { id: `r-${node.id}`, outputs: [{ type: 'image_url', value: `img:${node.params.prompt}`, id: 'o' }] };
  };

  const result = await executeGraph({
    nodes,
    edges,
    runId: 'run-1',
    provider: 'replicate',
    apiKey: 'k',
    nodeRunIds: { 'text-1': 'nr1', 'img-1': 'nr2' },
    repo,
    executeNode,
  });

  assert.equal(result.status, 'completed');
  assert.equal(repo.runs.get('run-1').status, 'completed');
  assert.equal(repo.nodeRuns.get('nr1').status, 'succeeded');
  assert.equal(repo.nodeRuns.get('nr2').status, 'succeeded');
  // The template {{ text-1.outputs[0].value }} was resolved to "hello".
  assert.equal(repo.nodeRuns.get('nr2').result.outputs[0].value, 'img:hello');
});

test('executeGraph runs independent ready nodes concurrently and waits at joins', async () => {
  const repo = makeRepo();
  const nodes = [
    { id: 'a', category: 'text', params: { prompt: 'A' } },
    { id: 'b', category: 'text', params: { prompt: 'B' } },
    { id: 'join', category: 'text', params: { prompt: '{{ a.outputs[0].value }} {{ b.outputs[0].value }}' } },
  ];
  const edges = [
    { source: 'a', target: 'join' },
    { source: 'b', target: 'join' },
  ];

  const started = [];
  let releaseBoth;
  const bothStarted = new Promise((resolve) => { releaseBoth = resolve; });
  const executeNode = async ({ node }) => {
    started.push(node.id);
    if (node.id === 'a' || node.id === 'b') {
      if (started.includes('a') && started.includes('b')) releaseBoth();
      await bothStarted;
    }
    return { id: `r-${node.id}`, outputs: [{ type: 'text', value: node.params.prompt, id: 'o' }] };
  };

  const result = await Promise.race([
    executeGraph({
      nodes,
      edges,
      runId: 'run-parallel',
      nodeRunIds: { a: 'nrA', b: 'nrB', join: 'nrJoin' },
      repo,
      executeNode,
    }),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 250)),
  ]);

  assert.equal(result.status, 'completed');
  assert.deepEqual(new Set(started.slice(0, 2)), new Set(['a', 'b']));
  assert.equal(started[2], 'join');
  assert.equal(repo.nodeRuns.get('nrJoin').result.outputs[0].value, 'A B');
});

test('executeGraph marks the run failed and stops on a node error', async () => {
  const repo = makeRepo();
  const nodes = [
    { id: 'a', category: 'image', model: 'flux', params: {} },
    { id: 'b', category: 'image', model: 'flux', params: {} },
  ];
  const edges = [{ source: 'a', target: 'b' }];

  const executeNode = async ({ node }) => {
    if (node.id === 'a') throw new Error('provider exploded');
    return { id: 'r', outputs: [] };
  };

  const result = await executeGraph({
    nodes,
    edges,
    runId: 'run-2',
    nodeRunIds: { a: 'nrA', b: 'nrB' },
    repo,
    executeNode,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /provider exploded/);
  assert.equal(repo.runs.get('run-2').status, 'failed');
  assert.equal(repo.nodeRuns.get('nrA').status, 'failed');
  // Downstream node b never ran and is marked failed instead of staying queued forever.
  assert.equal(repo.nodeRuns.get('nrB').status, 'failed');
  assert.match(repo.nodeRuns.get('nrB').error, /skipped/i);
  // Failure result carries an error the UI can render (outputs[0].value.error).
  assert.match(repo.nodeRuns.get('nrA').result.outputs[0].value.error, /provider exploded/);
});

test('executeGraph applies api-execute input overrides', async () => {
  const repo = makeRepo();
  const nodes = [{ id: 'text-1', category: 'text', params: { prompt: 'stored' } }];
  const seen = {};
  const executeNode = async ({ node }) => {
    seen.prompt = node.params.prompt;
    return { id: 'r', outputs: [{ type: 'text', value: node.params.prompt, id: 'o' }] };
  };

  await executeGraph({
    nodes,
    edges: [],
    runId: 'run-3',
    nodeRunIds: { 'text-1': 'nr' },
    inputOverrides: { 'text-1': { prompt: 'overridden' } },
    repo,
    executeNode,
  });

  assert.equal(seen.prompt, 'overridden');
});

test('executeSingleNode resolves connected params from prior workflow results', async () => {
  const repo = makeRepo();
  let seenParams = null;
  const executeNode = async ({ node }) => {
    seenParams = node.params;
    return { id: 'r-single', outputs: [{ type: 'image_url', value: 'out.png', id: 'o' }] };
  };

  const result = await executeSingleNode({
    node: {
      id: 'image-3',
      category: 'image',
      model: 'flux-kontext',
      params: {
        prompt: 'combine',
        images_list: [
          '{{ image-1.outputs[0].value }}',
          '{{ image-2.outputs[0].value }}',
        ],
      },
    },
    nodeRunId: 'nr-single',
    runId: 'run-single',
    resultsByNodeId: {
      'image-1': [{ type: 'image_url', value: 'https://cdn/one.png', id: 'o1' }],
      'image-2': [{ type: 'image_url', value: 'https://cdn/two.png', id: 'o2' }],
    },
    repo,
    executeNode,
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(seenParams.images_list, ['https://cdn/one.png', 'https://cdn/two.png']);
  assert.equal(repo.runs.get('run-single').status, 'completed');
  assert.equal(repo.nodeRuns.get('nr-single').status, 'succeeded');
});

test('latestResultsFromRuns keeps only succeeded node outputs', () => {
  const map = latestResultsFromRuns([
    { nodeId: 'a', status: 'succeeded', result: { outputs: [{ value: 'A' }] } },
    { nodeId: 'b', status: 'failed', result: { outputs: [{ value: { error: 'x' } }] } },
  ]);
  assert.deepEqual(Object.keys(map), ['a']);
  assert.equal(map.a[0].value, 'A');
});

test('collectTerminalOutputs flattens outputs of nodes with no outgoing edge', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }];
  const edges = [{ source: 'a', target: 'b' }];
  const results = {
    a: [{ type: 'text', value: 'A', id: '1' }],
    b: [{ type: 'image_url', value: 'B', id: '2' }],
  };
  // Only b is terminal (a has an outgoing edge).
  assert.deepEqual(collectTerminalOutputs(nodes, edges, results), [
    { type: 'image_url', value: 'B', id: '2', node_id: 'b', node_name: 'Node' },
  ]);
});

test('collectTerminalOutputs prefers nodes marked as workflow outputs', () => {
  const nodes = [
    { id: 'a', input_params: { make_output: true } },
    { id: 'b', input_params: {} },
  ];
  const edges = [{ source: 'a', target: 'b' }];
  const results = {
    a: [{ type: 'image_url', value: 'A', id: '1' }],
    b: [{ type: 'image_url', value: 'B', id: '2' }],
  };

  assert.deepEqual(collectTerminalOutputs(nodes, edges, results), [
    { type: 'image_url', value: 'A', id: '1', node_id: 'a', node_name: 'Node' },
  ]);
});

