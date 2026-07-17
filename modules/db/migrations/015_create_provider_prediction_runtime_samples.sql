create table if not exists provider_prediction_runtime_samples (
  id uuid primary key default gen_random_uuid(), provider text not null, model_id text not null,
  runtime_signature_version integer not null, runtime_signature jsonb not null, signature_hash text not null,
  prediction_id text not null unique, predict_time_seconds numeric, total_time_seconds numeric,
  created_at timestamptz not null, started_at timestamptz, completed_at timestamptz
);
create index if not exists provider_runtime_samples_lookup_idx
  on provider_prediction_runtime_samples (provider, model_id, signature_hash, completed_at desc);
