import { Worker } from 'bullmq';
import { loadAppEnv } from './load-env.js';
import { getBullMqPrefix, getRedisConnection, closeRedisConnection } from '../modules/queue/server/redis.js';
import { createFinalAttemptWorkerLog, createWorkerLog } from '../modules/queue/server/workerLogs.js';
import { processArchitectJob } from '../modules/workflow-architect/infrastructure/worker.js';
import {
  publishUserEvent,
  workflowArchitectJobEvent,
} from '../modules/events/server/publisher.js';

loadAppEnv();

function readConcurrency(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

async function saveFinalFailureLog(job, data) {
  try {
    await createFinalAttemptWorkerLog(job, { type: 'error', data });
  } catch (error) {
    console.error('[workflow-architect-worker] failed to persist worker log', {
      jobId: job?.id,
      error: error?.message || error,
    });
  }
}

async function saveHandledFailureLog(data) {
  try {
    await createWorkerLog({ type: 'error', data });
  } catch (error) {
    console.error('[workflow-architect-worker] failed to persist worker log', {
      jobId: data?.jobId,
      error: error?.message || error,
    });
  }
}

function architectEventForJob(job, overrides = {}) {
  return workflowArchitectJobEvent({
    userId: job?.data?.userId,
    workflowId: job?.data?.workflowId,
    conversationId: job?.data?.conversationId,
    jobId: job?.data?.jobId,
    operation: job?.data?.operation,
    ...overrides,
  });
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
    const result = await processArchitectJob(job.data.jobId, {
      publishArchitectEvent: (event) =>
        publishUserEvent(event.userId, workflowArchitectJobEvent(event), env),
    });
    if (result?.job?.status === 'failed' || result?.status === 'failed') {
      const error = result?.job?.errorMessageRedacted || result?.errorMessageRedacted || 'Workflow Architect job failed.';
      const code = result?.job?.errorCode || result?.errorCode || 'ARCHITECT_JOB_FAILED';
      const logData = {
        jobId: job.id,
        architectJobId: job.data.jobId,
        workflowId: job.data.workflowId,
        operation: job.data.operation,
        attempt: job.attemptsMade + 1,
        error,
        code,
      };
      await saveHandledFailureLog(logData);
      console.error('[workflow-architect-worker] job failed', logData);
      return;
    }
    console.log('[workflow-architect-worker] job complete', {
      jobId: job.id,
      architectJobId: job.data.jobId,
      proposalId: result?.proposal?.id,
    });
  },
  {
    connection: getRedisConnection(env),
    prefix: getBullMqPrefix(env),
    concurrency,
  }
);

worker.on('failed', async (job, error) => {
  publishUserEvent(job?.data?.userId, architectEventForJob(job, {
    queueStatus: 'failed',
    status: 'failed',
    error: error?.message || String(error),
  }), env).catch(() => {});
  const logData = {
    jobId: job?.id,
    architectJobId: job?.data?.jobId,
    workflowId: job?.data?.workflowId,
    operation: job?.data?.operation,
    attempt: job?.attemptsMade,
    error: error?.message || error,
  };
  await saveFinalFailureLog(job, logData);
  console.error('[workflow-architect-worker] job failed', logData);
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
