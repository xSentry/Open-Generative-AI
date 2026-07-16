-- Workflow Architect proposal infrastructure.
--
-- Forward migration for the revised Architect design. Do not edit
-- 005_create_workflow_architect_requests.sql because it has already run in
-- deployed environments. This migration removes the legacy raw prompt/result
-- request table and replaces it with jobs, replayable progress events, and
-- immutable proposals.

drop table if exists workflow_architect_requests;

create table if not exists workflow_architect_jobs (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth_users(id) on delete cascade,
  workflow_id              uuid references workflows(id) on delete cascade,
  base_revision            integer,
  operation                text not null
                           check (operation in ('create', 'edit', 'validate', 'explain')),
  status                   text not null default 'queued'
                           check (status in (
                             'queued',
                             'running',
                             'waiting_for_user',
                             'completed',
                             'failed',
                             'cancelled',
                             'expired',
                             'superseded'
                           )),
  provider                 text not null,
  catalog_version          text not null,
  schema_version           text not null,
  idempotency_key          text,
  request_json             jsonb not null default '{}'::jsonb,
  attempt_count            integer not null default 0,
  model_call_count         integer not null default 0,
  error_code               text,
  error_message_redacted   text,
  created_at               timestamptz not null default now(),
  started_at               timestamptz,
  completed_at             timestamptz,
  expires_at               timestamptz not null
);

create unique index if not exists workflow_architect_jobs_idempotency_idx
  on workflow_architect_jobs (user_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists workflow_architect_jobs_user_idx
  on workflow_architect_jobs (user_id, created_at desc);

create index if not exists workflow_architect_jobs_status_idx
  on workflow_architect_jobs (status, created_at);

create table if not exists workflow_architect_events (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null references workflow_architect_jobs(id) on delete cascade,
  sequence           integer not null,
  event_type         text not null,
  stage              text,
  payload_redacted   jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (job_id, sequence)
);

create index if not exists workflow_architect_events_job_idx
  on workflow_architect_events (job_id, sequence);

create table if not exists workflow_architect_proposals (
  id                        uuid primary key default gen_random_uuid(),
  job_id                    uuid not null references workflow_architect_jobs(id) on delete cascade,
  user_id                   uuid not null references auth_users(id) on delete cascade,
  workflow_id               uuid references workflows(id) on delete cascade,
  base_revision             integer,
  patch_version             text not null,
  patch_json                jsonb not null,
  summary_json              jsonb not null default '{}'::jsonb,
  validation_json           jsonb not null default '{"valid":true,"warnings":[],"errors":[]}'::jsonb,
  diff_json                 jsonb not null default '{}'::jsonb,
  status                    text not null default 'pending'
                            check (status in ('pending', 'accepted', 'rejected', 'expired', 'conflicted')),
  catalog_version           text not null,
  compiler_version          text not null,
  apply_idempotency_key     text,
  created_at                timestamptz not null default now(),
  accepted_at               timestamptz,
  rejected_at               timestamptz,
  expires_at                timestamptz not null
);

create index if not exists workflow_architect_proposals_user_idx
  on workflow_architect_proposals (user_id, created_at desc);

create index if not exists workflow_architect_proposals_job_idx
  on workflow_architect_proposals (job_id);

create unique index if not exists workflow_architect_proposals_apply_idempotency_idx
  on workflow_architect_proposals (user_id, apply_idempotency_key)
  where apply_idempotency_key is not null;
