import { requireUser } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';
import { subscribeToUserEvents } from '@/modules/events/server/subscriber';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function GET(request) {
  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    const { body, status } = errorResponse(error);
    return json(body, { status });
  }

  const encoder = new TextEncoder();
  let subscription = null;
  let heartbeat = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event) => {
        const id = event.updatedAt || new Date().toISOString();
        controller.enqueue(encoder.encode(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const comment = (text) => controller.enqueue(encoder.encode(`: ${text}\n\n`));
      const close = async () => {
        if (heartbeat) clearInterval(heartbeat);
        if (subscription) await subscription.close();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      comment('connected');
      heartbeat = setInterval(() => comment('keep-alive'), 15000);
      subscription = await subscribeToUserEvents(user.id, {
        onEvent: send,
      });

      if (request.signal) {
        if (request.signal.aborted) await close();
        else request.signal.addEventListener('abort', close);
      }
    },
    async cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (subscription) await subscription.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
