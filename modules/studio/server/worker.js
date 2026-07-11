// Dev/test helper for processing already-claimed DB rows in-process. Production
// workers use scripts/studio-worker.js and BullMQ.
import { createDefaultProcessDeps, runClaimedGeneration } from './processGeneration.js';

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
  const concurrency = readNumber(env.STUDIO_WORKER_CONCURRENCY, 4);
  const deps = options.deps || (await createDefaultProcessDeps());
  const claim = options.claimPendingGenerations
    || (await import('./generationsRepo.js')).claimPendingGenerations;

  const rows = await claim(concurrency);
  if (rows.length === 0) return 0;

  await processInChunks(rows, concurrency, async (row) => {
    try {
      await runClaimedGeneration(row, deps, env);
    } catch (error) {
      console.error(`[studio-worker] failed to process ${row.id}:`, error?.message || error);
    }
  });

  return rows.length;
}
