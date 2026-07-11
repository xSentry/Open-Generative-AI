import { randomUUID } from 'node:crypto';
import { getRedisConnection } from './redis.js';

const ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
local limit = tonumber(ARGV[2])
if count < limit then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0
`;

const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
end
return 1
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function semaphoreKey(name, env = process.env) {
  const prefix = env.BULLMQ_PREFIX || 'open-generative-ai';
  return `${prefix}:semaphore:${name}`;
}

export async function acquireSemaphore({
  name,
  limit,
  leaseMs = 60 * 60 * 1000,
  retryDelayMs = 1000,
  token = randomUUID(),
  env = process.env,
  redis = getRedisConnection(env),
}) {
  const safeLimit = positiveNumber(limit);
  if (!name || safeLimit <= 0) {
    return { acquired: false, enabled: false, release: async () => {} };
  }

  const key = semaphoreKey(name, env);
  const safeLeaseMs = positiveNumber(leaseMs, 60 * 60 * 1000);
  const safeRetryDelayMs = positiveNumber(retryDelayMs, 1000);

  for (;;) {
    const now = Date.now();
    const expiresAt = now + safeLeaseMs;
    const acquired = await redis.eval(
      ACQUIRE_SCRIPT,
      1,
      key,
      String(now),
      String(safeLimit),
      String(expiresAt),
      token,
      String(safeLeaseMs)
    );
    if (Number(acquired) === 1) {
      return {
        acquired: true,
        enabled: true,
        key,
        token,
        release: () => releaseSemaphore({ key, token, redis }),
      };
    }
    await sleep(safeRetryDelayMs);
  }
}

export async function releaseSemaphore({ key, token, redis }) {
  if (!key || !token || !redis) return;
  await redis.eval(RELEASE_SCRIPT, 1, key, token);
}

export async function withSemaphores(semaphores, fn) {
  const acquired = [];
  try {
    for (const semaphore of semaphores) {
      const lease = await acquireSemaphore(semaphore);
      if (lease.enabled) acquired.push(lease);
    }
    return await fn();
  } finally {
    await Promise.allSettled(acquired.reverse().map((lease) => lease.release()));
  }
}
