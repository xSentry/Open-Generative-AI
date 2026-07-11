import { eventChannelForUser } from './publisher.js';
import { getRedisConnection } from '../../queue/server/redis.js';

export async function subscribeToUserEvents(userId, { env = process.env, onEvent } = {}) {
  const subscriber = getRedisConnection(env).duplicate();
  const channel = eventChannelForUser(userId, env);

  subscriber.on('message', (_channel, message) => {
    if (_channel !== channel) return;
    try {
      onEvent?.(JSON.parse(message));
    } catch {
      // Ignore malformed messages; publishers in this repo emit JSON.
    }
  });

  await subscriber.subscribe(channel);

  return {
    channel,
    close: async () => {
      try {
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
      } catch {
        subscriber.disconnect();
      }
    },
  };
}
