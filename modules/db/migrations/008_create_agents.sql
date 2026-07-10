-- Local Agents runtime for non-MuAPI providers.
-- Stores provider-scoped agent definitions, skills, conversations, likes, and
-- completed chat jobs while preserving the existing /api/agents contract.

create table if not exists agents (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth_users(id) on delete cascade,
  provider             text not null,
  slug                 text not null,
  name                 text not null,
  description          text,
  system_prompt        text not null default '',
  icon_url             text,
  theme                jsonb not null default '"cosmic"'::jsonb,
  welcome_message      text,
  initial_suggestions  jsonb not null default '[]'::jsonb,
  is_published         boolean not null default false,
  is_template          boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (provider, slug)
);
create index if not exists agents_user_idx on agents (user_id, provider, updated_at desc);
create index if not exists agents_templates_idx on agents (provider, updated_at desc) where is_template;
create index if not exists agents_published_idx on agents (provider, updated_at desc) where is_published;

create table if not exists agent_skills (
  id           text primary key,
  name         text not null,
  description  text not null default '',
  created_at   timestamptz not null default now()
);

create table if not exists agent_skill_links (
  agent_id  uuid not null references agents(id) on delete cascade,
  skill_id  text not null references agent_skills(id) on delete restrict,
  primary key (agent_id, skill_id)
);

create table if not exists agent_conversations (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references agents(id) on delete cascade,
  user_id     uuid not null references auth_users(id) on delete cascade,
  provider    text not null,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists agent_conversations_user_idx
  on agent_conversations (user_id, provider, updated_at desc);

create table if not exists agent_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references agent_conversations(id) on delete cascade,
  role             text not null check (role in ('user','assistant','system')),
  content          text not null default '',
  attachments      jsonb not null default '[]'::jsonb,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists agent_messages_conversation_idx
  on agent_messages (conversation_id, created_at asc);

create table if not exists agent_likes (
  agent_id    uuid not null references agents(id) on delete cascade,
  user_id     uuid not null references auth_users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (agent_id, user_id)
);

create table if not exists agent_chat_jobs (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references agent_conversations(id) on delete cascade,
  user_id          uuid not null references auth_users(id) on delete cascade,
  provider         text not null,
  status           text not null default 'processing'
                   check (status in ('processing','completed','succeeded','failed')),
  result           jsonb,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists agent_chat_jobs_user_idx
  on agent_chat_jobs (user_id, provider, updated_at desc);
