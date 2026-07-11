import { Queue } from 'bullmq';
import { getBullMqPrefix, getRedisConnection } from '../../queue/server/redis.js';

const queues = new Map();

function numberFromEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getStudioGenerationQueue(env = process.env) {
  const name = env.STUDIO_QUEUE_NAME || 'studio-generations';
  const prefix = getBullMqPrefix(env);
  const key = `${prefix}:${name}`;
  if (!queues.has(key)) {
    queues.set(key, new Queue(name, {
      connection: getRedisConnection(env),
      prefix,
    }));
  }
  return queues.get(key);
}

export async function enqueueGenerationJob(generation, options = {}) {
  const env = options.env || process.env;
  const generationId = typeof generation === 'string' ? generation : generation?.id;
  if (!generationId) throw new Error('generationId is required to enqueue a Studio generation job.');

  const data = {
    generationId,
    userId: generation?.userId || options.userId || null,
    provider: generation?.provider || options.provider || null,
    mediaType: generation?.mediaType || options.mediaType || null,
    mode: generation?.mode || options.mode || null,
    createdAt: generation?.createdAt || new Date().toISOString(),
  };

  return getStudioGenerationQueue(env).add('process-generation', data, {
    jobId: generationId,
    attempts: numberFromEnv(env.STUDIO_JOB_ATTEMPTS, 3),
    backoff: {
      type: 'exponential',
      delay: numberFromEnv(env.STUDIO_JOB_BACKOFF_MS, 5000),
    },
    priority: options.priority,
    removeOnComplete: { count: numberFromEnv(env.STUDIO_REMOVE_ON_COMPLETE, 1000) },
    removeOnFail: { count: numberFromEnv(env.STUDIO_REMOVE_ON_FAIL, 5000) },
  });
}

export async function closeStudioGenerationQueue(env = process.env) {
  const name = env.STUDIO_QUEUE_NAME || 'studio-generations';
  const key = `${getBullMqPrefix(env)}:${name}`;
  const queue = queues.get(key);
  if (queue) {
    queues.delete(key);
    await queue.close();
  }
}
