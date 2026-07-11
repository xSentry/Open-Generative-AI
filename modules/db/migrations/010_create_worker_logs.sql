create table if not exists worker_logs (
  id          uuid primary key default gen_random_uuid(),
  type        text not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists worker_logs_type_created_idx
  on worker_logs (type, created_at desc);
