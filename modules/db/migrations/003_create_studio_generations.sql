create table if not exists studio_generations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth_users(id) on delete cascade,

  -- classification
  mode          text not null,
  media_type    text not null,
  provider      text not null,
  model         text not null,

  -- request
  prompt        text,
  params        jsonb not null default '{}'::jsonb,
  input_assets  jsonb not null default '[]'::jsonb,

  -- lifecycle
  status        text not null default 'generating'
                check (status in ('generating','succeeded','failed','canceled')),
  provider_ref  text,
  error         text,

  -- output (populated on success)
  output_key    text,
  output_type   text,
  output_meta   jsonb,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index if not exists studio_generations_user_created_idx
  on studio_generations (user_id, created_at desc);
create index if not exists studio_generations_user_media_idx
  on studio_generations (user_id, media_type, created_at desc);
create index if not exists studio_generations_status_idx
  on studio_generations (status);

