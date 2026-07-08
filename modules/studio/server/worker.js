// DB-backed worker loop for studio generations. Polls for pending rows using
// `for update skip locked` (via claimPendingGenerations), processes each with a
// concurrency limit, and periodically reaps stale rows. Safe to run in multiple
// processes/instances because claims are atomic.
//
// The `@/`-aliased DB repo is imported lazily so the pure loop helpers can be
// unit-tested under plain Node without Next's alias resolution.
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

// Run one poll cycle: claim a batch and process it. Returns the number of rows
// processed.
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
      // runClaimedGeneration already records failures; log unexpected ones.
      console.error(`[studio-worker] failed to process ${row.id}:`, error?.message || error);
    }
  });

  return rows.length;
}

export async function reapOnce(options = {}) {
  const env = options.env || process.env;
  const timeout = readNumber(env.STUDIO_GENERATION_TIMEOUT_MINUTES, 30);
  const reap = options.reapStaleGenerations
    || (await import('./generationsRepo.js')).reapStaleGenerations;
  const reaped = await reap(timeout);
  if (reaped.length > 0) {
    console.warn(`[studio-worker] reaped ${reaped.length} stale generation(s).`);
  }
  return reaped.length;
}

let loopRunning = false;

// Start the polling loop. Idempotent: calling twice in the same process is a
// no-op after the first start.
export function startWorkerLoop(options = {}) {
  if (loopRunning) return () => {};
  loopRunning = true;

  const env = options.env || process.env;
  const pollIntervalMs = readNumber(env.STUDIO_WORKER_POLL_MS, 2000);
  const reapIntervalMs = readNumber(env.STUDIO_WORKER_REAP_MS, 60000);
  let stopped = false;
  let lastReap = 0;

  const tick = async () => {
    if (stopped) return;
    try {
      // Drain as long as there is work, then wait.
      let processed = 0;
      do {
        processed = await runWorkerOnce({ env });
      } while (processed > 0 && !stopped);

      const now = Date.now();
      if (now - lastReap >= reapIntervalMs) {
        lastReap = now;
        await reapOnce({ env });
      }
    } catch (error) {
      console.error('[studio-worker] loop error:', error?.message || error);
    } finally {
      if (!stopped) {
        setTimeout(tick, pollIntervalMs);
      }
    }
  };

  setTimeout(tick, pollIntervalMs);

  return () => {
    stopped = true;
    loopRunning = false;
  };
}





