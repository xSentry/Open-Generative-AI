// Data-access layer for workflow definitions. Every read/mutation is scoped by
// user_id (and provider) so ownership and the provider data-space split are
// enforced at the query level. Mirrors modules/studio/server/generationsRepo.js.
import { query } from '../../db/server/db.js';

const SELECT_COLUMNS = `
  id, user_id, provider, name, category, edges, nodes, published, is_template,
  thumbnail_key, source_workflow_id, created_at, updated_at
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// "My Workflows" — every workflow the caller owns, including ones they have
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

// Unscoped fetch by id — for background execution (the worker) where ownership
// has already been established via the run row. Mirrors runsRepo.getRun's
// optional-scope pattern.
export async function getWorkflowById(id) {
  const result = await query(
    `select ${SELECT_COLUMNS} from workflows where id = $1`,
    [id]
  );
  return mapRow(result.rows[0]);
}

// Insert or update a workflow definition. When `id` is provided and owned by the
// caller the row is updated, otherwise a new row is created (upsert semantics
// matching the MuAPI `create` endpoint).
export async function upsertWorkflow({
  id,
  userId,
  provider,
  name = 'Untitled',
  category = null,
  edges = [],
  nodes = [],
  sourceWorkflowId = null,
}) {
  const edgesJson = JSON.stringify(edges || []);
  const nodesJson = JSON.stringify(nodes || []);

  if (id) {
    // Templates are frozen: their graph can't be edited once published (so every
    // user who cloned/uses the template keeps a stable copy). Rename/delete still
    // work via their own queries. `is_template = false` scopes the update to
    // editable, owned rows.
    const updated = await query(
      `update workflows
         set name = $3, category = $4, edges = $5::jsonb, nodes = $6::jsonb,
             updated_at = now()
       where id = $1 and user_id = $2 and is_template = false
       returning ${SELECT_COLUMNS}`,
      [id, userId, name, category, edgesJson, nodesJson]
    );
    if (updated.rows[0]) return mapRow(updated.rows[0]);

    // No row updated: either the id isn't owned by this user (clone-on-save), or
    // it's an owned template. Distinguish them so we don't create a duplicate
    // when a (frozen) template happens to be saved.
    const owned = await query(
      `select ${SELECT_COLUMNS} from workflows where id = $1 and user_id = $2`,
      [id, userId]
    );
    if (owned.rows[0]) {
      // Owned template — immutable, return unchanged (no graph overwrite).
      return mapRow(owned.rows[0]);
    }
    // Not owned → fall through to insert (e.g. a clone of a template/published
    // workflow that carried its source id).
  }

  const inserted = await query(
    `insert into workflows
       (user_id, provider, name, category, edges, nodes, source_workflow_id)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
     returning ${SELECT_COLUMNS}`,
    [userId, provider, name, category, edgesJson, nodesJson, sourceWorkflowId || id || null]
  );
  return mapRow(inserted.rows[0]);
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

// Mark/unmark a workflow as a provider-wide template. Only the owner can toggle
// it. Once flagged, listTemplates() surfaces it to every user of the provider.
export async function setTemplate(id, { userId, isTemplate }) {
  const result = await query(
    `update workflows set is_template = $3, updated_at = now()
     where id = $1 and user_id = $2
     returning ${SELECT_COLUMNS}`,
    [id, userId, !!isTemplate]
  );
  return mapRow(result.rows[0]);
}

// Clone a readable workflow (owned, published or template — same provider) into a
// fresh workflow owned by the caller. The copy is always private (not a template
// or published) and records source_workflow_id for provenance.
export async function cloneWorkflow(id, { userId, provider }) {
  const source = await getWorkflow(id, { userId, provider });
  if (!source) return null;

  const inserted = await query(
    `insert into workflows
       (user_id, provider, name, category, edges, nodes, source_workflow_id)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
     returning ${SELECT_COLUMNS}`,
    [
      userId,
      provider,
      `${source.name || 'Untitled'} (Copy)`,
      source.category,
      JSON.stringify(source.edges || []),
      JSON.stringify(source.nodes || []),
      source.id,
    ]
  );
  return mapRow(inserted.rows[0]);
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


