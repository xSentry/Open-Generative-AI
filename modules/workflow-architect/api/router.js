import * as repository from '../infrastructure/repository.js';
import { enqueueWorkflowArchitectJob } from '../infrastructure/queue.js';
import { buildNodeSchemas } from '../../workflow/server/schemas.js';
import { serializeWorkflowDef } from '../../workflow/server/serialization.js';
import { WorkflowRevisionConflict } from '../../workflow-domain/revisionService.js';
import { WorkflowPatchConflict } from '../../workflow-domain/applyPatch.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    workflow_id: job.workflowId,
    base_revision: job.baseRevision,
    operation: job.operation,
    status: job.status,
    provider: job.provider,
    catalog_version: job.catalogVersion,
    schema_version: job.schemaVersion,
    created_at: job.createdAt,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    expires_at: job.expiresAt,
    error_code: job.errorCode,
    error_message: job.errorMessageRedacted,
  };
}

function publicProposal(proposal) {
  if (!proposal) return null;
  return {
    id: proposal.id,
    job_id: proposal.jobId,
    workflow_id: proposal.workflowId,
    base_revision: proposal.baseRevision,
    patch_version: proposal.patchVersion,
    summary: proposal.summary,
    validation: proposal.validation,
    diff: proposal.diff,
    status: proposal.status,
    catalog_version: proposal.catalogVersion,
    compiler_version: proposal.compilerVersion,
    created_at: proposal.createdAt,
    accepted_at: proposal.acceptedAt,
    rejected_at: proposal.rejectedAt,
    expires_at: proposal.expiresAt,
  };
}

function fixtureProposalsEnabled(env = process.env) {
  return env.NODE_ENV !== 'production' || env.WORKFLOW_ARCHITECT_FIXTURES === 'true';
}

export async function handleWorkflowArchitect(request, { params }, method, ctx, deps = {}) {
  const impl = {
    ...repository,
    enqueueJob: enqueueWorkflowArchitectJob,
    buildNodeSchemas,
    ...deps,
  };
  const routeParams = await params;
  const path = routeParams?.path || [];
  const p = path.join('/');
  const userId = ctx.user.id;
  const provider = ctx.provider;

  try {
    if (method === 'POST' && p === 'jobs') {
      const body = await readBody(request);
      const fixtureRequest = body.fixture_proposal || null;
      if (fixtureRequest) {
        if (!fixtureProposalsEnabled()) return json({ error: 'Fixture proposals are disabled.' }, 404);
        if (!fixtureRequest.patch) return json({ error: 'fixture_proposal.patch is required' }, 400);
      }
      const job = await impl.createArchitectJob({
        userId,
        provider,
        workflowId: body.workflow_id || null,
        baseRevision: body.base_revision ?? null,
        operation: body.operation || 'edit',
        idempotencyKey: body.idempotency_key || null,
        request: fixtureRequest
          ? {
              type: 'fixture_proposal',
              patch: fixtureRequest.patch,
              summary: fixtureRequest.summary || null,
              validation: fixtureRequest.validation || null,
            }
          : {},
      });
      await impl.appendArchitectEvent?.({
        jobId: job.id,
        eventType: 'progress',
        stage: 'queued',
        payloadRedacted: {},
      });
      await impl.enqueueJob?.(job);
      return json({ job: publicJob(job) }, 202);
    }

    if (method === 'GET' && path[0] === 'jobs' && path[1] && path[2] === 'events') {
      const after = new URL(request.url).searchParams.get('after') || 0;
      const events = await impl.listArchitectEvents(path[1], { userId, afterSequence: after });
      return json({ events });
    }

    if (method === 'GET' && path[0] === 'jobs' && path[1]) {
      const job = await impl.getArchitectJob(path[1], { userId });
      if (!job) return json({ error: 'Not found' }, 404);
      const proposal = await impl.getProposalForJob?.(job.id, { userId });
      return json({ job: publicJob(job), proposal: publicProposal(proposal) });
    }

    if (method === 'POST' && p === 'fixture-proposals') {
      if (!fixtureProposalsEnabled()) return json({ error: 'Fixture proposals are disabled.' }, 404);
      const body = await readBody(request);
      if (!body.workflow_id) return json({ error: 'workflow_id is required' }, 400);
      if (!body.patch) return json({ error: 'patch is required' }, 400);
      const result = await impl.createFixtureProposal({
        userId,
        provider,
        workflowId: body.workflow_id,
        baseRevision: body.base_revision ?? null,
        patch: body.patch,
        summary: body.summary || null,
        validation: body.validation || null,
      });
      return json({
        job: publicJob(result.job),
        proposal: publicProposal(result.proposal),
      }, 201);
    }

    if (method === 'GET' && path[0] === 'proposals' && path[1]) {
      const proposal = await impl.getProposal(path[1], { userId });
      if (!proposal) return json({ error: 'Not found' }, 404);
      return json({ proposal: publicProposal(proposal) });
    }

    if (method === 'POST' && path[0] === 'proposals' && path[2] === 'reject') {
      const proposal = await impl.rejectProposal(path[1], { userId });
      if (!proposal) return json({ error: 'Not found or not pending' }, 404);
      return json({ proposal: publicProposal(proposal) });
    }

    if (method === 'POST' && path[0] === 'proposals' && path[2] === 'apply') {
      const body = await readBody(request);
      const result = await impl.applyProposalTransaction(path[1], {
        userId,
        provider,
        expectedWorkflowRevision: body.expected_workflow_revision ?? null,
        idempotencyKey: body.idempotency_key || request.headers.get('idempotency-key') || null,
        catalog: impl.buildNodeSchemas(provider),
      });
      if (!result) return json({ error: 'Not found' }, 404);
      return json({
        proposal: publicProposal(result.proposal),
        workflow: serializeWorkflowDef(result.workflow, userId),
        idempotent: !!result.idempotent,
      });
    }

    return json({ error: `Unknown workflow architect endpoint: ${method} ${p}` }, 404);
  } catch (error) {
    if (error instanceof WorkflowRevisionConflict || error?.code === 'WORKFLOW_REVISION_CONFLICT') {
      return json({
        error: {
          code: 'WORKFLOW_REVISION_CONFLICT',
          message: error.message,
          current_revision: error.currentRevision,
          proposal_revision: error.expectedRevision,
        },
      }, 409);
    }
    if (error instanceof WorkflowPatchConflict) {
      return json({
        error: {
          code: error.code,
          message: error.message,
          details: error.details || {},
        },
      }, error.code === 'PATCH_RESULT_INVALID' ? 422 : 409);
    }
    if (error?.code === 'PROPOSAL_EXPIRED' || error?.code === 'PROPOSAL_INVALID') {
      return json({ error: { code: error.code, message: error.message } }, 422);
    }
    if (error?.code === 'PROPOSAL_NOT_APPLICABLE' || error?.code === 'PROPOSAL_ALREADY_ACCEPTED') {
      return json({ error: { code: error.code, message: error.message } }, 409);
    }
    if (error?.code === 'WORKFLOW_NOT_FOUND') {
      return json({ error: 'Not found' }, 404);
    }
    console.error('[workflow-architect] handler error:', error);
    return json({ error: error.message || 'Internal error' }, 500);
  }
}
