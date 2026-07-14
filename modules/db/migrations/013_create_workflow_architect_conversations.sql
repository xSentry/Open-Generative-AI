-- Workflow Architect conversational UX persistence.
--
-- Conversations keep redacted user-visible chat and request history separate
-- from immutable jobs/proposals. Jobs remain the unit of async execution.

create table if not exists workflow_architect_conversations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth_users(id) on delete cascade,
  workflow_id        uuid references workflows(id) on delete cascade,
  provider           text not null,
  title              text not null default 'Workflow Architect',
  status             text not null default 'active'
                     check (status in ('active', 'archived')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists workflow_architect_conversations_user_idx
  on workflow_architect_conversations (user_id, updated_at desc);

create index if not exists workflow_architect_conversations_workflow_idx
  on workflow_architect_conversations (workflow_id, updated_at desc);

create table if not exists workflow_architect_messages (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id        uuid not null references workflow_architect_conversations(id) on delete cascade,
  user_id                uuid not null references auth_users(id) on delete cascade,
  role                   text not null check (role in ('user', 'assistant', 'system')),
  content_redacted       text not null default '',
  job_id                 uuid references workflow_architect_jobs(id) on delete set null,
  proposal_id            uuid references workflow_architect_proposals(id) on delete set null,
  metadata_redacted      jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);

create index if not exists workflow_architect_messages_conversation_idx
  on workflow_architect_messages (conversation_id, created_at asc);

alter table workflow_architect_jobs
  add column if not exists conversation_id uuid references workflow_architect_conversations(id) on delete set null;

alter table workflow_architect_jobs
  add column if not exists parent_message_id uuid references workflow_architect_messages(id) on delete set null;

create index if not exists workflow_architect_jobs_conversation_idx
  on workflow_architect_jobs (conversation_id, created_at desc);
