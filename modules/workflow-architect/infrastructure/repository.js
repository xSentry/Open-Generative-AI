import { getPool, query } from '../../db/server/db.js';
import { applyWorkflowPatch, WorkflowPatchConflict } from '../../workflow-domain/applyPatch.js';
import { savedPayloadToWorkflowGraph, workflowGraphToSavedPayload } from '../../workflow-domain/workflowAdapters.js';
import { WorkflowRevisionConflict } from '../../workflow-domain/revisionService.js';
import { WORKFLOW_PATCH_VERSION } from '../../workflow-domain/patchSchema.js';
import { summarizePatchDiff, defaultProposalSummary } from '../domain/proposalDiff.js';

export const ARCHITECT_SCHEMA_VERSION = 'workflow-architect/v1';
export const ARCHITECT_COMPILER_VERSION = 'workflow-architect-compiler/v1';
export const DEFAULT_CATALOG_VERSION = 'replicate-architect-catalog/v1';

const JOB_COLUMNS = `
  id, user_id, workflow_id, conversation_id, parent_message_id,
  base_revision, operation, status, provider,
  catalog_version, schema_version, idempotency_key, request_json, attempt_count,
  model_call_count, error_code, error_message_redacted, created_at,
  started_at, completed_at, expires_at
`;

const PROPOSAL_COLUMNS = `
  id, job_id, user_id, workflow_id, base_revision, patch_version, patch_json,
  summary_json, validation_json, diff_json, status, catalog_version,
  compiler_version, apply_idempotency_key, created_at, accepted_at,
  rejected_at, expires_at
`;

const WORKFLOW_COLUMNS = `
  id, user_id, provider, name, category, edges, nodes, published, is_template,
  thumbnail_key, source_workflow_id, revision, parent_revision, revision_source,
  proposal_id, compiler_version, catalog_version, created_at, updated_at
`;

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    conversationId: row.conversation_id,
    parentMessageId: row.parent_message_id,
    baseRevision: row.base_revision,
    operation: row.operation,
    status: row.status,
    provider: row.provider,
    catalogVersion: row.catalog_version,
    schemaVersion: row.schema_version,
    idempotencyKey: row.idempotency_key,
    request: row.request_json || {},
    attemptCount: row.attempt_count,
    modelCallCount: row.model_call_count,
    errorCode: row.error_code,
    errorMessageRedacted: row.error_message_redacted,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

function mapConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    provider: row.provider,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role,
    contentRedacted: row.content_redacted,
    jobId: row.job_id,
    proposalId: row.proposal_id,
    metadataRedacted: row.metadata_redacted || {},
    createdAt: row.created_at,
  };
}

function mapProposal(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    baseRevision: row.base_revision,
    patchVersion: row.patch_version,
    patch: row.patch_json,
    summary: row.summary_json || {},
    validation: row.validation_json || { valid: true, warnings: [], errors: [] },
    diff: row.diff_json || {},
    status: row.status,
    catalogVersion: row.catalog_version,
    compilerVersion: row.compiler_version,
    applyIdempotencyKey: row.apply_idempotency_key,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    rejectedAt: row.rejected_at,
    expiresAt: row.expires_at,
  };
}

function mapWorkflow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    name: row.name,
    category: row.category,
    edges: row.edges || [],
    nodes: row.nodes || [],
    published: row.published,
    isTemplate: row.is_template,
    thumbnailKey: row.thumbnail_key,
    sourceWorkflowId: row.source_workflow_id,
    revision: row.revision || 1,
    parentRevision: row.parent_revision,
    revisionSource: row.revision_source || 'manual',
    proposalId: row.proposal_id,
    compilerVersion: row.compiler_version,
    catalogVersion: row.catalog_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function expiresAt(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function workflowToGraph(workflow, catalog) {
  return savedPayloadToWorkflowGraph(
    {
      workflow_id: workflow.id,
      revision: workflow.revision || 1,
      name: workflow.name,
      category: workflow.category,
      edges: workflow.edges || [],
      data: { nodes: workflow.nodes || [] },
    },
    { provider: workflow.provider, catalog }
  );
}

async function nextProposalRevisionForJob(jobId, userId) {
  const result = await query(
    `select count(*) + 1 as proposal_revision
       from workflow_architect_proposals
      where job_id = $1 and user_id = $2`,
    [jobId, userId]
  );
  return Number(result.rows[0]?.proposal_revision || 1);
}

async function nextEventSequence(client, jobId) {
  const result = await client.query(
    'select coalesce(max(sequence), 0) + 1 as sequence from workflow_architect_events where job_id = $1',
    [jobId]
  );
  return Number(result.rows[0]?.sequence || 1);
}

export async function createArchitectJob({
  userId,
  workflowId = null,
  conversationId = null,
  parentMessageId = null,
  baseRevision = null,
  operation = 'edit',
  provider = 'replicate',
  catalogVersion = DEFAULT_CATALOG_VERSION,
  schemaVersion = ARCHITECT_SCHEMA_VERSION,
  idempotencyKey = null,
  request = {},
  status = 'queued',
  expiresAt: explicitExpiresAt = null,
}) {
  const result = await query(
    `insert into workflow_architect_jobs
       (user_id, workflow_id, conversation_id, parent_message_id,
        base_revision, operation, status, provider,
        catalog_version, schema_version, idempotency_key, request_json, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
     on conflict (user_id, idempotency_key) where idempotency_key is not null
     do update set idempotency_key = excluded.idempotency_key
     returning ${JOB_COLUMNS}`,
    [
      userId,
      workflowId,
      conversationId,
      parentMessageId,
      baseRevision,
      operation,
      status,
      provider,
      catalogVersion,
      schemaVersion,
      idempotencyKey,
      JSON.stringify(request || {}),
      explicitExpiresAt || expiresAt(),
    ]
  );
  return mapJob(result.rows[0]);
}

export async function ensureArchitectConversation({
  userId,
  workflowId = null,
  provider = 'replicate',
  conversationId = null,
  title = null,
}) {
  if (conversationId) {
    const existing = await query(
      `select id, user_id, workflow_id, provider, title, status, created_at, updated_at
         from workflow_architect_conversations
        where id = $1 and user_id = $2 and status = 'active'`,
      [conversationId, userId]
    );
    if (existing.rows[0]) return mapConversation(existing.rows[0]);
  }

  const result = await query(
    `insert into workflow_architect_conversations
       (user_id, workflow_id, provider, title)
     values ($1, $2, $3, $4)
     returning id, user_id, workflow_id, provider, title, status, created_at, updated_at`,
    [userId, workflowId, provider, title || 'Workflow Architect']
  );
  return mapConversation(result.rows[0]);
}

export async function appendArchitectMessage({
  conversationId,
  userId,
  role,
  contentRedacted = '',
  jobId = null,
  proposalId = null,
  metadataRedacted = {},
}) {
  const result = await query(
    `insert into workflow_architect_messages
       (conversation_id, user_id, role, content_redacted, job_id, proposal_id, metadata_redacted)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     returning id, conversation_id, user_id, role, content_redacted, job_id,
       proposal_id, metadata_redacted, created_at`,
    [
      conversationId,
      userId,
      role,
      contentRedacted || '',
      jobId,
      proposalId,
      JSON.stringify(metadataRedacted || {}),
    ]
  );
  await query(
    `update workflow_architect_conversations
        set updated_at = now()
      where id = $1 and user_id = $2`,
    [conversationId, userId]
  );
  return mapMessage(result.rows[0]);
}

export async function listArchitectConversations({ userId, workflowId = null, limit = 10 }) {
  const params = [userId, Math.min(Math.max(Number(limit) || 10, 1), 50)];
  const workflowFilter = workflowId ? 'and workflow_id = $3' : '';
  if (workflowId) params.push(workflowId);
  const result = await query(
    `select id, user_id, workflow_id, provider, title, status, created_at, updated_at
       from workflow_architect_conversations
      where user_id = $1 and status = 'active' ${workflowFilter}
      order by updated_at desc
      limit $2`,
    params
  );
  return result.rows.map(mapConversation);
}

export async function listArchitectMessages(conversationId, { userId, limit = 50 }) {
  const result = await query(
    `select id, conversation_id, user_id, role, content_redacted, job_id,
            proposal_id, metadata_redacted, created_at
       from workflow_architect_messages
      where conversation_id = $1 and user_id = $2
      order by created_at asc
      limit $3`,
    [conversationId, userId, Math.min(Math.max(Number(limit) || 50, 1), 100)]
  );
  return result.rows.map(mapMessage);
}

export async function archiveArchitectConversation(conversationId, { userId }) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const existingResult = await client.query(
      `select id, user_id, workflow_id, provider, title, status, created_at, updated_at
         from workflow_architect_conversations
        where id = $1 and user_id = $2
        for update`,
      [conversationId, userId]
    );
    const conversation = mapConversation(existingResult.rows[0]);
    if (!conversation) {
      await client.query('commit');
      return null;
    }

    const jobIdsResult = await client.query(
      `select id
         from workflow_architect_jobs
        where conversation_id = $1 and user_id = $2`,
      [conversationId, userId]
    );
    const jobIds = jobIdsResult.rows.map((row) => row.id);

    if (jobIds.length) {
      await client.query(
        `delete from workflow_architect_proposals
          where user_id = $1 and job_id = any($2::uuid[])`,
        [userId, jobIds]
      );
      await client.query(
        `delete from workflow_architect_events
          where job_id = any($1::uuid[])`,
        [jobIds]
      );
      await client.query(
        `update workflow_architect_jobs
            set conversation_id = null, parent_message_id = null
          where user_id = $1 and id = any($2::uuid[])`,
        [userId, jobIds]
      );
    }

    await client.query(
      `delete from workflow_architect_conversations
        where id = $1 and user_id = $2`,
      [conversationId, userId]
    );

    await client.query('commit');
    return conversation;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listArchitectHistory({ userId, workflowId = null, limit = 20 }) {
  const params = [userId, Math.min(Math.max(Number(limit) || 20, 1), 50)];
  const workflowFilter = workflowId ? 'and j.workflow_id = $3' : '';
  if (workflowId) params.push(workflowId);
  const result = await query(
    `select
       j.id as job_id,
       j.workflow_id,
       j.conversation_id,
       j.base_revision,
       j.operation,
       j.status as job_status,
       j.request_json,
       j.created_at as job_created_at,
       j.completed_at as job_completed_at,
       p.id as proposal_id,
       p.status as proposal_status,
       p.summary_json,
       p.validation_json,
       p.diff_json,
       p.created_at as proposal_created_at
     from workflow_architect_jobs j
     left join lateral (
       select *
         from workflow_architect_proposals p
        where p.job_id = j.id and p.user_id = j.user_id
        order by p.created_at desc
        limit 1
     ) p on true
     where j.user_id = $1 ${workflowFilter}
     order by j.created_at desc
     limit $2`,
    params
  );
  return result.rows.map((row) => ({
    job: {
      id: row.job_id,
      workflowId: row.workflow_id,
      conversationId: row.conversation_id,
      baseRevision: row.base_revision,
      operation: row.operation,
      status: row.job_status,
      request: row.request_json || {},
      createdAt: row.job_created_at,
      completedAt: row.job_completed_at,
    },
    proposal: row.proposal_id
      ? {
          id: row.proposal_id,
          status: row.proposal_status,
          summary: row.summary_json || {},
          validation: row.validation_json || {},
          diff: row.diff_json || {},
          createdAt: row.proposal_created_at,
        }
      : null,
  }));
}

export async function getArchitectJob(id, { userId }) {
  const result = await query(
    `select ${JOB_COLUMNS} from workflow_architect_jobs where id = $1 and user_id = $2`,
    [id, userId]
  );
  return mapJob(result.rows[0]);
}

export async function getArchitectWorkflow(id, { userId, provider }) {
  const result = await query(
    `select ${WORKFLOW_COLUMNS}
       from workflows
      where id = $1 and user_id = $2 and provider = $3`,
    [id, userId, provider]
  );
  return mapWorkflow(result.rows[0]);
}

export async function markArchitectJobRunning(id) {
  const result = await query(
    `update workflow_architect_jobs
        set status = 'running', started_at = coalesce(started_at, now()),
            attempt_count = attempt_count + 1
      where id = $1 and status = 'queued'
      returning ${JOB_COLUMNS}`,
    [id]
  );
  return mapJob(result.rows[0]);
}

export async function failArchitectJob(id, { code = 'ARCHITECT_JOB_FAILED', message = 'Architect job failed.' } = {}) {
  const result = await query(
    `update workflow_architect_jobs
        set status = 'failed', completed_at = now(),
            error_code = $2, error_message_redacted = $3
      where id = $1 and status in ('queued', 'running')
      returning ${JOB_COLUMNS}`,
    [id, code, message]
  );
  return mapJob(result.rows[0]);
}

export async function completeArchitectJob(id) {
  const result = await query(
    `update workflow_architect_jobs
        set status = 'completed', completed_at = now()
      where id = $1 and status in ('queued', 'running')
      returning ${JOB_COLUMNS}`,
    [id]
  );
  return mapJob(result.rows[0]);
}

export async function appendArchitectEvent({
  jobId,
  eventType,
  stage = null,
  payloadRedacted = {},
}) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const sequence = await nextEventSequence(client, jobId);
    const result = await client.query(
      `insert into workflow_architect_events
         (job_id, sequence, event_type, stage, payload_redacted)
       values ($1, $2, $3, $4, $5::jsonb)
       returning id, job_id, sequence, event_type, stage, payload_redacted, created_at`,
      [jobId, sequence, eventType, stage, JSON.stringify(payloadRedacted || {})]
    );
    await client.query('commit');
    return result.rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function listArchitectEvents(jobId, { userId, afterSequence = 0 }) {
  const result = await query(
    `select e.id, e.job_id, e.sequence, e.event_type, e.stage, e.payload_redacted, e.created_at
       from workflow_architect_events e
       join workflow_architect_jobs j on j.id = e.job_id
      where e.job_id = $1 and j.user_id = $2 and e.sequence > $3
      order by e.sequence asc`,
    [jobId, userId, Number(afterSequence || 0)]
  );
  return result.rows;
}

export async function clearArchitectEventsForJob(jobId, { userId }) {
  const result = await query(
    `delete from workflow_architect_events e
      using workflow_architect_jobs j
      where e.job_id = j.id
        and e.job_id = $1
        and j.user_id = $2`,
    [jobId, userId]
  );
  return result.rowCount || 0;
}

export async function createFixtureProposal({
  userId,
  workflowId,
  baseRevision,
  provider = 'replicate',
  patch,
  summary = null,
  validation = null,
  catalogVersion = DEFAULT_CATALOG_VERSION,
  compilerVersion = ARCHITECT_COMPILER_VERSION,
  expiresAt: explicitExpiresAt = null,
}) {
  const client = await getPool().connect();
  const patchVersion = patch?.version || WORKFLOW_PATCH_VERSION;
  const proposalRevision = 1;
  const diff = summarizePatchDiff(patch, { proposalRevision });
  const proposalSummary = { ...(summary || defaultProposalSummary(patch)), proposal_revision: proposalRevision, diff };
  const proposalValidation = validation || { valid: true, warnings: [], errors: [] };

  try {
    await client.query('begin');
    const jobResult = await client.query(
      `insert into workflow_architect_jobs
         (user_id, workflow_id, base_revision, operation, status, provider,
          catalog_version, schema_version, expires_at, completed_at)
       values ($1, $2, $3, 'edit', 'completed', $4, $5, $6, $7, now())
       returning ${JOB_COLUMNS}`,
      [
        userId,
        workflowId,
        baseRevision,
        provider,
        catalogVersion,
        ARCHITECT_SCHEMA_VERSION,
        explicitExpiresAt || expiresAt(),
      ]
    );
    const job = mapJob(jobResult.rows[0]);

    await client.query(
      `insert into workflow_architect_events
         (job_id, sequence, event_type, stage, payload_redacted)
       values
         ($1, 1, 'progress', 'fixture_created', '{}'::jsonb),
         ($1, 2, 'proposal', 'completed', $2::jsonb)`,
      [job.id, JSON.stringify({ diff })]
    );

    const proposalResult = await client.query(
      `insert into workflow_architect_proposals
         (job_id, user_id, workflow_id, base_revision, patch_version, patch_json,
          summary_json, validation_json, diff_json, catalog_version,
          compiler_version, expires_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)
       returning ${PROPOSAL_COLUMNS}`,
      [
        job.id,
        userId,
        workflowId,
        baseRevision,
        patchVersion,
        JSON.stringify(patch),
        JSON.stringify(proposalSummary),
        JSON.stringify(proposalValidation),
        JSON.stringify(diff),
        catalogVersion,
        compilerVersion,
        explicitExpiresAt || expiresAt(),
      ]
    );

    await client.query('commit');
    return { job, proposal: mapProposal(proposalResult.rows[0]) };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function createProposalForJob(job, {
  patch,
  summary = null,
  validation = null,
  compilerVersion = ARCHITECT_COMPILER_VERSION,
  expiresAt: explicitExpiresAt = null,
}) {
  const patchVersion = patch?.version || WORKFLOW_PATCH_VERSION;
  const proposalRevision = await nextProposalRevisionForJob(job.id, job.userId);
  const diff = summarizePatchDiff(patch, { proposalRevision });
  const proposalSummary = { ...(summary || defaultProposalSummary(patch)), proposal_revision: proposalRevision, diff };
  const proposalValidation = validation || { valid: true, warnings: [], errors: [] };

  const result = await query(
    `insert into workflow_architect_proposals
       (job_id, user_id, workflow_id, base_revision, patch_version, patch_json,
        summary_json, validation_json, diff_json, catalog_version,
        compiler_version, expires_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)
     on conflict do nothing
     returning ${PROPOSAL_COLUMNS}`,
    [
      job.id,
      job.userId,
      job.workflowId,
      job.baseRevision,
      patchVersion,
      JSON.stringify(patch),
      JSON.stringify(proposalSummary),
      JSON.stringify(proposalValidation),
      JSON.stringify(diff),
      job.catalogVersion || DEFAULT_CATALOG_VERSION,
      compilerVersion,
      explicitExpiresAt || expiresAt(),
    ]
  );

  if (result.rows[0]) return mapProposal(result.rows[0]);
  return getProposalForJob(job.id, { userId: job.userId });
}

export async function getProposalForJob(jobId, { userId }) {
  const result = await query(
    `select ${PROPOSAL_COLUMNS}
       from workflow_architect_proposals
      where job_id = $1 and user_id = $2
      order by created_at desc
      limit 1`,
    [jobId, userId]
  );
  return mapProposal(result.rows[0]);
}

export async function getProposal(id, { userId }) {
  const result = await query(
    `select ${PROPOSAL_COLUMNS} from workflow_architect_proposals where id = $1 and user_id = $2`,
    [id, userId]
  );
  return mapProposal(result.rows[0]);
}

export async function rejectProposal(id, { userId }) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update workflow_architect_proposals
          set status = 'rejected', rejected_at = now()
        where id = $1 and user_id = $2 and status = 'pending'
        returning ${PROPOSAL_COLUMNS}`,
      [id, userId]
    );
    const proposal = mapProposal(result.rows[0]);
    if (!proposal) {
      await client.query('commit');
      return null;
    }

    await client.query(
      `update workflow_architect_messages
          set proposal_id = null
        where proposal_id = $1 and user_id = $2`,
      [proposal.id, userId]
    );
    await client.query(
      `delete from workflow_architect_events where job_id = $1`,
      [proposal.jobId]
    );
    await client.query(
      `delete from workflow_architect_proposals where id = $1 and user_id = $2`,
      [proposal.id, userId]
    );

    await client.query('commit');
    return proposal;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function applyProposalTransaction(id, {
  userId,
  provider,
  expectedWorkflowRevision,
  idempotencyKey = null,
  catalog = null,
}) {
  const client = await getPool().connect();

  try {
    await client.query('begin');

    const proposalResult = await client.query(
      `select ${PROPOSAL_COLUMNS}
         from workflow_architect_proposals
        where id = $1 and user_id = $2
        for update`,
      [id, userId]
    );
    const proposal = mapProposal(proposalResult.rows[0]);
    if (!proposal) {
      await client.query('commit');
      return null;
    }

    if (proposal.status === 'accepted') {
      if (!idempotencyKey || proposal.applyIdempotencyKey !== idempotencyKey) {
        throw Object.assign(new Error('Proposal has already been accepted.'), { code: 'PROPOSAL_ALREADY_ACCEPTED' });
      }
      const workflowResult = await client.query(
        `select ${WORKFLOW_COLUMNS} from workflows where id = $1 and user_id = $2`,
        [proposal.workflowId, userId]
      );
      await client.query('commit');
      return { proposal, workflow: mapWorkflow(workflowResult.rows[0]), idempotent: true };
    }

    if (proposal.status !== 'pending') {
      throw Object.assign(new Error(`Proposal is ${proposal.status}.`), { code: 'PROPOSAL_NOT_APPLICABLE' });
    }
    if (proposal.expiresAt && new Date(proposal.expiresAt).getTime() <= Date.now()) {
      await client.query(
        `update workflow_architect_proposals set status = 'expired' where id = $1`,
        [proposal.id]
      );
      throw Object.assign(new Error('Proposal expired.'), { code: 'PROPOSAL_EXPIRED' });
    }
    if (!proposal.validation?.valid) {
      throw Object.assign(new Error('Proposal validation failed.'), { code: 'PROPOSAL_INVALID' });
    }

    const workflowResult = await client.query(
      `select ${WORKFLOW_COLUMNS}
         from workflows
        where id = $1 and user_id = $2 and provider = $3
        for update`,
      [proposal.workflowId, userId, provider]
    );
    const workflow = mapWorkflow(workflowResult.rows[0]);
    if (!workflow || workflow.isTemplate) {
      throw Object.assign(new Error('Editable workflow not found.'), { code: 'WORKFLOW_NOT_FOUND' });
    }

    const expected = expectedWorkflowRevision ?? proposal.baseRevision;
    if (expected != null && workflow.revision !== expected) {
      await client.query(
        `update workflow_architect_proposals set status = 'conflicted' where id = $1`,
        [proposal.id]
      );
      await client.query('commit');
      throw new WorkflowRevisionConflict(workflow.revision, expected);
    }

    const currentGraph = workflowToGraph(workflow, catalog);
    const nextGraph = applyWorkflowPatch(currentGraph, proposal.patch, { catalog });
    const nextRevision = (workflow.revision || 1) + 1;
    const saved = workflowGraphToSavedPayload({
      ...nextGraph,
      revision: nextRevision,
      workflowId: workflow.id,
    });

    const updatedResult = await client.query(
      `update workflows
          set name = $3, category = $4, edges = $5::jsonb, nodes = $6::jsonb,
              parent_revision = revision, revision = $7, revision_source = 'architect',
              proposal_id = null, compiler_version = $8, catalog_version = $9,
              updated_at = now()
        where id = $1 and user_id = $2 and is_template = false
        returning ${WORKFLOW_COLUMNS}`,
      [
        workflow.id,
        userId,
        saved.name,
        saved.category,
        JSON.stringify(saved.edges || []),
        JSON.stringify(saved.data?.nodes || []),
        nextRevision,
        proposal.compilerVersion,
        proposal.catalogVersion,
      ]
    );
    const updatedWorkflow = mapWorkflow(updatedResult.rows[0]);

    const revisionGraph = workflowToGraph(updatedWorkflow, catalog);
    await client.query(
      `insert into workflow_revisions
         (workflow_id, revision, parent_revision, source, proposal_id,
          compiler_version, catalog_version, graph_json)
       values ($1, $2, $3, 'architect', null, $4, $5, $6::jsonb)
       on conflict (workflow_id, revision) do nothing`,
      [
        updatedWorkflow.id,
        updatedWorkflow.revision,
        updatedWorkflow.parentRevision,
        proposal.compilerVersion,
        proposal.catalogVersion,
        JSON.stringify(revisionGraph),
      ]
    );

    const acceptedResult = await client.query(
      `update workflow_architect_proposals
          set status = 'accepted', accepted_at = now(), apply_idempotency_key = $2
        where id = $1
        returning ${PROPOSAL_COLUMNS}`,
      [proposal.id, idempotencyKey]
    );
    const acceptedProposal = mapProposal(acceptedResult.rows[0]);

    await client.query(
      `update workflow_architect_messages
          set proposal_id = null
        where proposal_id = $1 and user_id = $2`,
      [proposal.id, userId]
    );
    await client.query(
      `delete from workflow_architect_events where job_id = $1`,
      [proposal.jobId]
    );
    await client.query(
      `delete from workflow_architect_proposals where id = $1 and user_id = $2`,
      [proposal.id, userId]
    );

    await client.query('commit');
    return {
      proposal: acceptedProposal,
      workflow: updatedWorkflow,
      idempotent: false,
    };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    if (error instanceof WorkflowPatchConflict) throw error;
    throw error;
  } finally {
    client.release();
  }
}
