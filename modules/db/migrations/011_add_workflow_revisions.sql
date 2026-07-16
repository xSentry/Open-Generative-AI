-- Workflow revisions for server-side proposal application and revert.

alter table workflows
  add column if not exists revision integer not null default 1,
  add column if not exists parent_revision integer,
  add column if not exists revision_source text not null default 'manual'
    check (revision_source in ('manual', 'architect', 'revert')),
  add column if not exists proposal_id uuid,
  add column if not exists compiler_version text,
  add column if not exists catalog_version text;

create table if not exists workflow_revisions (
  id               uuid primary key default gen_random_uuid(),
  workflow_id      uuid not null references workflows(id) on delete cascade,
  revision         integer not null,
  parent_revision  integer,
  source           text not null check (source in ('manual', 'architect', 'revert')),
  proposal_id      uuid,
  compiler_version text,
  catalog_version  text,
  graph_json       jsonb not null,
  created_at       timestamptz not null default now(),
  unique (workflow_id, revision)
);

create index if not exists workflow_revisions_workflow_idx
  on workflow_revisions (workflow_id, revision desc);

insert into workflow_revisions
  (workflow_id, revision, parent_revision, source, proposal_id,
   compiler_version, catalog_version, graph_json, created_at)
select
  id,
  revision,
  parent_revision,
  revision_source,
  proposal_id,
  compiler_version,
  catalog_version,
  jsonb_build_object(
    'workflow_id', id,
    'provider', provider,
    'revision', revision,
    'name', name,
    'category', category,
    'edges', edges,
    'data', jsonb_build_object('nodes', nodes)
  ),
  updated_at
from workflows
on conflict (workflow_id, revision) do nothing;
