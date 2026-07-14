import {
  appendArchitectEvent,
  completeArchitectJob,
  createProposalForJob,
  failArchitectJob,
  getArchitectWorkflow,
  markArchitectJobRunning,
} from './repository.js';
import { getUserReplicateApiKey } from '../../auth/server/users.js';
import { buildNodeSchemas } from '../../workflow/server/schemas.js';
import { applyWorkflowPatch } from '../../workflow-domain/applyPatch.js';
import { buildArchitectCapabilityCatalog } from '../domain/capabilityCatalog.js';
import { buildCreateWorkflowContext, buildWorkflowContext } from '../domain/contextBuilder.js';
import {
  buildWorkflowExplanation,
  compileBoundedEditToPatch,
  createNoopPatchForContext,
  summarizeBoundedEditProposal,
  summarizeCreateWorkflowProposal,
  compileCreateWorkflowIrToPatch,
} from '../domain/compiler.js';
import { normalizeBoundedEditRequest, normalizeCreateWorkflowIr } from '../domain/normalizer.js';
import { generateCreateWorkflowIr } from './models/replicateStructuredModel.js';

export async function processArchitectJob(jobId, deps = {}) {
  const markRunning = deps.markArchitectJobRunning || markArchitectJobRunning;
  const failJob = deps.failArchitectJob || failArchitectJob;
  const completeJob = deps.completeArchitectJob || completeArchitectJob;
  const createProposal = deps.createProposalForJob || createProposalForJob;
  const appendEvent = deps.appendArchitectEvent || appendArchitectEvent;
  const getWorkflow = deps.getArchitectWorkflow || getArchitectWorkflow;
  const buildSchemas = deps.buildNodeSchemas || buildNodeSchemas;
  const generateIr = deps.generateCreateWorkflowIr || generateCreateWorkflowIr;
  const getReplicateApiKey = deps.getUserReplicateApiKey || getUserReplicateApiKey;

  const job = await markRunning(jobId);
  if (!job) return null;

  try {
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
        compilerVersion: 'fixture-compiler/v1',
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

    if (job.request?.type === 'explain_workflow' || job.request?.type === 'validate_workflow') {
      if (!job.workflowId) {
        const error = new Error('Workflow Architect jobs require a saved workflow.');
        error.code = 'WORKFLOW_REQUIRED';
        throw error;
      }
      const fullCatalog = buildSchemas(job.provider || 'replicate');
      const workflow = await getWorkflow(job.workflowId, {
        userId: job.userId,
        provider: job.provider || 'replicate',
      });
      const context = buildWorkflowContext(job, workflow, { catalog: fullCatalog });
      const patch = createNoopPatchForContext(context);
      const summary = job.request.type === 'explain_workflow'
        ? buildWorkflowExplanation(context)
        : {
            title: context.summary.name || 'Workflow validation',
            message: context.validation.valid
              ? 'Workflow passed deterministic validation.'
              : `Workflow has ${context.validation.errors.length} validation error${context.validation.errors.length === 1 ? '' : 's'}.`,
            assumptions: [],
            warnings: context.validation.warnings || [],
            graph: {
              node_count: context.graph.nodes.length,
              edge_count: context.graph.edges.length,
            },
          };

      const proposal = await createProposal(job, {
        patch,
        summary,
        validation: context.validation,
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

    if (job.request?.type === 'bounded_edit') {
      if (!job.workflowId) {
        const error = new Error('Bounded edit jobs require a saved workflow.');
        error.code = 'WORKFLOW_REQUIRED';
        throw error;
      }
      const fullCatalog = buildSchemas(job.provider || 'replicate');
      const workflow = await getWorkflow(job.workflowId, {
        userId: job.userId,
        provider: job.provider || 'replicate',
      });
      const context = buildWorkflowContext(job, workflow, {
        catalog: fullCatalog,
        selectedNodeId: job.request.selected_node_id,
      });
      const edit = normalizeBoundedEditRequest(job.request, context);
      const patch = compileBoundedEditToPatch(edit, context);
      const nextGraph = applyWorkflowPatch(context.graph, patch, { catalog: fullCatalog });
      const validation = {
        valid: true,
        warnings: [],
        errors: [],
        graph: {
          node_count: nextGraph.nodes.length,
          edge_count: nextGraph.edges.length,
        },
      };
      const proposal = await createProposal(job, {
        patch,
        summary: summarizeBoundedEditProposal(edit, context),
        validation,
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

    if (job.request?.type !== 'create_workflow') {
      const error = new Error('Unsupported Workflow Architect job type.');
      error.code = 'ARCHITECT_OPERATION_UNSUPPORTED';
      throw error;
    }

    if (!job.workflowId) {
      const error = new Error('Create workflow jobs require a saved empty workflow.');
      error.code = 'WORKFLOW_REQUIRED';
      throw error;
    }

    const fullCatalog = buildSchemas(job.provider || 'replicate');
    const catalog = buildArchitectCapabilityCatalog(job.provider || 'replicate', fullCatalog);
    const workflow = await getWorkflow(job.workflowId, {
      userId: job.userId,
      provider: job.provider || 'replicate',
    });
    const context = buildCreateWorkflowContext(job, workflow, { catalog: fullCatalog });

    await appendEvent({
      jobId,
      eventType: 'progress',
      stage: 'calling_model',
      payloadRedacted: { catalog_version: catalog.version },
    });

    const apiKey = await getReplicateApiKey(job.userId);
    if (!apiKey) {
      const error = new Error('Missing saved user Replicate API key for Architect model calls.');
      error.code = 'ARCHITECT_MODEL_KEY_MISSING';
      throw error;
    }

    const rawIr = await generateIr({
      userRequest: context.request.prompt,
      catalog,
      apiKey,
    });

    await appendEvent({
      jobId,
      eventType: 'progress',
      stage: 'normalizing_ir',
      payloadRedacted: {},
    });

    const ir = normalizeCreateWorkflowIr(rawIr, {
      userRequest: context.request.prompt,
      catalog,
    });
    const patch = compileCreateWorkflowIrToPatch(ir, {
      provider: job.provider || 'replicate',
      baseRevision: job.baseRevision ?? context.graph.revision,
      catalog,
    });
    const nextGraph = applyWorkflowPatch(context.graph, patch, { catalog });
    const validation = {
      valid: true,
      warnings: [],
      errors: [],
      graph: {
        node_count: nextGraph.nodes.length,
        edge_count: nextGraph.edges.length,
      },
    };

    const proposal = await createProposal(job, {
      patch,
      summary: summarizeCreateWorkflowProposal(ir),
      validation,
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
  } catch (error) {
    const code = error?.code || 'ARCHITECT_JOB_FAILED';
    const failed = await failJob(jobId, {
      code,
      message: error?.message || 'Workflow Architect job failed.',
    });

    await appendEvent({
      jobId,
      eventType: 'failed',
      stage: 'failed',
      payloadRedacted: { code },
    });

    return failed;
  }
}
