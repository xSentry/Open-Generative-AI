import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalWorkflow } from '../modules/workflow/server/router.js';

function ctxFor(userId = 'user-1', provider = 'replicate') {
  return { user: { id: userId }, provider, apiKey: 'r8_test' };
}

// Build a params object shaped like the Next.js catch-all route segment.
function routeCtx(path) {
  return { params: Promise.resolve({ path }) };
}

function request(url = 'http://test.local/api/workflow', body) {
  return new Request(url, body ? { method: 'POST', body: JSON.stringify(body) } : {});
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

test('get-workflow-defs returns serialized summaries scoped to caller', async () => {
  const calls = [];
  const deps = {
    listWorkflows: async (scope) => {
      calls.push(scope);
      return [
        { id: 'wf-1', name: 'A', category: 'video', updatedAt: 'now', createdAt: 'then' },
      ];
    },
  };

  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['get-workflow-defs']),
    'GET',
    ctxFor('user-1', 'replicate'),
    deps
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], { userId: 'user-1', provider: 'replicate' });
  const body = await readJson(response);
  assert.equal(body.length, 1);
  assert.equal(body[0].workflow_id, 'wf-1');
  // `id` must be present too — WorkflowStudio keys/routes on wf.id (react key fix).
  assert.equal(body[0].id, 'wf-1');
  assert.equal(body[0].name, 'A');
});

test('get-workflow-def maps rows to the MuAPI envelope with is_owner', async () => {
  const deps = {
    getWorkflow: async () => ({
      id: 'wf-9',
      userId: 'user-1',
      name: 'My Flow',
      edges: [{ id: 'e1' }],
      nodes: [{ id: 'n1' }],
      category: 'image',
      published: false,
    }),
    listWorkflowNodeRuns: async () => [],
    getLatestRunForWorkflow: async () => null,
  };

  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['get-workflow-def', 'wf-9']),
    'GET',
    ctxFor('user-1'),
    deps
  );

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.deepEqual(body, {
    workflow_id: 'wf-9',
    name: 'My Flow',
    is_owner: true,
    edges: [{ id: 'e1' }],
    data: { nodes: [{ id: 'n1' }] },
    category: 'image',
    published: false,
    revision: 1,
    parent_revision: null,
    // Enriched load path attaches per-node run history from the DB; empty here.
    run_history: {},
  });
});

test('get-workflow-def hydrates node outputs, history and active run from the DB', async () => {
  const deps = {
    getWorkflow: async () => ({
      id: 'wf-10',
      userId: 'user-1',
      name: 'Live Flow',
      edges: [],
      // Saved node still carries a stale provider/proxy URL.
      nodes: [{ id: 'AI Image', category: 'image', model: 'flux', output_params: { outputs: [{ type: 'image_url', value: 'https://proxy.old/x.png' }], resultUrl: 'https://proxy.old/x.png' } }],
      category: 'image',
      published: false,
    }),
    listWorkflowNodeRuns: async () => [
      {
        id: 'nr-1',
        nodeId: 'AI Image',
        status: 'succeeded',
        result: { id: 'res-1', outputs: [{ type: 'image_url', value: 'ignored', key: 'workflow-outputs/u/wf-10/img.png' }] },
        error: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    getLatestRunForWorkflow: async () => ({ id: 'run-42', status: 'running' }),
    // Minimal S3 signer wiring so keys re-sign into fresh URLs.
    getS3Config: () => ({ bucket: 'b' }),
    createPresignedGetUrl: ({ key }) => `https://cdn.example/${key}`,
  };

  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['get-workflow-def', 'wf-10']),
    'GET',
    ctxFor('user-1'),
    deps
  );

  assert.equal(response.status, 200);
  const body = await readJson(response);
  // The stale proxy URL is replaced by a fresh signed S3 URL from the run.
  assert.equal(
    body.data.nodes[0].output_params.resultUrl,
    'https://cdn.example/workflow-outputs/u/wf-10/img.png'
  );
  // Per-node history is exposed (re-signed) for the outputHistory navigation.
  assert.equal(body.run_history['AI Image'].length, 1);
  assert.equal(body.run_history['AI Image'][0].status, 'succeeded');
  assert.equal(
    body.run_history['AI Image'][0].result.outputs[0].value,
    'https://cdn.example/workflow-outputs/u/wf-10/img.png'
  );
  // Active run is surfaced so the client can resume the SSE watcher.
  assert.equal(body.run_id, 'run-42');
  assert.equal(body.run_status, 'running');
});

test('get-workflow-def returns 404 when not found', async () => {
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['get-workflow-def', 'missing']),
    'GET',
    ctxFor('user-1'),
    { getWorkflow: async () => null }
  );
  assert.equal(response.status, 404);
});

test('create upserts and returns workflow_id, mapping data.nodes', async () => {
  let received;
  const deps = {
    upsertWorkflow: async (input) => {
      received = input;
      return { id: 'wf-new' };
    },
  };

  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {
      name: 'Fresh',
      category: 'video',
      edges: [{ id: 'e' }],
      data: { nodes: [{ id: 'n' }] },
    }),
    routeCtx(['create']),
    'POST',
    ctxFor('user-2', 'replicate'),
    deps
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { workflow_id: 'wf-new', revision: 1 });
  assert.equal(received.userId, 'user-2');
  assert.equal(received.provider, 'replicate');
  assert.deepEqual(received.nodes, [{ id: 'n' }]);
  assert.deepEqual(received.edges, [{ id: 'e' }]);
  assert.equal(received.expectedRevision, null);
});

test('create passes expected revision and maps revision conflicts to 409', async () => {
  let received;
  const ok = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {
      workflow_id: 'wf-1',
      revision: 4,
      name: 'Existing',
      data: { nodes: [] },
      edges: [],
    }),
    routeCtx(['create']),
    'POST',
    ctxFor('user-2', 'replicate'),
    {
      upsertWorkflow: async (input) => {
        received = input;
        return { id: 'wf-1' };
      },
    }
  );
  assert.equal(ok.status, 200);
  assert.equal(received.expectedRevision, 4);

  const conflict = new Error('The workflow changed after this operation was started.');
  conflict.code = 'WORKFLOW_REVISION_CONFLICT';
  conflict.currentRevision = 5;
  conflict.expectedRevision = 4;
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {
      workflow_id: 'wf-1',
      expected_revision: 4,
      data: { nodes: [] },
      edges: [],
    }),
    routeCtx(['create']),
    'POST',
    ctxFor('user-2', 'replicate'),
    { upsertWorkflow: async () => { throw conflict; } }
  );
  assert.equal(response.status, 409);
  const body = await readJson(response);
  assert.equal(body.error.code, 'WORKFLOW_REVISION_CONFLICT');
  assert.equal(body.error.current_revision, 5);
  assert.equal(body.error.expected_revision, 4);
});

test('delete-workflow-def returns deleted flag', async () => {
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['delete-workflow-def', 'wf-1']),
    'DELETE',
    ctxFor('user-1'),
    { deleteWorkflow: async () => ({ id: 'wf-1' }) }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { workflow_id: 'wf-1', deleted: true });
});

test('publish toggles published state', async () => {
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { publish: true }),
    routeCtx(['workflow', 'wf-1', 'publish']),
    'POST',
    ctxFor('user-1'),
    { setPublished: async () => ({ published: true }) }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { publish: true });
});

test('template endpoint marks a workflow as a provider-wide template', async () => {
  let received;
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { is_template: true }),
    routeCtx(['workflow', 'wf-1', 'template']),
    'POST',
    ctxFor('user-1'),
    { setTemplate: async (id, opts) => { received = { id, ...opts }; return { isTemplate: true }; } }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { is_template: true });
  assert.deepEqual(received, { id: 'wf-1', userId: 'user-1', isTemplate: true });
});

test('template endpoint returns 404 when the workflow is not owned', async () => {
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { is_template: true }),
    routeCtx(['workflow', 'missing', 'template']),
    'POST',
    ctxFor('user-1'),
    { setTemplate: async () => null }
  );
  assert.equal(response.status, 404);
});

test('clone endpoint copies a readable workflow and returns the new id', async () => {
  let scope;
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {}),
    routeCtx(['tmpl-1', 'clone']),
    'POST',
    ctxFor('user-2', 'replicate'),
    { cloneWorkflow: async (id, s) => { scope = { id, ...s }; return { id: 'wf-copy' }; } }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { workflow_id: 'wf-copy', revision: 1 });
  assert.deepEqual(scope, { id: 'tmpl-1', userId: 'user-2', provider: 'replicate' });
});

test('clone endpoint returns 404 for an unreadable workflow', async () => {
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {}),
    routeCtx(['nope', 'clone']),
    'POST',
    ctxFor('user-2'),
    { cloneWorkflow: async () => null }
  );
  assert.equal(response.status, 404);
});

test('revert endpoint creates a new server revision from the previous revision', async () => {
  let received;
  const deps = {
    getWorkflow: async () => ({
      id: 'wf-1',
      userId: 'user-1',
      provider: 'replicate',
      name: 'Current',
      revision: 4,
      isTemplate: false,
    }),
    revertWorkflowToRevision: async (id, revision, input) => {
      received = { id, revision, ...input };
      return {
        id,
        userId: 'user-1',
        name: 'Restored',
        category: 'image',
        edges: [{ id: 'e-restored' }],
        nodes: [{ id: 'n-restored' }],
        published: false,
        revision: 5,
        parentRevision: 4,
      };
    },
  };

  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {
      expected_revision: 4,
    }),
    routeCtx(['wf-1', 'revert']),
    'POST',
    ctxFor('user-1', 'replicate'),
    deps
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    id: 'wf-1',
    revision: 3,
    userId: 'user-1',
    provider: 'replicate',
    expectedRevision: 4,
  });
  const body = await readJson(response);
  assert.equal(body.workflow_id, 'wf-1');
  assert.equal(body.name, 'Restored');
  assert.equal(body.revision, 5);
  assert.equal(body.parent_revision, 4);
  assert.deepEqual(body.edges, [{ id: 'e-restored' }]);
});

test('revert endpoint rejects missing previous revision', async () => {
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {}),
    routeCtx(['wf-1', 'revert']),
    'POST',
    ctxFor('user-1', 'replicate'),
    {
      getWorkflow: async () => ({
        id: 'wf-1',
        userId: 'user-1',
        provider: 'replicate',
        revision: 1,
        isTemplate: false,
      }),
    }
  );

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.equal(body.error.code, 'INVALID_REVERT_REVISION');
});

test('template list marks ownership via is_owner', async () => {
  const deps = {
    listTemplates: async () => [
      { id: 't1', userId: 'user-1', name: 'Mine', isTemplate: true },
      { id: 't2', userId: 'someone-else', name: 'Theirs', isTemplate: true },
    ],
  };
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['get-template-workflows']),
    'GET',
    ctxFor('user-1'),
    deps
  );
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.find((w) => w.id === 't1').is_owner, true);
  assert.equal(body.find((w) => w.id === 't2').is_owner, false);
});

test('run endpoint is implemented (Phase 3) and returns a run_id', async () => {
  const deps = {
    getWorkflow: async () => ({ id: 'wf-1', nodes: [], edges: [] }),
    createRun: async () => ({ id: 'run-1' }),
    createNodeRun: async () => ({ id: 'nr' }),
    executeGraph: async () => {},
  };
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { cost: 0 }),
    routeCtx(['wf-1', 'run']),
    'POST',
    ctxFor('user-1'),
    deps
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { run_id: 'run-1' });
});

test('unknown endpoint responds 404', async () => {
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['nope']),
    'GET',
    ctxFor('user-1')
  );
  assert.equal(response.status, 404);
});

