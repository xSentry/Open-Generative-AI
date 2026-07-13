import { Queue } from 'bullmq';
import { getBullMqPrefix, getRedisConnection } from '../../queue/server/redis.js';

const queues = new Map();

function numberFromEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getWorkflowArchitectQueue(env = process.env) {
  const name = env.WORKFLOW_ARCHITECT_QUEUE_NAME || 'workflow-architect';
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

export async function enqueueWorkflowArchitectJob(job, options = {}) {
  const env = options.env || process.env;
  const jobId = typeof job === 'string' ? job : job?.id;
  if (!jobId) throw new Error('jobId is required to enqueue a Workflow Architect job.');

  return getWorkflowArchitectQueue(env).add('process-architect-job', {
    jobId,
    userId: job?.userId || options.userId || null,
    workflowId: job?.workflowId || options.workflowId || null,
    operation: job?.operation || options.operation || null,
    provider: job?.provider || options.provider || null,
    createdAt: job?.createdAt || new Date().toISOString(),
  }, {
    jobId,
    attempts: numberFromEnv(env.WORKFLOW_ARCHITECT_JOB_ATTEMPTS, 1),
    backoff: {
      type: 'exponential',
      delay: numberFromEnv(env.WORKFLOW_ARCHITECT_JOB_BACKOFF_MS, 5000),
    },
    removeOnComplete: { count: numberFromEnv(env.WORKFLOW_ARCHITECT_REMOVE_ON_COMPLETE, 1000) },
    removeOnFail: { count: numberFromEnv(env.WORKFLOW_ARCHITECT_REMOVE_ON_FAIL, 5000) },
  });
}

export async function closeWorkflowArchitectQueue(env = process.env) {
  const name = env.WORKFLOW_ARCHITECT_QUEUE_NAME || 'workflow-architect';
  const key = `${getBullMqPrefix(env)}:${name}`;
  const queue = queues.get(key);
  if (queue) {
    queues.delete(key);
    await queue.close();
  }
}
