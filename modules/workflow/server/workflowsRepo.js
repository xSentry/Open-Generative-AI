// Data-access layer for workflow definitions. Every read/mutation is scoped by
// user_id (and provider) so ownership and the provider data-space split are
// enforced at the query level. Mirrors modules/studio/server/generationsRepo.js.
import { getPool, query } from '../../db/server/db.js';
import { savedPayloadToWorkflowGraph, workflowGraphToSavedPayload } from '../../workflow-domain/workflowAdapters.js';
import { assertRevisionMatches, WorkflowRevisionConflict } from '../../workflow-domain/revisionService.js';

const SELECT_COLUMNS = `
  id, user_id, provider, name, category, edges, nodes, published, is_template,
  thumbnail_key, source_workflow_id, revision, parent_revision, revision_source,
  proposal_id, compiler_version, catalog_version, created_at, updated_at
`;

function mapRow(row) {
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

function mapRevisionRow(row) {
  if (!row) return null;
  const rawGraph = row.graph_json;
  const graph = rawGraph?.version === 'workflow-graph/v1'
    ? rawGraph
    : savedPayloadToWorkflowGraph(rawGraph || {}, { provider: rawGraph?.provider || 'replicate' });
  return {
    id: row.id,
    workflowId: row.workflow_id,
    revision: row.revision,
    parentRevision: row.parent_revision,
    source: row.source,
    proposalId: row.proposal_id,
    compilerVersion: row.compiler_version,
    catalogVersion: row.catalog_version,
    graph,
    createdAt: row.created_at,
  };
}

function revisionGraphJson(workflow) {
  return savedPayloadToWorkflowGraph(
    {
      workflow_id: workflow.id,
      revision: workflow.revision || 1,
      name: workflow.name,
      category: workflow.category,
      edges: workflow.edges || [],
      data: { nodes: workflow.nodes || [] },
    },
    { provider: workflow.provider }
  );
}

async function insertRevisionSnapshot(client, workflow) {
  await client.query(
    `insert into workflow_revisions
       (workflow_id, revision, parent_revision, source, proposal_id,
        compiler_version, catalog_version, graph_json)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     on conflict (workflow_id, revision) do nothing`,
    [
      workflow.id,
      workflow.revision || 1,
      workflow.parentRevision || null,
      workflow.revisionSource || 'manual',
      workflow.proposalId || null,
      workflow.compilerVersion || null,
      workflow.catalogVersion || null,
      JSON.stringify(revisionGraphJson(workflow)),
    ]
  );
}

// "My Workflows" - every workflow the caller owns, including ones they have
// published as templates (those stay listed here; they just become read-only).
export async function listWorkflows({ userId, provider }) {
  const result = await query(
    `select ${SELECT_COLUMNS} from workflows
     where user_id = $1 and provider = $2
     order by updated_at desc`,
    [userId, provider]
  );
  return result.rows.map(mapRow);
}

export async function listTemplates({ provider }) {
  const result = await query(
    `select ${SELECT_COLUMNS} from workflows
     where is_template = true and provider = $1
     order by updated_at desc`,
    [provider]
  );
  return result.rows.map(mapRow);
}

export async function listPublished({ provider }) {
  const result = await query(
    `select ${SELECT_COLUMNS} from workflows
     where published = true and provider = $1
     order by updated_at desc`,
    [provider]
  );
  return result.rows.map(mapRow);
}

// Fetch a single workflow. A workflow is readable if the caller owns it, if it
// is published, or if it is a template.
export async function getWorkflow(id, { userId, provider }) {
  const result = await query(
    `select ${SELECT_COLUMNS} from workflows
     where id = $1 and provider = $2
       and (user_id = $3 or published = true or is_template = true)`,
    [id, provider, userId]
  );
  return mapRow(result.rows[0]);
}

// Unscoped fetch by id - for background execution (the worker) where ownership
// has already been established via the run row.
export async function getWorkflowById(id) {
  const result = await query(
    `select ${SELECT_COLUMNS} from workflows where id = $1`,
    [id]
  );
  return mapRow(result.rows[0]);
}

// Insert or update a workflow definition. Saves are transactional and append a
// canonical graph snapshot into workflow_revisions. expectedRevision is optional
// so the existing autosave path remains compatible; proposal apply should pass it.
export async function upsertWorkflow({
  id,
  userId,
  provider,
  name = 'Untitled',
  category = null,
  edges = [],
  nodes = [],
  sourceWorkflowId = null,
  expectedRevision = null,
  revisionSource = 'manual',
  proposalId = null,
  compilerVersion = null,
  catalogVersion = null,
}) {
  const edgesJson = JSON.stringify(edges || []);
  const nodesJson = JSON.stringify(nodes || []);
  const client = await getPool().connect();

  try {
    await client.query('begin');

    if (id) {
      const currentResult = await client.query(
        `select ${SELECT_COLUMNS} from workflows where id = $1 and user_id = $2 for update`,
        [id, userId]
      );
      const current = mapRow(currentResult.rows[0]);

      if (current) {
        if (current.isTemplate) {
          await client.query('commit');
          return current;
        }

        assertRevisionMatches(current.revision || 1, expectedRevision);
        const nextRevision = (current.revision || 1) + 1;
        const updated = await client.query(
          `update workflows
             set name = $3, category = $4, edges = $5::jsonb, nodes = $6::jsonb,
                 parent_revision = revision, revision = $7, revision_source = $8,
                 proposal_id = $9, compiler_version = $10, catalog_version = $11,
                 updated_at = now()
           where id = $1 and user_id = $2 and is_template = false
           returning ${SELECT_COLUMNS}`,
          [
            id,
            userId,
            name,
            category,
            edgesJson,
            nodesJson,
            nextRevision,
            revisionSource,
            proposalId,
            compilerVersion,
            catalogVersion,
          ]
        );
        const mapped = mapRow(updated.rows[0]);
        await insertRevisionSnapshot(client, mapped);
        await client.query('commit');
        return mapped;
      }
      // Not owned: fall through to insert for clone-on-save of readable workflows.
    }

    const inserted = await client.query(
      `insert into workflows
         (user_id, provider, name, category, edges, nodes, source_workflow_id,
          revision, parent_revision, revision_source, proposal_id,
          compiler_version, catalog_version)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7,
               1, null, $8, $9, $10, $11)
       returning ${SELECT_COLUMNS}`,
      [
        userId,
        provider,
        name,
        category,
        edgesJson,
        nodesJson,
        sourceWorkflowId || id || null,
        revisionSource,
        proposalId,
        compilerVersion,
        catalogVersion,
      ]
    );
    const mapped = mapRow(inserted.rows[0]);
    await insertRevisionSnapshot(client, mapped);
    await client.query('commit');
    return mapped;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function renameWorkflow(id, { userId, name }) {
  const result = await query(
    `update workflows set name = $3, updated_at = now()
     where id = $1 and user_id = $2
     returning ${SELECT_COLUMNS}`,
    [id, userId, name]
  );
  return mapRow(result.rows[0]);
}

export async function deleteWorkflow(id, { userId }) {
  const result = await query(
    `delete from workflows where id = $1 and user_id = $2
     returning ${SELECT_COLUMNS}`,
    [id, userId]
  );
  return mapRow(result.rows[0]);
}

export async function setPublished(id, { userId, published }) {
  const result = await query(
    `update workflows set published = $3, updated_at = now()
     where id = $1 and user_id = $2
     returning ${SELECT_COLUMNS}`,
    [id, userId, !!published]
  );
  return mapRow(result.rows[0]);
}

// Mark/unmark as a provider-wide template. Only the owner can toggle it.
export async function setTemplate(id, { userId, isTemplate }) {
  const result = await query(
    `update workflows set is_template = $3, updated_at = now()
     where id = $1 and user_id = $2
     returning ${SELECT_COLUMNS}`,
    [id, userId, !!isTemplate]
  );
  return mapRow(result.rows[0]);
}

// Clone a readable workflow into a fresh private workflow owned by the caller.
export async function cloneWorkflow(id, { userId, provider }) {
  const source = await getWorkflow(id, { userId, provider });
  if (!source) return null;

  return upsertWorkflow({
    userId,
    provider,
    name: `${source.name || 'Untitled'} (Copy)`,
    category: source.category,
    edges: source.edges || [],
    nodes: source.nodes || [],
    sourceWorkflowId: source.id,
  });
}

export async function setThumbnail(id, { userId, thumbnailKey }) {
  const result = await query(
    `update workflows set thumbnail_key = $3, updated_at = now()
     where id = $1 and user_id = $2
     returning ${SELECT_COLUMNS}`,
    [id, userId, thumbnailKey]
  );
  return mapRow(result.rows[0]);
}

export async function listWorkflowRevisions(workflowId, { userId, provider }) {
  const result = await query(
    `select wr.id, wr.workflow_id, wr.revision, wr.parent_revision, wr.source,
            wr.proposal_id, wr.compiler_version, wr.catalog_version,
            wr.graph_json, wr.created_at
       from workflow_revisions wr
       join workflows w on w.id = wr.workflow_id
      where wr.workflow_id = $1 and w.provider = $2
        and (w.user_id = $3 or w.published = true or w.is_template = true)
      order by wr.revision desc`,
    [workflowId, provider, userId]
  );
  return result.rows.map(mapRevisionRow);
}

export async function getWorkflowRevision(workflowId, revision, { userId, provider }) {
  const result = await query(
    `select wr.id, wr.workflow_id, wr.revision, wr.parent_revision, wr.source,
            wr.proposal_id, wr.compiler_version, wr.catalog_version,
            wr.graph_json, wr.created_at
       from workflow_revisions wr
       join workflows w on w.id = wr.workflow_id
      where wr.workflow_id = $1 and wr.revision = $2 and w.provider = $3
        and (w.user_id = $4 or w.published = true or w.is_template = true)`,
    [workflowId, revision, provider, userId]
  );
  return mapRevisionRow(result.rows[0]);
}

export async function revertWorkflowToRevision(workflowId, revision, {
  userId,
  provider,
  expectedRevision = null,
}) {
  const target = await getWorkflowRevision(workflowId, revision, { userId, provider });
  if (!target) return null;
  const payload = workflowGraphToSavedPayload(target.graph);
  return upsertWorkflow({
    id: workflowId,
    userId,
    provider,
    name: payload.name,
    category: payload.category,
    edges: payload.edges,
    nodes: payload.data.nodes,
    expectedRevision,
    revisionSource: 'revert',
  });
}

export { WorkflowRevisionConflict };
