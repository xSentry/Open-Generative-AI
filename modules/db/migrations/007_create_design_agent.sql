-- Local Design Agent runtime for non-MuAPI providers.
-- Keeps the existing creative-agent frontend contract while storing sessions,
-- messages, assets, jobs, and ordered job events locally.

create table if not exists design_agent_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth_users(id) on delete cascade,
  provider    text not null,
  name        text not null default 'New Session',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists design_agent_sessions_user_idx
  on design_agent_sessions (user_id, provider, updated_at desc);

create table if not exists design_agent_messages (
  session_id  uuid primary key references design_agent_sessions(id) on delete cascade,
  messages    jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists design_agent_assets (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references design_agent_sessions(id) on delete cascade,
  user_id       uuid not null references auth_users(id) on delete cascade,
  provider      text not null,
  asset_label   text not null,
  url           text not null,
  kind          text not null default 'image',
  source_tool   text,
  model         text,
  prompt        text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (session_id, asset_label)
);
create index if not exists design_agent_assets_session_idx
  on design_agent_assets (session_id, created_at asc);

create table if not exists design_agent_jobs (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references design_agent_sessions(id) on delete cascade,
  user_id       uuid not null references auth_users(id) on delete cascade,
  provider      text not null,
  status        text not null default 'pending'
                check (status in ('pending','processing','waiting_approval','succeeded','completed','failed','cancelled','rejected')),
  action        text not null default 'chat',
  payload       jsonb not null default '{}'::jsonb,
  approved      boolean,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists design_agent_jobs_session_idx
  on design_agent_jobs (session_id, created_at desc);
create index if not exists design_agent_jobs_pending_idx
  on design_agent_jobs (created_at asc)
  where status in ('pending','processing','waiting_approval');

create table if not exists design_agent_job_events (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references design_agent_jobs(id) on delete cascade,
  session_id  uuid not null references design_agent_sessions(id) on delete cascade,
  user_id     uuid not null references auth_users(id) on delete cascade,
  cursor      bigserial not null,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create unique index if not exists design_agent_job_events_cursor_idx
  on design_agent_job_events (job_id, cursor);
create index if not exists design_agent_job_events_session_idx
  on design_agent_job_events (session_id, cursor asc);
