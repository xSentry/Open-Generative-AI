alter table studio_generations
  add column if not exists runtime_estimate jsonb;
