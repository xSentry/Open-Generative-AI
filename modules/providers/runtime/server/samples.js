import { query } from '../../../db/server/db.js';
import {
  createRelaxedRuntimeSignature,
  HIGH_IMPACT_FIELD_PATTERN,
} from './signature.js';

export async function saveRuntimeSample(sample, { queryFn = query } = {}) {
  const predictTimeSeconds = sample.predictTimeSeconds ?? sample.totalTimeSeconds ?? null;
  const totalTimeSeconds = sample.totalTimeSeconds ?? sample.predictTimeSeconds ?? null;
  await queryFn(`insert into provider_prediction_runtime_samples
    (provider, model_id, runtime_signature_version, runtime_signature, signature_hash, prediction_id, predict_time_seconds, total_time_seconds, created_at, started_at, completed_at)
    values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
    on conflict (prediction_id) do nothing`, [
    sample.provider, sample.modelId, sample.signature.version, JSON.stringify(sample.signature.signature), sample.signature.signatureHash,
    sample.predictionId, predictTimeSeconds, totalTimeSeconds, sample.createdAt || new Date(), sample.startedAt || null, sample.completedAt || new Date(),
  ]);
}

function quantile(values, q) { return values[Math.round((values.length - 1) * q)]; }
function summarize(rows, basis) {
  const values = rows.map((row) => Number(row.total_time_seconds)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const median = quantile(values, 0.5);
  return { seconds: Math.round(median), rangeSeconds: [Math.round(quantile(values, .25)), Math.round(quantile(values, .75))], sampleCount: values.length, confidence: values.length >= 6 ? 'high' : values.length >= 3 ? 'medium' : 'low', basis };
}

export async function estimatePredictionRuntime({ provider = 'replicate', model, signature, queryFn = query }) {
  const fetchRows = (hash) => queryFn(`select total_time_seconds from provider_prediction_runtime_samples
    where provider = $1 and model_id = $2 and runtime_signature_version = $3 and signature_hash = $4 and total_time_seconds is not null
    order by completed_at desc limit 10`, [provider, model.id, signature.version, hash]);
  const exact = summarize((await fetchRows(signature.signatureHash)).rows, 'model_exact_signature');
  if (exact?.sampleCount >= 3) return exact;
  const relaxedSignature = createRelaxedRuntimeSignature(signature.signature);
  // Relaxed signatures are derived at lookup time, so old exact samples remain
  // usable without storing a second, redundant index key.
  // Rebuild the stored relaxed signature in PostgreSQL before LIMIT. Equality
  // is important here: JSONB containment would incorrectly accept a stored
  // sample that has additional high-impact fields such as duration.
  const candidates = await queryFn(`select total_time_seconds from provider_prediction_runtime_samples
    where provider = $1 and model_id = $2 and runtime_signature_version = $3
      and total_time_seconds is not null
      and jsonb_build_object(
        'fields', coalesce((
          select jsonb_object_agg(field.key, field.value)
          from jsonb_each(coalesce(runtime_signature->'fields', '{}'::jsonb)) as field
          where field.key ~* $4
        ), '{}'::jsonb),
        'media', coalesce(runtime_signature->'media', '{}'::jsonb)
      ) = $5::jsonb
    order by completed_at desc limit 10`, [
    provider, model.id, signature.version, HIGH_IMPACT_FIELD_PATTERN,
    JSON.stringify(relaxedSignature.signature),
  ]);
  const relaxed = summarize(candidates.rows, 'model_relaxed_signature');
  return relaxed || exact;
}
