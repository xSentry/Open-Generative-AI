import { Worker } from 'bullmq';
import { loadAppEnv } from './load-env.js';
import { getBullMqPrefix, getRedisConnection, closeRedisConnection } from '../modules/queue/server/redis.js';
import { processArchitectJob } from '../modules/workflow-architect/infrastructure/worker.js';

loadAppEnv();

function readConcurrency(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const env = process.env;
const queueName = env.WORKFLOW_ARCHITECT_QUEUE_NAME || 'workflow-architect';
const concurrency = readConcurrency(env.WORKFLOW_ARCHITECT_WORKER_CONCURRENCY);

const worker = new Worker(
  queueName,
  async (job) => {
    console.log('[workflow-architect-worker] job start', {
      jobId: job.id,
      architectJobId: job.data.jobId,
      attempt: job.attemptsMade + 1,
    });
    await processArchitectJob(job.data.jobId);
    console.log('[workflow-architect-worker] job complete', {
      jobId: job.id,
      architectJobId: job.data.jobId,
    });
  },
  {
    connection: getRedisConnection(env),
    prefix: getBullMqPrefix(env),
    concurrency,
  }
);

worker.on('failed', (job, error) => {
  console.error('[workflow-architect-worker] job failed', {
    jobId: job?.id,
    architectJobId: job?.data?.jobId,
    error: error?.message || error,
  });
});

console.log('[workflow-architect-worker] started', {
  queueName,
  concurrency,
  pid: process.pid,
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',
});

async function shutdown(signal) {
  console.log(`[workflow-architect-worker] ${signal} received; shutting down.`);
  await worker.close();
  await closeRedisConnection();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
