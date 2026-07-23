import { Queue } from 'bullmq';
import { getBullMqPrefix, getRedisConnection } from '../../queue/server/redis.js';

const queues = new Map();

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function getRemixJobQueue(env = process.env) {
  const name = env.REMIX_QUEUE_NAME || 'remix-jobs';
  const key = `${getBullMqPrefix(env)}:${name}`;
  if (!queues.has(key)) {
    queues.set(key, new Queue(name, {
      connection: getRedisConnection(env),
      prefix: getBullMqPrefix(env),
    }));
  }
  return queues.get(key);
}

export async function enqueueRemixJob(data, env = process.env) {
  if (!data?.jobId || !data?.type) throw new TypeError('A Remix job id and type are required.');
  return getRemixJobQueue(env).add(data.type, data, {
    jobId: data.jobId,
    attempts: positiveNumber(env.REMIX_JOB_ATTEMPTS, 2),
    backoff: { type: 'exponential', delay: positiveNumber(env.REMIX_JOB_BACKOFF_MS, 5000) },
    removeOnComplete: { count: positiveNumber(env.REMIX_REMOVE_ON_COMPLETE, 500) },
    removeOnFail: { count: positiveNumber(env.REMIX_REMOVE_ON_FAIL, 2000) },
  });
}
