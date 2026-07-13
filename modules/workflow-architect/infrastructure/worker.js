import {
  appendArchitectEvent,
  completeArchitectJob,
  createProposalForJob,
  failArchitectJob,
  markArchitectJobRunning,
} from './repository.js';

export async function processArchitectJob(jobId, deps = {}) {
  const markRunning = deps.markArchitectJobRunning || markArchitectJobRunning;
  const failJob = deps.failArchitectJob || failArchitectJob;
  const completeJob = deps.completeArchitectJob || completeArchitectJob;
  const createProposal = deps.createProposalForJob || createProposalForJob;
  const appendEvent = deps.appendArchitectEvent || appendArchitectEvent;

  const job = await markRunning(jobId);
  if (!job) return null;

  await appendEvent({
    jobId,
    eventType: 'progress',
    stage: 'running',
    payloadRedacted: {},
  });

  if (job.request?.type === 'fixture_proposal') {
    await appendEvent({
      jobId,
      eventType: 'progress',
      stage: 'compiling_fixture',
      payloadRedacted: {},
    });

    const proposal = await createProposal(job, {
      patch: job.request.patch,
      summary: job.request.summary || null,
      validation: job.request.validation || null,
    });

    const completed = await completeJob(jobId);
    await appendEvent({
      jobId,
      eventType: 'proposal',
      stage: 'completed',
      payloadRedacted: {
        proposal_id: proposal?.id,
        diff: proposal?.diff || {},
      },
    });

    return { job: completed, proposal };
  }

  const failed = await failJob(jobId, {
    code: 'ARCHITECT_GENERATION_NOT_IMPLEMENTED',
    message: 'Workflow Architect generation is not enabled in Phase 1. Use fixture proposals for apply/reject testing.',
  });

  await appendEvent({
    jobId,
    eventType: 'failed',
    stage: 'generation_not_enabled',
    payloadRedacted: { code: 'ARCHITECT_GENERATION_NOT_IMPLEMENTED' },
  });

  return failed;
}
