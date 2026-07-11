import { withSemaphores } from '../../queue/server/semaphore.js';

function positiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

export function studioConcurrencySemaphores(jobData, env = process.env) {
  const provider = normalizeProvider(jobData?.provider);
  const userId = jobData?.userId ? String(jobData.userId) : '';
  const leaseMs = positiveNumber(env.STUDIO_CONCURRENCY_LEASE_MS, 60 * 60 * 1000);
  const retryDelayMs = positiveNumber(env.STUDIO_CONCURRENCY_RETRY_DELAY_MS, 1000);
  const semaphores = [];

  if (provider === 'replicate') {
    semaphores.push({
      name: 'studio:provider:replicate',
      limit: positiveNumber(env.REPLICATE_MAX_ACTIVE_JOBS),
      leaseMs,
      retryDelayMs,
      env,
    });
  } else if (provider === 'muapi') {
    semaphores.push({
      name: 'studio:provider:muapi',
      limit: positiveNumber(env.MUAPI_MAX_ACTIVE_JOBS),
      leaseMs,
      retryDelayMs,
      env,
    });
  }

  if (userId) {
    semaphores.push({
      name: `studio:user:${userId}`,
      limit: positiveNumber(env.STUDIO_PER_USER_CONCURRENCY_LIMIT),
      leaseMs,
      retryDelayMs,
      env,
    });
  }

  return semaphores;
}

export function withStudioConcurrencyLimits(jobData, fn, env = process.env) {
  return withSemaphores(studioConcurrencySemaphores(jobData, env), fn);
}
