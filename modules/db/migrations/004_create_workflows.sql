-- Self-hosted workflow engine: definitions, runs and per-node runs.
-- Mirrors the shape MuAPI exposes so the workflow UI keeps working unchanged.

-- Workflow definitions (graph = nodes + edges), scoped by user and provider so
-- switching providers switches the visible data space (see plan §2/§9).
create table if not exists workflows (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth_users(id) on delete cascade,
  provider           text not null,                       -- 'replicate' / custom / ...
  name               text not null default 'Untitled',
  category           text,
  edges              jsonb not null default '[]'::jsonb,
  nodes              jsonb not null default '[]'::jsonb,   -- corresponds to data.nodes
  published          boolean not null default false,
  is_template        boolean not null default false,
  thumbnail_key      text,
  source_workflow_id uuid,                                  -- for "duplicate"
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists workflows_user_idx on workflows (user_id, updated_at desc);
create index if not exists workflows_published_idx on workflows (published) where published;

-- One execution run of an entire graph.
create table if not exists workflow_runs (
  id            uuid primary key default gen_random_uuid(),
  workflow_id   uuid not null references workflows(id) on delete cascade,
  user_id       uuid not null references auth_users(id) on delete cascade,
  status        text not null default 'processing'
                check (status in ('processing','running','succeeded','completed','failed')),
  inputs        jsonb not null default '{}'::jsonb,        -- for api-execute
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists workflow_runs_workflow_idx on workflow_runs (workflow_id, created_at desc);

-- Result of a single node within a run (history -> possibly several rows per node).
create table if not exists workflow_node_runs (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references workflow_runs(id) on delete cascade,
  node_id       text not null,                             -- graph node id (string, as in UI)
  status        text not null default 'processing',
  model         text,
  params        jsonb not null default '{}'::jsonb,
  result        jsonb,                                     -- {id, outputs:[{type,value,id}]}
  provider_ref  text,                                      -- prediction id at the provider
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists workflow_node_runs_run_idx
  on workflow_node_runs (run_id, node_id, created_at asc);

