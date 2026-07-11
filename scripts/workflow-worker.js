import { Worker } from 'bullmq';
import { loadAppEnv } from './load-env.js';
import { getBullMqPrefix, getRedisConnection, closeRedisConnection } from '../modules/queue/server/redis.js';
import { processRun } from '../modules/workflow/server/runProcessor.js';
import {
  publishUserEvent,
  workflowRunEvent,
} from '../modules/events/server/publisher.js';

loadAppEnv();

function readConcurrency(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

const env = process.env;
const queueName = env.WORKFLOW_QUEUE_NAME || 'workflow-runs';
const concurrency = readConcurrency(env.WORKFLOW_WORKER_CONCURRENCY);
const worker = new Worker(
  queueName,
  async (job) => {
    const started = Date.now();
    console.log('[workflow-worker] job start', {
      jobId: job.id,
      runId: job.data.runId,
      attempt: job.attemptsMade + 1,
    });
    await publishUserEvent(job.data.userId, workflowRunEvent({
      userId: job.data.userId,
      workflowId: job.data.workflowId,
      runId: job.data.runId,
      queueStatus: 'active',
    }), env);
    await processRun(job.data.runId);
    await publishUserEvent(job.data.userId, workflowRunEvent({
      userId: job.data.userId,
      workflowId: job.data.workflowId,
      runId: job.data.runId,
      queueStatus: 'completed',
    }), env);
    console.log('[workflow-worker] job success', {
      jobId: job.id,
      runId: job.data.runId,
      durationMs: Date.now() - started,
    });
  },
  {
    connection: getRedisConnection(env),
    prefix: getBullMqPrefix(env),
    concurrency,
  }
);

worker.on('failed', (job, error) => {
  publishUserEvent(job?.data?.userId, workflowRunEvent({
    userId: job?.data?.userId,
    workflowId: job?.data?.workflowId,
    runId: job?.data?.runId,
    queueStatus: 'failed',
    error: error?.message || String(error),
  }), env).catch(() => {});
  console.error('[workflow-worker] job failed', {
    jobId: job?.id,
    runId: job?.data?.runId,
    attempt: job?.attemptsMade,
    error: error?.message || error,
  });
});

console.log('[workflow-worker] started', {
  queueName,
  concurrency,
  pid: process.pid,
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',
});

async function shutdown(signal) {
  console.log(`[workflow-worker] ${signal} received; shutting down.`);
  await worker.close();
  await closeRedisConnection();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
