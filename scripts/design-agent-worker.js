import { Worker } from 'bullmq';
import { loadAppEnv } from './load-env.js';
import { getBullMqPrefix, getRedisConnection, closeRedisConnection } from '../modules/queue/server/redis.js';
import { processDesignAgentJob } from '../modules/design-agent/server/runtime.js';

loadAppEnv();

function readConcurrency(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

const env = process.env;
const queueName = env.DESIGN_AGENT_QUEUE_NAME || 'design-agent-jobs';
const concurrency = readConcurrency(env.DESIGN_AGENT_WORKER_CONCURRENCY);
const worker = new Worker(
  queueName,
  async (job) => {
    const started = Date.now();
    console.log('[design-agent-worker] job start', {
      jobId: job.id,
      designAgentJobId: job.data.jobId,
      attempt: job.attemptsMade + 1,
    });
    await processDesignAgentJob(job.data.jobId);
    console.log('[design-agent-worker] job success', {
      jobId: job.id,
      designAgentJobId: job.data.jobId,
      durationMs: Date.now() - started,
    });
  },
  {
    connection: getRedisConnection(env),
    prefix: getBullMqPrefix(env),
    concurrency,
  }
);

worker.on('failed', async (job, error) => {
  const message = error?.message || String(error);
  try {
    const repo = await import('../modules/design-agent/server/repo.js');
    const row = job?.data?.jobId ? await repo.getJobForProcessing(job.data.jobId) : null;
    if (row && row.status !== 'failed') {
      await repo.addEvent({
        jobId: row.id,
        sessionId: row.session_id,
        userId: row.user_id,
        type: 'error',
        payload: { message },
      });
      await repo.updateJob(row.id, { status: 'failed', error: message });
    }
  } catch (markError) {
    console.error('[design-agent-worker] failed to mark job failed', {
      designAgentJobId: job?.data?.jobId,
      error: markError?.message || markError,
    });
  }

  console.error('[design-agent-worker] job failed', {
    jobId: job?.id,
    designAgentJobId: job?.data?.jobId,
    attempt: job?.attemptsMade,
    error: message,
  });
});

console.log('[design-agent-worker] started', {
  queueName,
  concurrency,
  pid: process.pid,
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',
});

async function shutdown(signal) {
  console.log(`[design-agent-worker] ${signal} received; shutting down.`);
  await worker.close();
  await closeRedisConnection();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
