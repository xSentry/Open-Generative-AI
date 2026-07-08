// DB-backed worker loop for workflow runs. Polls for pending runs using
// `for update skip locked` (via claimPendingRuns), executes each with a
// concurrency limit, and periodically reaps stale runs. Safe to run in multiple
// processes because claims are atomic. Mirrors modules/studio/server/worker.js.
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

// Run one poll cycle: claim a batch of pending runs and execute them. Returns
// the number of runs processed.
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
      // runClaimedRun records failures on the run; log unexpected ones.
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

let loopRunning = false;

// Start the polling loop. Idempotent: calling twice in the same process is a
// no-op after the first start.
export function startWorkerLoop(options = {}) {
  if (loopRunning) return () => {};
  loopRunning = true;

  const env = options.env || process.env;
  const pollIntervalMs = readNumber(env.WORKFLOW_WORKER_POLL_MS, 2000);
  const reapIntervalMs = readNumber(env.WORKFLOW_WORKER_REAP_MS, 60000);
  let stopped = false;
  let lastReap = 0;

  const tick = async () => {
    if (stopped) return;
    try {
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
      console.error('[workflow-worker] loop error:', error?.message || error);
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

