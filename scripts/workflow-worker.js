import { Worker } from 'bullmq';
import { loadAppEnv } from './load-env.js';
import { getBullMqPrefix, getRedisConnection, closeRedisConnection } from '../modules/queue/server/redis.js';
import { createFinalAttemptWorkerLog } from '../modules/queue/server/workerLogs.js';
import { processRun } from '../modules/workflow/server/runProcessor.js';
import { processArchitectRequest } from '../modules/workflow/server/architectProcessor.js';
import {
  publishUserEvent,
  workflowRunEvent,
} from '../modules/events/server/publisher.js';

loadAppEnv();

function readConcurrency(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

async function saveFinalFailureLog(job, data) {
  try {
    await createFinalAttemptWorkerLog(job, { type: 'error', data });
  } catch (error) {
    console.error('[workflow-worker] failed to persist worker log', {
      jobId: job?.id,
      error: error?.message || error,
    });
  }
}

const env = process.env;
const queueName = env.WORKFLOW_QUEUE_NAME || 'workflow-runs';
const concurrency = readConcurrency(env.WORKFLOW_WORKER_CONCURRENCY);
const worker = new Worker(
  queueName,
  async (job) => {
    const started = Date.now();
    if (job.name === 'process-architect') {
      console.log('[workflow-worker] architect job start', {
        jobId: job.id,
        requestId: job.data.requestId,
        attempt: job.attemptsMade + 1,
      });
      await processArchitectRequest(job.data.requestId, { history: job.data.history || [] });
      console.log('[workflow-worker] architect job success', {
        jobId: job.id,
        requestId: job.data.requestId,
        durationMs: Date.now() - started,
      });
      return;
    }

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

worker.on('failed', async (job, error) => {
  if (job?.name === 'process-architect') {
    const logData = {
      jobId: job?.id,
      requestId: job?.data?.requestId,
      attempt: job?.attemptsMade,
      error: error?.message || error,
    };
    await saveFinalFailureLog(job, logData);
    console.error('[workflow-worker] architect job failed', logData);
    return;
  }

  publishUserEvent(job?.data?.userId, workflowRunEvent({
    userId: job?.data?.userId,
    workflowId: job?.data?.workflowId,
    runId: job?.data?.runId,
    queueStatus: 'failed',
    error: error?.message || String(error),
  }), env).catch(() => {});
  const logData = {
    jobId: job?.id,
    runId: job?.data?.runId,
    attempt: job?.attemptsMade,
    error: error?.message || error,
  };
  await saveFinalFailureLog(job, logData);
  console.error('[workflow-worker] job failed', logData);
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
