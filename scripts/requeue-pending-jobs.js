import { loadAppEnv } from './load-env.js';
import { closeRedisConnection } from '../modules/queue/server/redis.js';
import { getPool, query } from '../modules/db/server/db.js';
import {
  closeStudioGenerationQueue,
  enqueueGenerationJob,
} from '../modules/studio/server/generationQueue.js';
import {
  closeWorkflowRunQueue,
  enqueueWorkflowRunJob,
} from '../modules/workflow/server/runQueue.js';

loadAppEnv();

function parseArgs(argv) {
  const options = {
    dryRun: false,
    resetStaleClaims: false,
    limit: 500,
    staleMinutes: Number(process.env.RECOVERY_STALE_CLAIM_MINUTES || 30),
  };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--reset-stale-claims') options.resetStaleClaims = true;
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--stale-minutes=')) options.staleMinutes = Number(arg.slice('--stale-minutes='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) options.limit = 500;
  if (!Number.isFinite(options.staleMinutes) || options.staleMinutes < 1) options.staleMinutes = 30;
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/requeue-pending-jobs.js [options]

Options:
  --dry-run              Print rows that would be enqueued without changing Redis.
  --limit=N              Max Studio rows and Workflow rows to inspect. Default: 500.
  --reset-stale-claims   Clear old Studio provider_ref claims and Workflow running states first.
  --stale-minutes=N      Claim age for --reset-stale-claims. Default: 30.
`);
}

async function resetStaleStudioClaims(staleMinutes) {
  const result = await query(
    `update studio_generations
       set provider_ref = null, updated_at = now()
     where status = 'generating'
       and provider_ref = 'processing'
       and updated_at < now() - ($1 || ' minutes')::interval
     returning id`,
    [String(staleMinutes)]
  );
  return result.rows.length;
}

async function resetStaleWorkflowClaims(staleMinutes) {
  const result = await query(
    `update workflow_runs
       set status = 'processing', updated_at = now()
     where status = 'running'
       and updated_at < now() - ($1 || ' minutes')::interval
     returning id`,
    [String(staleMinutes)]
  );
  return result.rows.length;
}

async function listPendingStudioGenerations(limit) {
  const result = await query(
    `select id, user_id, provider, media_type, mode, created_at
     from studio_generations
     where status = 'generating' and provider_ref is null
     order by created_at asc
     limit $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    mediaType: row.media_type,
    mode: row.mode,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
  }));
}

async function listPendingWorkflowRuns(limit) {
  const result = await query(
    `select id, user_id, workflow_id, provider, target_node_id, created_at
     from workflow_runs
     where status = 'processing'
     order by created_at asc
     limit $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    provider: row.provider,
    targetNodeId: row.target_node_id,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.resetStaleClaims) {
    const [studioReset, workflowReset] = await Promise.all([
      resetStaleStudioClaims(options.staleMinutes),
      resetStaleWorkflowClaims(options.staleMinutes),
    ]);
    console.log('[requeue] reset stale claims', { studioReset, workflowReset, staleMinutes: options.staleMinutes });
  }

  const [generations, runs] = await Promise.all([
    listPendingStudioGenerations(options.limit),
    listPendingWorkflowRuns(options.limit),
  ]);

  console.log('[requeue] pending rows found', {
    studioGenerations: generations.length,
    workflowRuns: runs.length,
    dryRun: options.dryRun,
  });

  if (options.dryRun) {
    for (const generation of generations) console.log('[requeue] studio dry-run', generation);
    for (const run of runs) console.log('[requeue] workflow dry-run', run);
    return;
  }

  let studioEnqueued = 0;
  for (const generation of generations) {
    await enqueueGenerationJob(generation);
    studioEnqueued += 1;
  }

  let workflowEnqueued = 0;
  for (const run of runs) {
    await enqueueWorkflowRunJob(run);
    workflowEnqueued += 1;
  }

  console.log('[requeue] complete', { studioEnqueued, workflowEnqueued });
}

async function closeDbPoolIfOpen() {
  try {
    await getPool().end();
  } catch {
    // No DATABASE_URL/pool may exist for --help or early argument failures.
  }
}

main()
  .catch((error) => {
    console.error('[requeue] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([
      closeStudioGenerationQueue(),
      closeWorkflowRunQueue(),
      closeRedisConnection(),
      closeDbPoolIfOpen(),
    ]);
  });
