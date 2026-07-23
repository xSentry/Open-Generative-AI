import { Worker } from 'bullmq';
import { loadAppEnv } from './load-env.js';
import { closeRedisConnection, getBullMqPrefix, getRedisConnection } from '../modules/queue/server/redis.js';
import { processRemixQueueJob } from '../modules/remix/server/worker.js';
import { assertMediaBinaries } from '../modules/media/server/binaries.js';

loadAppEnv();

const env = process.env;
const mediaBinaries = assertMediaBinaries(env);
const queueName = env.REMIX_QUEUE_NAME || 'remix-jobs';
const concurrency = Math.max(1, Number(env.REMIX_WORKER_CONCURRENCY || 2));
const worker = new Worker(queueName, async (job) => {
  console.log('[remix-worker] job start', {
    jobId: job.id, projectId: job.data.projectId, type: job.data.type,
    attempt: job.attemptsMade + 1,
  });
  await processRemixQueueJob(job.data);
  console.log('[remix-worker] job success', {
    jobId: job.id, projectId: job.data.projectId, type: job.data.type,
  });
}, {
  connection: getRedisConnection(env),
  prefix: getBullMqPrefix(env),
  concurrency,
});

worker.on('failed', (job, error) => {
  console.error('[remix-worker] job failed', {
    jobId: job?.id, projectId: job?.data?.projectId,
    type: job?.data?.type, error: error?.message || String(error),
  });
});

console.log('[remix-worker] started', {
  queueName,
  concurrency,
  ffmpeg: mediaBinaries.ffmpeg,
  ffprobe: mediaBinaries.ffprobe,
});

async function shutdown(signal) {
  console.log(`[remix-worker] ${signal} received; shutting down.`);
  await worker.close();
  await closeRedisConnection();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
