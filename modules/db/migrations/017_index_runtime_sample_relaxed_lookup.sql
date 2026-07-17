create index if not exists provider_runtime_samples_model_time_idx
  on provider_prediction_runtime_samples
  (provider, model_id, runtime_signature_version, completed_at desc)
  where total_time_seconds is not null;
