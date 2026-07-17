alter table studio_generations
  add column if not exists provider_created_at timestamptz;
