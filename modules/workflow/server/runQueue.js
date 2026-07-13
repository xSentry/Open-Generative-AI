import { Queue } from 'bullmq';
import { getBullMqPrefix, getRedisConnection } from '../../queue/server/redis.js';

const queues = new Map();

function numberFromEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getWorkflowRunQueue(env = process.env) {
  const name = env.WORKFLOW_QUEUE_NAME || 'workflow-runs';
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

export async function enqueueWorkflowRunJob(run, options = {}) {
  const env = options.env || process.env;
  const runId = typeof run === 'string' ? run : run?.id;
  if (!runId) throw new Error('runId is required to enqueue a Workflow run job.');

  const data = {
    runId,
    userId: run?.userId || options.userId || null,
    workflowId: run?.workflowId || options.workflowId || null,
    provider: run?.provider || options.provider || null,
    targetNodeId: run?.targetNodeId || options.targetNodeId || null,
    createdAt: run?.createdAt || new Date().toISOString(),
  };

  return getWorkflowRunQueue(env).add('process-run', data, {
    jobId: runId,
    attempts: numberFromEnv(env.WORKFLOW_JOB_ATTEMPTS, 2),
    backoff: {
      type: 'exponential',
      delay: numberFromEnv(env.WORKFLOW_JOB_BACKOFF_MS, 5000),
    },
    priority: options.priority,
    removeOnComplete: { count: numberFromEnv(env.WORKFLOW_REMOVE_ON_COMPLETE, 1000) },
    removeOnFail: { count: numberFromEnv(env.WORKFLOW_REMOVE_ON_FAIL, 5000) },
  });
}

export async function closeWorkflowRunQueue(env = process.env) {
  const name = env.WORKFLOW_QUEUE_NAME || 'workflow-runs';
  const key = `${getBullMqPrefix(env)}:${name}`;
  const queue = queues.get(key);
  if (queue) {
    queues.delete(key);
    await queue.close();
  }
}
