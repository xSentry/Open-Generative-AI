import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalWorkflow } from '../modules/workflow/server/router.js';
import {
  cleanNodesForFreshCopy,
  TEMPLATE_REVISION_SOURCE,
} from '../modules/workflow/server/workflowsRepo.js';

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

test('fresh workflow copies remove persisted run outputs and transient state', () => {
  const source = [{
    id: 'image-1',
    params: { prompt: 'keep me' },
    output_params: { outputs: [{ type: 'image_url', value: 'https://stale/image.png' }], resultUrl: 'https://stale/image.png' },
    data: { outputHistory: [{ id: 'run-1' }], errorMsg: 'old failure', isLoading: true },
  }];
  const copy = cleanNodesForFreshCopy(source);
  assert.deepEqual(copy[0].params, { prompt: 'keep me' });
  assert.deepEqual(copy[0].output_params, { outputs: [], resultUrl: null });
  assert.equal(copy[0].data.outputHistory, undefined);
  assert.equal(copy[0].data.errorMsg, undefined);
  assert.equal(copy[0].data.isLoading, undefined);
  assert.equal(source[0].output_params.outputs.length, 1, 'source graph is not mutated');
});

test('template snapshots use a revision source allowed by migration 011', () => {
  assert.equal(TEMPLATE_REVISION_SOURCE, 'manual');
});

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

test('template endpoint publishes a fresh clone and leaves the source unchanged', async () => {
  let received;
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { is_template: true }),
    routeCtx(['workflow', 'wf-1', 'template']),
    'POST',
    ctxFor('user-1'),
    {
      getWorkflow: async () => ({ id: 'wf-1', userId: 'user-1', thumbnailKey: null }),
      createTemplate: async (id, opts) => {
        received = { id, ...opts };
        return { id: 'template-1', isTemplate: true };
      },
      setTemplate: async () => { throw new Error('source must not be marked as a template'); },
    }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { workflow_id: 'template-1', is_template: true });
  assert.deepEqual(received, { id: 'wf-1', userId: 'user-1', provider: 'replicate' });
});

test('template endpoint returns 404 when the workflow is not owned', async () => {
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { is_template: true }),
    routeCtx(['workflow', 'missing', 'template']),
    'POST',
    ctxFor('user-1'),
    { getWorkflow: async () => null }
  );
  assert.equal(response.status, 404);
});

test('template publishing clones the selected thumbnail into template storage', async () => {
  let savedThumbnail = null;
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', { is_template: true }),
    routeCtx(['workflow', 'wf-1', 'template']),
    'POST',
    ctxFor('user-1', 'replicate'),
    {
      getWorkflow: async (id) => id === 'wf-1'
        ? { id, userId: 'user-1', thumbnailKey: 'https://old/cover.png', thumbnailObjectKey: 'workflow-thumbnails/u/wf-1/old.png' }
        : { id, userId: 'user-1', isTemplate: true },
      createTemplate: async () => ({ id: 'template-1', userId: 'user-1', isTemplate: true }),
      getS3Config: () => ({ bucket: 'b' }),
      createPresignedGetUrl: ({ key }) => `https://signed/${key}`,
      fetchFn: async (url) => {
        assert.equal(url, 'https://signed/workflow-thumbnails/u/wf-1/old.png');
        return new Response(Buffer.from('cover'), { headers: { 'content-type': 'image/png' } });
      },
      createWorkflowThumbnailObjectKey: ({ workflowId }) => `workflow-thumbnails/u/${workflowId}/new.png`,
      uploadObject: async ({ key }) => `https://cdn/${key}`,
      setThumbnail: async (id, args) => {
        savedThumbnail = { id, ...args };
        return { id, thumbnailKey: args.thumbnailUrl };
      },
      deleteObject: async () => {},
    }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(savedThumbnail, {
    id: 'template-1',
    userId: 'user-1',
    thumbnailUrl: 'https://cdn/workflow-thumbnails/u/template-1/new.png',
    thumbnailObjectKey: 'workflow-thumbnails/u/template-1/new.png',
  });
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

test('revert endpoint is not available', async () => {
  const response = await handleLocalWorkflow(
    request('http://test.local/api/workflow', {}),
    routeCtx(['wf-1', 'revert']),
    'POST',
    ctxFor('user-1', 'replicate')
  );

  assert.equal(response.status, 404);
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

