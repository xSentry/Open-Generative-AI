import { Worker } from 'bullmq';
import { loadAppEnv } from './load-env.js';
import { getBullMqPrefix, getRedisConnection, closeRedisConnection } from '../modules/queue/server/redis.js';
import { processGeneration } from '../modules/studio/server/processGeneration.js';
import { withStudioConcurrencyLimits } from '../modules/studio/server/concurrencyLimits.js';
import {
  publishUserEvent,
  studioGenerationEvent,
} from '../modules/events/server/publisher.js';

loadAppEnv();

function readConcurrency(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

const env = process.env;
const queueName = env.STUDIO_QUEUE_NAME || 'studio-generations';
const concurrency = readConcurrency(env.STUDIO_WORKER_CONCURRENCY);
const worker = new Worker(
  queueName,
  async (job) => {
    const started = Date.now();
    console.log('[studio-worker] job start', {
      jobId: job.id,
      generationId: job.data.generationId,
      attempt: job.attemptsMade + 1,
    });
    await publishUserEvent(job.data.userId, studioGenerationEvent({
      userId: job.data.userId,
      id: job.data.generationId,
      queueStatus: 'active',
    }), env);
    await withStudioConcurrencyLimits(job.data, () => processGeneration(job.data.generationId, undefined, env), env);
    await publishUserEvent(job.data.userId, studioGenerationEvent({
      userId: job.data.userId,
      id: job.data.generationId,
      queueStatus: 'completed',
    }), env);
    console.log('[studio-worker] job success', {
      jobId: job.id,
      generationId: job.data.generationId,
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
  const attempts = Number(job?.opts?.attempts || 1);
  const exhausted = Number(job?.attemptsMade || 0) >= attempts;
  const message = error?.message || String(error);

  if (exhausted && job?.data?.generationId) {
    try {
      const { markGenerationFailed } = await import('../modules/studio/server/generationsRepo.js');
      await markGenerationFailed(job.data.generationId, { error: message });
    } catch (markError) {
      console.error('[studio-worker] failed to mark generation failed', {
        generationId: job.data.generationId,
        error: markError?.message || markError,
      });
    }
  }

  publishUserEvent(job?.data?.userId, studioGenerationEvent({
    userId: job?.data?.userId,
    id: job?.data?.generationId,
    status: exhausted ? 'failed' : undefined,
    queueStatus: 'failed',
    error: message,
  }), env).catch(() => {});
  console.error('[studio-worker] job failed', {
    jobId: job?.id,
    generationId: job?.data?.generationId,
    attempt: job?.attemptsMade,
    attempts,
    exhausted,
    error: message,
  });
});

console.log('[studio-worker] started', {
  queueName,
  concurrency,
  pid: process.pid,
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',
});

async function shutdown(signal) {
  console.log(`[studio-worker] ${signal} received; shutting down.`);
  await worker.close();
  await closeRedisConnection();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
