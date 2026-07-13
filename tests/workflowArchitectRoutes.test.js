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
  assert.deepEqual(calls[0][1].request, {});
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

test('phase 1 worker records progress and fails non-fixture generation jobs', async () => {
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
  assert.equal(failed[0].error.code, 'ARCHITECT_GENERATION_NOT_IMPLEMENTED');
  assert.deepEqual(events.map((event) => event.stage), ['running', 'generation_not_enabled']);
});
