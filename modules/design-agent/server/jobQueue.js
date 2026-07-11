import { Queue } from 'bullmq';
import { getBullMqPrefix, getRedisConnection } from '../../queue/server/redis.js';

const queues = new Map();

function numberFromEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getDesignAgentQueue(env = process.env) {
  const name = env.DESIGN_AGENT_QUEUE_NAME || 'design-agent-jobs';
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

export async function enqueueDesignAgentJob(job, options = {}) {
  const env = options.env || process.env;
  const jobId = typeof job === 'string' ? job : job?.id;
  if (!jobId) throw new Error('jobId is required to enqueue a Design Agent job.');

  const data = {
    jobId,
    userId: job?.userId || job?.user_id || options.userId || null,
    sessionId: job?.sessionId || job?.session_id || options.sessionId || null,
    provider: job?.provider || options.provider || null,
    action: job?.action || options.action || null,
    createdAt: job?.createdAt || job?.created_at || new Date().toISOString(),
  };

  return getDesignAgentQueue(env).add('process-design-agent-job', data, {
    jobId,
    attempts: numberFromEnv(env.DESIGN_AGENT_JOB_ATTEMPTS, 2),
    backoff: {
      type: 'exponential',
      delay: numberFromEnv(env.DESIGN_AGENT_JOB_BACKOFF_MS, 5000),
    },
    priority: options.priority,
    removeOnComplete: { count: numberFromEnv(env.DESIGN_AGENT_REMOVE_ON_COMPLETE, 1000) },
    removeOnFail: { count: numberFromEnv(env.DESIGN_AGENT_REMOVE_ON_FAIL, 5000) },
  });
}

export async function closeDesignAgentQueue(env = process.env) {
  const name = env.DESIGN_AGENT_QUEUE_NAME || 'design-agent-jobs';
  const key = `${getBullMqPrefix(env)}:${name}`;
  const queue = queues.get(key);
  if (queue) {
    queues.delete(key);
    await queue.close();
  }
}
