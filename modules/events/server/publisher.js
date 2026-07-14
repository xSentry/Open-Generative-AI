import { getRedisConnection } from '../../queue/server/redis.js';

export function eventChannelForUser(userId, env = process.env) {
  const prefix = env.EVENT_REDIS_CHANNEL_PREFIX || 'oga-events';
  return `${prefix}:user:${userId}`;
}

export async function publishUserEvent(userId, event, env = process.env) {
  if (!userId) return 0;
  const payload = {
    ...event,
    userId,
    updatedAt: event?.updatedAt || new Date().toISOString(),
  };
  return getRedisConnection(env).publish(eventChannelForUser(userId, env), JSON.stringify(payload));
}

export function studioGenerationEvent({ userId, id, status, queueStatus, progress, error }) {
  return {
    type: 'studio.generation.updated',
    userId,
    id,
    status: status || null,
    queueStatus: queueStatus || null,
    progress: progress ?? null,
    error: error || null,
    updatedAt: new Date().toISOString(),
  };
}

export function workflowRunEvent({
  userId,
  workflowId,
  runId,
  nodeRunId,
  status,
  queueStatus,
  progress,
  error,
}) {
  return {
    type: 'workflow.run.updated',
    userId,
    workflowId: workflowId || null,
    runId,
    nodeRunId: nodeRunId || null,
    status: status || null,
    queueStatus: queueStatus || null,
    progress: progress ?? null,
    error: error || null,
    updatedAt: new Date().toISOString(),
  };
}

export function workflowArchitectJobEvent({
  userId,
  workflowId,
  conversationId,
  jobId,
  operation,
  status,
  queueStatus,
  proposalId,
  error,
}) {
  return {
    type: 'workflow.architect.job.updated',
    userId,
    workflowId: workflowId || null,
    conversationId: conversationId || null,
    jobId,
    operation: operation || null,
    status: status || null,
    queueStatus: queueStatus || null,
    proposalId: proposalId || null,
    error: error || null,
    updatedAt: new Date().toISOString(),
  };
}
