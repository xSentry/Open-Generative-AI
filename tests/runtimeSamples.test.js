import assert from 'node:assert/strict';
import test from 'node:test';

import {
  estimatePredictionRuntime,
  saveRuntimeSample,
} from '../modules/providers/runtime/server/samples.js';
import { createRuntimeSignature } from '../modules/providers/runtime/server/signature.js';

const model = {
  id: 'runtime-model',
  inputs: {
    width: { type: 'integer' },
    quality: { type: 'string' },
    num_outputs: { type: 'integer' },
  },
};
const signature = createRuntimeSignature({
  model,
  params: { width: 1024, quality: 'high', num_outputs: 2 },
});

test('runtime estimator returns null when exact and relaxed history are empty', async () => {
  const calls = [];
  const result = await estimatePredictionRuntime({
    model,
    signature,
    queryFn: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  });
  assert.equal(result, null);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /jsonb_object_agg/);
  assert.match(calls[1].sql, /= \$5::jsonb/);
  assert.match(calls[1].sql, /limit 10/i);
  assert.doesNotMatch(calls[1].sql, /limit 100/i);
});

test('runtime estimator returns a low-confidence relaxed estimate below the threshold', async () => {
  let call = 0;
  const result = await estimatePredictionRuntime({
    model,
    signature,
    queryFn: async () => {
      call += 1;
      return call === 1
        ? { rows: [{ total_time_seconds: '47' }] }
        : { rows: [{ total_time_seconds: '47' }, { total_time_seconds: '53' }] };
    },
  });
  assert.deepEqual(result, {
    seconds: 53,
    rangeSeconds: [47, 53],
    sampleCount: 2,
    confidence: 'low',
    basis: 'model_relaxed_signature',
  });
});

test('runtime estimator uses exact history immediately at the minimum threshold', async () => {
  let calls = 0;
  const result = await estimatePredictionRuntime({
    model,
    signature,
    queryFn: async () => {
      calls += 1;
      return {
        rows: [
          { total_time_seconds: 30 },
          { total_time_seconds: 40 },
          { total_time_seconds: 500 },
        ],
      };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    seconds: 40,
    rangeSeconds: [40, 500],
    sampleCount: 3,
    confidence: 'medium',
    basis: 'model_exact_signature',
  });
});

test('runtime sample storage is idempotent and writes both timing columns', async () => {
  let captured;
  await saveRuntimeSample({
    provider: 'replicate',
    modelId: model.id,
    signature,
    predictionId: 'prediction-1',
    predictTimeSeconds: 12,
    totalTimeSeconds: 15,
  }, {
    queryFn: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  });
  assert.match(captured.sql, /on conflict \(prediction_id\) do nothing/i);
  assert.equal(captured.params[6], 12);
  assert.equal(captured.params[7], 15);
});

test('runtime sample storage mirrors either available timing metric', async () => {
  const writes = [];
  for (const sample of [
    { predictTimeSeconds: 12 },
    { totalTimeSeconds: 15 },
  ]) {
    await saveRuntimeSample({
      provider: 'replicate',
      modelId: model.id,
      signature,
      predictionId: `prediction-${writes.length + 2}`,
      ...sample,
    }, {
      queryFn: async (_sql, params) => {
        writes.push(params);
        return { rows: [] };
      },
    });
  }
  assert.deepEqual(writes.map((params) => params.slice(6, 8)), [
    [12, 12],
    [15, 15],
  ]);
});
