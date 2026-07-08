-- Phase 5 — AI workflow "architect" requests.
-- The architect turns a natural-language prompt into a workflow graph via an
-- LLM. Each request is persisted so the UI can poll poll-architect/{id}/result
-- (the request row is the single source of truth, robust across instances).
create table if not exists workflow_architect_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth_users(id) on delete cascade,
  provider      text not null,
  workflow_id   uuid,                                  -- optional target workflow
  prompt        text not null,
  status        text not null default 'processing'
                check (status in ('processing','completed','failed')),
  result        jsonb,                                 -- { message, suggestions, workflow:{nodes,edges} }
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists workflow_architect_user_idx
  on workflow_architect_requests (user_id, created_at desc);

