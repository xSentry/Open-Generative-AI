import { query } from '../../../db/server/db.js';
import { createRelaxedRuntimeSignature } from './signature.js';

export async function saveRuntimeSample(sample) {
  await query(`insert into provider_prediction_runtime_samples
    (provider, model_id, runtime_signature_version, runtime_signature, signature_hash, prediction_id, predict_time_seconds, total_time_seconds, created_at, started_at, completed_at)
    values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
    on conflict (prediction_id) do nothing`, [
    sample.provider, sample.modelId, sample.signature.version, JSON.stringify(sample.signature.signature), sample.signature.signatureHash,
    sample.predictionId, sample.predictTimeSeconds, sample.totalTimeSeconds, sample.createdAt || new Date(), sample.startedAt || null, sample.completedAt || new Date(),
  ]);
}

function quantile(values, q) { return values[Math.round((values.length - 1) * q)]; }
function summarize(rows, basis) {
  const values = rows.map((row) => Number(row.total_time_seconds)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const median = quantile(values, 0.5);
  return { seconds: Math.round(median), rangeSeconds: [Math.round(quantile(values, .25)), Math.round(quantile(values, .75))], sampleCount: values.length, confidence: values.length >= 6 ? 'high' : values.length >= 3 ? 'medium' : 'low', basis };
}

export async function estimatePredictionRuntime({ provider = 'replicate', model, signature }) {
  const fetchRows = (hash) => query(`select total_time_seconds from provider_prediction_runtime_samples
    where provider = $1 and model_id = $2 and runtime_signature_version = $3 and signature_hash = $4 and total_time_seconds is not null
    order by completed_at desc limit 10`, [provider, model.id, signature.version, hash]);
  const exact = summarize((await fetchRows(signature.signatureHash)).rows, 'model_exact_signature');
  if (exact?.sampleCount >= 3) return exact;
  const relaxedSignature = createRelaxedRuntimeSignature(signature.signature);
  // Relaxed signatures are derived at lookup time, so old exact samples remain
  // usable without storing a second, redundant index key.
  const candidates = await query(`select total_time_seconds, runtime_signature from provider_prediction_runtime_samples
    where provider = $1 and model_id = $2 and runtime_signature_version = $3 and total_time_seconds is not null
    order by completed_at desc limit 100`, [provider, model.id, signature.version]);
  const relaxed = summarize(candidates.rows
    .filter((row) => createRelaxedRuntimeSignature(row.runtime_signature).signatureHash === relaxedSignature.signatureHash)
    .slice(0, 10), 'model_relaxed_signature');
  return relaxed || exact;
}
