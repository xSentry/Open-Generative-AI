import IORedis from 'ioredis';

const connections = new Map();

function redisUrl(env = process.env) {
  return env.REDIS_URL || 'redis://localhost:6379';
}

export function getBullMqPrefix(env = process.env) {
  return env.BULLMQ_PREFIX || 'open-generative-ai';
}

export function getRedisConnection(env = process.env) {
  const url = redisUrl(env);
  if (!connections.has(url)) {
    connections.set(url, new IORedis(url, { maxRetriesPerRequest: null }));
  }
  return connections.get(url);
}

export async function closeRedisConnection() {
  const pending = [];
  for (const connection of connections.values()) {
    pending.push(connection.quit().catch(() => connection.disconnect()));
  }
  connections.clear();
  await Promise.all(pending);
}
