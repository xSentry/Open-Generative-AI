// Dev/test helper for processing already-claimed DB rows in-process. Production
// workers use scripts/workflow-worker.js and BullMQ.
import { createDefaultRunDeps, runClaimedRun } from './runProcessor.js';

function readNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function processInChunks(rows, concurrency, handler) {
  let index = 0;
  const workers = new Array(Math.min(concurrency, rows.length)).fill(null).map(async () => {
    while (index < rows.length) {
      const current = rows[index];
      index += 1;
      await handler(current);
    }
  });
  await Promise.all(workers);
}

export async function runWorkerOnce(options = {}) {
  const env = options.env || process.env;
  const concurrency = readNumber(env.WORKFLOW_WORKER_CONCURRENCY, 2);
  const deps = options.deps || (await createDefaultRunDeps());
  const claim = options.claimPendingRuns
    || (await import('./runsRepo.js')).claimPendingRuns;

  const runs = await claim(concurrency);
  if (runs.length === 0) return 0;

  await processInChunks(runs, concurrency, async (run) => {
    try {
      await runClaimedRun(run, deps);
    } catch (error) {
      console.error(`[workflow-worker] failed to process run ${run.id}:`, error?.message || error);
    }
  });

  return runs.length;
}

export async function reapOnce(options = {}) {
  const env = options.env || process.env;
  const timeout = readNumber(env.WORKFLOW_RUN_TIMEOUT_MINUTES, 30);
  const reap = options.reapStaleRuns
    || (await import('./runsRepo.js')).reapStaleRuns;
  const reaped = await reap(timeout);
  if (reaped.length > 0) {
    console.warn(`[workflow-worker] reaped ${reaped.length} stale run(s).`);
  }
  return reaped.length;
}
