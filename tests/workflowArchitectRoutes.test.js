import assert from 'node:assert/strict';
import test from 'node:test';
import { handleWorkflowArchitect } from '../modules/workflow-architect/api/router.js';
import { processArchitectJob } from '../modules/workflow-architect/infrastructure/worker.js';
import { createWorkflowPatch } from '../modules/workflow-domain/patchSchema.js';
import { WorkflowRevisionConflict } from '../modules/workflow-domain/revisionService.js';

function ctxFor(userId = 'user-1', provider = 'replicate') {
  return { user: { id: userId }, provider, apiKey: 'r8_test' };
}

function routeCtx(path) {
  return { params: Promise.resolve({ path }) };
}

function request(url = 'http://test.local/api/workflow-architect', body) {
  return new Request(url, body ? { method: 'POST', body: JSON.stringify(body) } : {});
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

test('POST jobs persists, records progress, and enqueues an architect job', async () => {
  const calls = [];
  const deps = {
    createArchitectJob: async (input) => {
      calls.push(['create', input]);
      return {
        id: 'job-1',
        userId: input.userId,
        workflowId: input.workflowId,
        baseRevision: input.baseRevision,
        operation: input.operation,
        status: 'queued',
        provider: input.provider,
        catalogVersion: 'cat',
        schemaVersion: 'schema',
      };
    },
    appendArchitectEvent: async (event) => calls.push(['event', event]),
    enqueueJob: async (job) => calls.push(['enqueue', job]),
  };

  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/jobs', {
      workflow_id: 'wf-1',
      base_revision: 4,
      operation: 'edit',
      idempotency_key: 'idem-1',
      selected_node_id: 'node-1',
      parameter_updates: { duration: 6 },
    }),
    routeCtx(['jobs']),
    'POST',
    ctxFor('user-9'),
    deps
  );

  assert.equal(response.status, 202);
  const body = await readJson(response);
  assert.equal(body.job.id, 'job-1');
  assert.equal(body.job.workflow_id, 'wf-1');
  assert.deepEqual(calls.map((call) => call[0]), ['create', 'event', 'enqueue']);
  assert.equal(calls[0][1].userId, 'user-9');
  assert.equal(calls[0][1].provider, 'replicate');
  assert.deepEqual(calls[0][1].request, {
    type: 'bounded_edit',
    prompt_redacted: '',
    selected_node_id: 'node-1',
    parameter_updates: { duration: 6 },
    replacement_model_id: null,
    insert_node: null,
    position: null,
  });
});

test('POST jobs accepts fixture proposal payload for async Phase 1 processing', async () => {
  const patch = createWorkflowPatch({
    baseRevision: 4,
    preconditions: [{ type: 'workflow_revision_equals', revision: 4 }],
    operations: [{ op: 'set_workflow_metadata', metadata: { name: 'Async fixture' } }],
  });
  let received;
  const deps = {
    createArchitectJob: async (input) => {
      received = input;
      return {
        id: 'job-fixture-async',
        userId: input.userId,
        workflowId: input.workflowId,
        baseRevision: input.baseRevision,
        operation: input.operation,
        status: 'queued',
        provider: input.provider,
        catalogVersion: 'cat',
        schemaVersion: 'schema',
      };
    },
    appendArchitectEvent: async () => {},
    enqueueJob: async () => {},
  };

  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/jobs', {
      workflow_id: 'wf-1',
      base_revision: 4,
      operation: 'edit',
      fixture_proposal: {
        patch,
        summary: { title: 'Async fixture' },
      },
    }),
    routeCtx(['jobs']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 202);
  assert.equal(received.request.type, 'fixture_proposal');
  assert.deepEqual(received.request.patch, patch);
});

test('POST jobs accepts a create workflow request for Phase 2 processing', async () => {
  let received;
  const deps = {
    createArchitectJob: async (input) => {
      received = input;
      return {
        id: 'job-create',
        userId: input.userId,
        workflowId: input.workflowId,
        baseRevision: input.baseRevision,
        operation: input.operation,
        status: 'queued',
        provider: input.provider,
        catalogVersion: 'cat',
        schemaVersion: 'schema',
      };
    },
    appendArchitectEvent: async () => {},
    enqueueJob: async () => {},
  };

  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/jobs', {
      workflow_id: 'wf-empty',
      base_revision: 1,
      operation: 'create',
      request_text: 'Create an image workflow for neon product photos.',
    }),
    routeCtx(['jobs']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 202);
  assert.equal(received.operation, 'create');
  assert.deepEqual(received.request, {
    type: 'create_workflow',
    prompt_redacted: 'Create an image workflow for neon product photos.',
  });
});

test('POST jobs accepts deterministic explain and validate requests for Phase 3', async () => {
  const received = [];
  const deps = {
    createArchitectJob: async (input) => {
      received.push(input);
      return {
        id: `job-${input.operation}`,
        userId: input.userId,
        workflowId: input.workflowId,
        baseRevision: input.baseRevision,
        operation: input.operation,
        status: 'queued',
        provider: input.provider,
        catalogVersion: 'cat',
        schemaVersion: 'schema',
      };
    },
    appendArchitectEvent: async () => {},
    enqueueJob: async () => {},
  };

  for (const operation of ['explain', 'validate']) {
    const response = await handleWorkflowArchitect(
      request('http://test.local/api/workflow-architect/jobs', {
        workflow_id: 'wf-1',
        base_revision: 3,
        operation,
      }),
      routeCtx(['jobs']),
      'POST',
      ctxFor(),
      deps
    );
    assert.equal(response.status, 202);
  }

  assert.equal(received[0].request.type, 'explain_workflow');
  assert.equal(received[1].request.type, 'validate_workflow');
});

test('POST edit jobs require a selected node', async () => {
  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/jobs', {
      workflow_id: 'wf-1',
      base_revision: 3,
      operation: 'edit',
      request_text: 'Set duration to 8.',
    }),
    routeCtx(['jobs']),
    'POST',
    ctxFor(),
    {
      createArchitectJob: async () => {
        throw new Error('should not create job');
      },
    }
  );

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.equal(body.error.code, 'ARCHITECT_SELECTED_NODE_REQUIRED');
});

test('GET jobs returns completed proposal when one exists', async () => {
  const deps = {
    getArchitectJob: async (id, input) => ({
      id,
      userId: input.userId,
      workflowId: 'wf-1',
      baseRevision: 2,
      operation: 'edit',
      status: 'completed',
      provider: 'replicate',
      catalogVersion: 'cat',
      schemaVersion: 'schema',
    }),
    getProposalForJob: async (id, input) => ({
      id: 'proposal-for-job',
      jobId: id,
      userId: input.userId,
      workflowId: 'wf-1',
      baseRevision: 2,
      patchVersion: 'workflow-patch/v1',
      summary: { title: 'Ready' },
      validation: { valid: true, warnings: [], errors: [] },
      diff: {},
      status: 'pending',
      catalogVersion: 'cat',
      compilerVersion: 'fixture',
    }),
  };

  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/jobs/job-1'),
    routeCtx(['jobs', 'job-1']),
    'GET',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.job.status, 'completed');
  assert.equal(body.proposal.id, 'proposal-for-job');
});

test('GET job events returns persisted progress after a sequence cursor', async () => {
  let received;
  const deps = {
    listArchitectEvents: async (jobId, input) => {
      received = { jobId, ...input };
      return [
        {
          id: 'event-2',
          job_id: jobId,
          sequence: 2,
          event_type: 'proposal',
          stage: 'completed',
          payload_redacted: { proposal_id: 'proposal-1' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ];
    },
  };

  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/jobs/job-1/events?after=1'),
    routeCtx(['jobs', 'job-1', 'events']),
    'GET',
    ctxFor('user-1'),
    deps
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, { jobId: 'job-1', userId: 'user-1', afterSequence: '1' });
  const body = await readJson(response);
  assert.equal(body.events[0].stage, 'completed');
});

test('fixture proposal endpoint returns a previewable proposal without applying it', async () => {
  const patch = createWorkflowPatch({
    baseRevision: 2,
    preconditions: [{ type: 'workflow_revision_equals', revision: 2 }],
    operations: [
      { op: 'set_workflow_metadata', metadata: { name: 'Fixture flow' } },
    ],
  });
  let received;
  const deps = {
    createFixtureProposal: async (input) => {
      received = input;
      return {
        job: {
          id: 'job-fixture',
          userId: input.userId,
          workflowId: input.workflowId,
          baseRevision: input.baseRevision,
          operation: 'edit',
          status: 'completed',
          provider: input.provider,
          catalogVersion: 'cat',
          schemaVersion: 'schema',
        },
        proposal: {
          id: 'proposal-1',
          jobId: 'job-fixture',
          userId: input.userId,
          workflowId: input.workflowId,
          baseRevision: input.baseRevision,
          patchVersion: patch.version,
          patch,
          summary: { title: 'Fixture' },
          validation: { valid: true, warnings: [], errors: [] },
          diff: { workflow_metadata_changes: [{ name: 'Fixture flow' }] },
          status: 'pending',
          catalogVersion: 'cat',
          compilerVersion: 'fixture',
        },
      };
    },
  };

  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/fixture-proposals', {
      workflow_id: 'wf-1',
      base_revision: 2,
      patch,
    }),
    routeCtx(['fixture-proposals']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 201);
  const body = await readJson(response);
  assert.equal(body.proposal.id, 'proposal-1');
  assert.equal(body.proposal.status, 'pending');
  assert.equal(received.workflowId, 'wf-1');
  assert.deepEqual(received.patch, patch);
});

test('proposal apply returns the server-updated workflow envelope', async () => {
  const deps = {
    buildNodeSchemas: () => ({}),
    applyProposalTransaction: async (id, input) => {
      assert.equal(id, 'proposal-1');
      assert.equal(input.userId, 'user-1');
      assert.equal(input.provider, 'replicate');
      assert.equal(input.expectedWorkflowRevision, 3);
      assert.equal(input.idempotencyKey, 'apply-1');
      return {
        proposal: {
          id,
          jobId: 'job-1',
          workflowId: 'wf-1',
          baseRevision: 3,
          patchVersion: 'workflow-patch/v1',
          summary: {},
          validation: { valid: true, warnings: [], errors: [] },
          diff: {},
          status: 'accepted',
          catalogVersion: 'cat',
          compilerVersion: 'fixture',
        },
        workflow: {
          id: 'wf-1',
          userId: 'user-1',
          name: 'Updated',
          category: 'image',
          edges: [],
          nodes: [],
          published: false,
          revision: 4,
          parentRevision: 3,
        },
      };
    },
  };

  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/proposals/proposal-1/apply', {
      expected_workflow_revision: 3,
      idempotency_key: 'apply-1',
    }),
    routeCtx(['proposals', 'proposal-1', 'apply']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.proposal.status, 'accepted');
  assert.equal(body.workflow.workflow_id, 'wf-1');
  assert.equal(body.workflow.revision, 4);
});

test('proposal apply maps revision conflicts to 409', async () => {
  const deps = {
    buildNodeSchemas: () => ({}),
    applyProposalTransaction: async () => {
      throw new WorkflowRevisionConflict(5, 3);
    },
  };

  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/proposals/proposal-1/apply', {
      expected_workflow_revision: 3,
    }),
    routeCtx(['proposals', 'proposal-1', 'apply']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 409);
  const body = await readJson(response);
  assert.equal(body.error.code, 'WORKFLOW_REVISION_CONFLICT');
  assert.equal(body.error.current_revision, 5);
  assert.equal(body.error.proposal_revision, 3);
});

test('proposal reject marks a pending proposal rejected', async () => {
  const deps = {
    rejectProposal: async (id, input) => ({
      id,
      jobId: 'job-1',
      userId: input.userId,
      workflowId: 'wf-1',
      baseRevision: 2,
      patchVersion: 'workflow-patch/v1',
      summary: {},
      validation: { valid: true, warnings: [], errors: [] },
      diff: {},
      status: 'rejected',
      catalogVersion: 'cat',
      compilerVersion: 'fixture',
    }),
  };

  const response = await handleWorkflowArchitect(
    request('http://test.local/api/workflow-architect/proposals/proposal-1/reject', {}),
    routeCtx(['proposals', 'proposal-1', 'reject']),
    'POST',
    ctxFor(),
    deps
  );

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.proposal.status, 'rejected');
});

test('phase 1 worker creates proposals for fixture jobs', async () => {
  const patch = createWorkflowPatch({
    baseRevision: 2,
    preconditions: [{ type: 'workflow_revision_equals', revision: 2 }],
    operations: [{ op: 'set_workflow_metadata', metadata: { name: 'Worker fixture' } }],
  });
  const events = [];
  const result = await processArchitectJob('job-1', {
    markArchitectJobRunning: async (id) => ({
      id,
      userId: 'user-1',
      workflowId: 'wf-1',
      baseRevision: 2,
      status: 'running',
      catalogVersion: 'cat',
      request: {
        type: 'fixture_proposal',
        patch,
        summary: { title: 'Worker fixture' },
      },
    }),
    appendArchitectEvent: async (event) => events.push(event),
    createProposalForJob: async (job, input) => ({
      id: 'proposal-1',
      jobId: job.id,
      workflowId: job.workflowId,
      diff: { workflow_metadata_changes: [{ name: 'Worker fixture' }] },
      patch: input.patch,
    }),
    completeArchitectJob: async (id) => ({ id, status: 'completed' }),
  });

  assert.equal(result.job.status, 'completed');
  assert.equal(result.proposal.id, 'proposal-1');
  assert.deepEqual(events.map((event) => event.stage), ['running', 'compiling_fixture', 'completed']);
});

test('phase 2 worker creates a proposal for an empty workflow create job', async () => {
  const events = [];
  const result = await processArchitectJob('job-create', {
    markArchitectJobRunning: async (id) => ({
      id,
      userId: 'user-1',
      workflowId: 'wf-empty',
      baseRevision: 1,
      operation: 'create',
      provider: 'replicate',
      status: 'running',
      request: {
        type: 'create_workflow',
        prompt_redacted: 'Create an image workflow for neon product photos.',
      },
    }),
    appendArchitectEvent: async (event) => events.push(event),
    getArchitectWorkflow: async () => ({
      id: 'wf-empty',
      userId: 'user-1',
      provider: 'replicate',
      name: 'Untitled',
      category: null,
      edges: [],
      nodes: [],
      isTemplate: false,
      revision: 1,
    }),
    generateCreateWorkflowIr: async () => ({
      operation: 'create_workflow',
      workflow_name: 'Neon product photos',
      target_category: 'image',
      model_id: 'flux-schnell',
      prompt: 'Neon product photo on a glossy black surface',
      parameters: { aspect_ratio: '1:1' },
    }),
    createProposalForJob: async (job, input) => ({
      id: 'proposal-create',
      jobId: job.id,
      workflowId: job.workflowId,
      diff: { nodes_added: input.patch.operations.filter((op) => op.op === 'add_node') },
      patch: input.patch,
      validation: input.validation,
    }),
    completeArchitectJob: async (id) => ({ id, status: 'completed' }),
  });

  assert.equal(result.job.status, 'completed');
  assert.equal(result.proposal.id, 'proposal-create');
  assert.equal(result.proposal.validation.valid, true);
  assert.deepEqual(events.map((event) => event.stage), ['running', 'calling_model', 'normalizing_ir', 'completed']);
  assert.equal(result.proposal.patch.operations.filter((op) => op.op === 'add_node').length, 2);
  assert.equal(result.proposal.patch.operations.some((op) => op.op === 'connect'), true);
});

test('phase 3 worker explains and validates an existing workflow deterministically', async () => {
  const events = [];
  const result = await processArchitectJob('job-explain', {
    markArchitectJobRunning: async (id) => ({
      id,
      userId: 'user-1',
      workflowId: 'wf-1',
      baseRevision: 2,
      operation: 'explain',
      provider: 'replicate',
      status: 'running',
      request: { type: 'explain_workflow' },
    }),
    appendArchitectEvent: async (event) => events.push(event),
    buildNodeSchemas: () => ({
      categories: {
        text: { models: { 'text-passthrough': { input_schema: { prompt: {} } } } },
        image: { models: { 'flux-schnell': { input_schema: { prompt: {}, aspect_ratio: {} } } } },
      },
    }),
    getArchitectWorkflow: async () => ({
      id: 'wf-1',
      userId: 'user-1',
      provider: 'replicate',
      name: 'Product image',
      category: 'image',
      edges: [],
      nodes: [
        {
          id: 'image-1',
          title: 'Image',
          category: 'image',
          model: 'flux-schnell',
          input_params: { prompt: 'A watch', make_output: true },
          params: { prompt: 'A watch' },
        },
      ],
      isTemplate: false,
      revision: 2,
    }),
    createProposalForJob: async (job, input) => ({
      id: 'proposal-explain',
      jobId: job.id,
      workflowId: job.workflowId,
      patch: input.patch,
      summary: input.summary,
      validation: input.validation,
      diff: {},
    }),
    completeArchitectJob: async (id) => ({ id, status: 'completed' }),
  });

  assert.equal(result.job.status, 'completed');
  assert.equal(result.proposal.patch.operations.length, 0);
  assert.equal(result.proposal.summary.workflow.steps[0].node_id, 'image-1');
  assert.equal(result.proposal.validation.valid, true);
  assert.equal(result.proposal.summary.workflow.steps.length, 1);
  assert.deepEqual(events.map((event) => event.stage), ['running', 'completed']);
});

test('phase 3 worker creates a bounded selected-node parameter edit proposal', async () => {
  const result = await processArchitectJob('job-edit', {
    markArchitectJobRunning: async (id) => ({
      id,
      userId: 'user-1',
      workflowId: 'wf-1',
      baseRevision: 4,
      operation: 'edit',
      provider: 'replicate',
      status: 'running',
      request: {
        type: 'bounded_edit',
        selected_node_id: 'video-1',
        prompt_redacted: 'Set duration to 8.',
      },
    }),
    appendArchitectEvent: async () => {},
    failArchitectJob: async (id, error) => ({ id, status: 'failed', errorCode: error.code, message: error.message }),
    buildNodeSchemas: () => ({
      categories: {
        video: {
          models: {
            'seedance-2-0-mini': {
              input_schema: { prompt: {}, duration: {}, aspect_ratio: {} },
            },
          },
        },
      },
    }),
    getArchitectWorkflow: async () => ({
      id: 'wf-1',
      userId: 'user-1',
      provider: 'replicate',
      name: 'Video flow',
      category: 'video',
      edges: [],
      nodes: [
        {
          id: 'video-1',
          title: 'Video',
          category: 'video',
          model: 'seedance-2-0-mini',
          input_params: { prompt: 'A skyline', duration: 5 },
          params: { prompt: 'A skyline', duration: 5 },
        },
      ],
      isTemplate: false,
      revision: 4,
    }),
    createProposalForJob: async (job, input) => ({
      id: 'proposal-edit',
      jobId: job.id,
      workflowId: job.workflowId,
      patch: input.patch,
      summary: input.summary,
      validation: input.validation,
      diff: {},
    }),
    completeArchitectJob: async (id) => ({ id, status: 'completed' }),
  });

  assert.equal(result.job.status, 'completed');
  assert.deepEqual(result.proposal.patch.preconditions[0], { type: 'workflow_revision_equals', revision: 4 });
  assert.deepEqual(result.proposal.patch.operations, [
    {
      op: 'set_node_parameter',
      node_id: 'video-1',
      parameter: 'duration',
      value: 8,
      expected_previous_value: 5,
    },
  ]);
  assert.equal(result.proposal.validation.valid, true);
});

test('phase 3 worker creates a curated selected-model replacement proposal', async () => {
  const result = await processArchitectJob('job-model-edit', {
    markArchitectJobRunning: async (id) => ({
      id,
      userId: 'user-1',
      workflowId: 'wf-1',
      baseRevision: 5,
      operation: 'edit',
      provider: 'replicate',
      status: 'running',
      request: {
        type: 'bounded_edit',
        selected_node_id: 'image-1',
        replacement_model_id: 'imagen-4-fast',
      },
    }),
    appendArchitectEvent: async () => {},
    failArchitectJob: async (id, error) => ({ id, status: 'failed', errorCode: error.code, message: error.message }),
    buildNodeSchemas: () => ({
      categories: {
        text: {
          models: {
            'text-passthrough': {
              input_schema: { prompt: {} },
            },
          },
        },
        image: {
          models: {
            'flux-schnell': {
              input_schema: { prompt: {}, aspect_ratio: {}, output_format: {} },
            },
            'imagen-4-fast': {
              input_schema: { prompt: {}, aspect_ratio: {}, output_format: {} },
            },
          },
        },
      },
    }),
    getArchitectWorkflow: async () => ({
      id: 'wf-1',
      userId: 'user-1',
      provider: 'replicate',
      name: 'Image flow',
      category: 'image',
      edges: [],
      nodes: [
        {
          id: 'image-1',
          title: 'Image',
          category: 'image',
          model: 'flux-schnell',
          input_params: { prompt: 'A product', aspect_ratio: '1:1', output_format: 'webp' },
          params: { prompt: 'A product', aspect_ratio: '1:1', output_format: 'webp' },
        },
      ],
      isTemplate: false,
      revision: 5,
    }),
    createProposalForJob: async (job, input) => ({
      id: 'proposal-model-edit',
      jobId: job.id,
      workflowId: job.workflowId,
      patch: input.patch,
      summary: input.summary,
      validation: input.validation,
      diff: {},
    }),
    completeArchitectJob: async (id) => ({ id, status: 'completed' }),
  });

  assert.equal(result.job.status, 'completed');
  assert.deepEqual(result.proposal.patch.operations, [
    {
      op: 'set_node_model',
      node_id: 'image-1',
      model_id: 'imagen-4-fast',
    },
  ]);
  assert.equal(result.proposal.validation.valid, true);
});

test('phase 3 worker adds one curated node after the selected node', async () => {
  const result = await processArchitectJob('job-insert-after', {
    markArchitectJobRunning: async (id) => ({
      id,
      userId: 'user-1',
      workflowId: 'wf-1',
      baseRevision: 6,
      operation: 'edit',
      provider: 'replicate',
      status: 'running',
      request: {
        type: 'bounded_edit',
        selected_node_id: 'image-1',
        insert_node: {
          position: 'after',
          category: 'video',
          model_id: 'seedance-2-0-mini',
          parameters: { prompt: 'Animate the product with slow camera motion.' },
        },
      },
    }),
    appendArchitectEvent: async () => {},
    failArchitectJob: async (id, error) => ({ id, status: 'failed', errorCode: error.code, message: error.message }),
    buildNodeSchemas: () => ({
      categories: {
        text: {
          models: {
            'text-passthrough': {
              input_schema: { prompt: {} },
            },
          },
        },
        image: {
          models: {
            'flux-schnell': {
              input_schema: { prompt: {}, aspect_ratio: {}, output_format: {} },
            },
          },
        },
        video: {
          models: {
            'seedance-2-0-mini': {
              input_schema: { prompt: {}, image_url: {}, duration: {}, aspect_ratio: {} },
            },
          },
        },
      },
    }),
    getArchitectWorkflow: async () => ({
      id: 'wf-1',
      userId: 'user-1',
      provider: 'replicate',
      name: 'Image flow',
      category: 'image',
      edges: [],
      nodes: [
        {
          id: 'image-1',
          title: 'Image',
          category: 'image',
          model: 'flux-schnell',
          input_params: { prompt: 'A product', aspect_ratio: '1:1', output_format: 'webp' },
          params: { prompt: 'A product', aspect_ratio: '1:1', output_format: 'webp' },
          position: { x: 100, y: 200 },
        },
      ],
      isTemplate: false,
      revision: 6,
    }),
    createProposalForJob: async (job, input) => ({
      id: 'proposal-insert-after',
      jobId: job.id,
      workflowId: job.workflowId,
      patch: input.patch,
      summary: input.summary,
      validation: input.validation,
      diff: {},
    }),
    completeArchitectJob: async (id) => ({ id, status: 'completed' }),
  });

  const addNode = result.proposal.patch.operations.find((operation) => operation.op === 'add_node');
  const connect = result.proposal.patch.operations.find((operation) => operation.op === 'connect');
  assert.equal(result.job.status, 'completed');
  assert.equal(addNode.node.category, 'video');
  assert.equal(connect.source.node_id, 'image-1');
  assert.equal(connect.source.port, 'image');
  assert.equal(connect.target.node_id, addNode.node.id);
  assert.equal(connect.target.port, 'image_url');
  assert.equal(result.proposal.validation.valid, true);
});

test('phase 3 worker adds one curated node before the selected node with selected-subgraph context', async () => {
  const result = await processArchitectJob('job-insert-before', {
    markArchitectJobRunning: async (id) => ({
      id,
      userId: 'user-1',
      workflowId: 'wf-1',
      baseRevision: 7,
      operation: 'edit',
      provider: 'replicate',
      status: 'running',
      request: {
        type: 'bounded_edit',
        selected_node_id: 'video-1',
        insert_node: {
          position: 'before',
          category: 'image',
          model_id: 'flux-schnell',
          parameters: { prompt: 'A cinematic establishing frame.' },
        },
      },
    }),
    appendArchitectEvent: async () => {},
    failArchitectJob: async (id, error) => ({ id, status: 'failed', errorCode: error.code, message: error.message }),
    buildNodeSchemas: () => ({
      categories: {
        text: {
          models: {
            'text-passthrough': {
              input_schema: { prompt: {} },
            },
          },
        },
        image: {
          models: {
            'flux-schnell': {
              input_schema: { prompt: {}, aspect_ratio: {}, output_format: {} },
            },
          },
        },
        video: {
          models: {
            'seedance-2-0-mini': {
              input_schema: { prompt: {}, image_url: {}, duration: {}, aspect_ratio: {} },
            },
          },
        },
      },
    }),
    getArchitectWorkflow: async () => ({
      id: 'wf-1',
      userId: 'user-1',
      provider: 'replicate',
      name: 'Video flow',
      category: 'video',
      edges: [
        {
          id: 'edge-prompt-video-prompt',
          source: 'prompt-1',
          target: 'video-1',
          sourceHandle: 'textOutput',
          targetHandle: 'videoInput',
        },
      ],
      nodes: [
        {
          id: 'prompt-1',
          title: 'Prompt',
          category: 'text',
          model: 'text-passthrough',
          input_params: { prompt: 'A skyline' },
          params: { prompt: 'A skyline' },
        },
        {
          id: 'video-1',
          title: 'Video',
          category: 'video',
          model: 'seedance-2-0-mini',
          input_params: { duration: 5 },
          params: { duration: 5 },
          position: { x: 500, y: 200 },
        },
      ],
      isTemplate: false,
      revision: 7,
    }),
    createProposalForJob: async (job, input) => ({
      id: 'proposal-insert-before',
      jobId: job.id,
      workflowId: job.workflowId,
      patch: input.patch,
      summary: input.summary,
      validation: input.validation,
      diff: {},
    }),
    completeArchitectJob: async (id) => ({ id, status: 'completed' }),
  });

  const addNode = result.proposal.patch.operations.find((operation) => operation.op === 'add_node');
  const connect = result.proposal.patch.operations.find((operation) => operation.op === 'connect');
  assert.equal(result.job.status, 'completed');
  assert.equal(addNode.node.category, 'image');
  assert.equal(connect.source.node_id, addNode.node.id);
  assert.equal(connect.source.port, 'image');
  assert.equal(connect.target.node_id, 'video-1');
  assert.equal(connect.target.port, 'image_url');
  assert.equal(result.proposal.summary.selected_subgraph.selected.id, 'video-1');
  assert.equal(result.proposal.summary.selected_subgraph.incoming[0].source.id, 'prompt-1');
  assert.equal(result.proposal.validation.valid, true);
});

test('phase 2 worker records progress and fails unsupported generation jobs', async () => {
  const events = [];
  const failed = [];
  const result = await processArchitectJob('job-1', {
    markArchitectJobRunning: async (id) => ({ id, status: 'running', request: {} }),
    appendArchitectEvent: async (event) => events.push(event),
    failArchitectJob: async (id, error) => {
      failed.push({ id, error });
      return { id, status: 'failed', errorCode: error.code };
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(failed[0].error.code, 'ARCHITECT_OPERATION_UNSUPPORTED');
  assert.deepEqual(events.map((event) => event.stage), ['running', 'failed']);
});
