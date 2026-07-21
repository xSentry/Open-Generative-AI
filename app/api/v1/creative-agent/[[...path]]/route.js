import { NextResponse } from 'next/server';
import { errorResponse } from '@/modules/auth/server/errors';
import { getActiveProviderKey } from '@/modules/providers/server/providerKeys';
import { requireProviderOperation } from '@/modules/providers/server/registry';
import * as repo from '@/modules/design-agent/server/repo';
import { enqueueJob, listSkills } from '@/modules/design-agent/server/runtime';

export const runtime = 'nodejs';

function json(body, status = 200) {
  return NextResponse.json(body, { status });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function terminal(status) {
  return ['succeeded', 'completed', 'failed', 'cancelled', 'rejected'].includes(status);
}

function streamJobEvents({ request, job, scope }) {
  const encoder = new TextEncoder();
  const intervalMs = 1000;
  const heartbeatMs = 15000;
  const url = new URL(request.url);
  const lastEventId = request.headers.get('last-event-id');
  let cursor = Number(lastEventId || url.searchParams.get('since') || 0);
  let pollTimer = null;
  let heartbeatTimer = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event) => {
        cursor = Math.max(cursor, Number(event.cursor) || cursor);
        controller.enqueue(encoder.encode(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const comment = (text) => controller.enqueue(encoder.encode(`: ${text}\n\n`));
      comment('connected');

      const tick = async () => {
        try {
          const events = await repo.listEvents(job.id, { userId: scope.userId, since: cursor });
          for (const event of events) send(event);
          const freshJob = await repo.getJob(job.id, scope);
          if (freshJob && terminal(freshJob.status)) {
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({
              job_id: job.id,
              status: freshJob.status,
              approved: freshJob.approved,
            })}\n\n`));
            cleanup();
          }
        } catch {
          // Keep the stream open on transient DB errors; polling fallback exists client-side.
        }
      };

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        pollTimer = null;
        heartbeatTimer = null;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      pollTimer = setInterval(tick, intervalMs);
      heartbeatTimer = setInterval(() => comment('keep-alive'), heartbeatMs);
      tick();

      if (request.signal) {
        if (request.signal.aborted) cleanup();
        else request.signal.addEventListener('abort', cleanup);
      }
    },
    cancel() {
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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

async function withProvider(request, params, method) {
  let active;
  try {
    active = await getActiveProviderKey(request);
  } catch (error) {
    const { body, status } = errorResponse(error);
    return json(body, status);
  }

  const adapter = requireProviderOperation(active.provider, 'designAgent');
  if (adapter.transports?.designAgentProxy) {
    return adapter.transports.designAgentProxy(request, { params, apiKey: active.apiKey });
  }

  const slug = await params;
  const path = slug.path || [];
  const scope = { userId: active.user.id, provider: active.provider };

  try {
    return await handleLocal(request, path, method, scope);
  } catch (error) {
    console.error('[design-agent] local route error:', error);
    return json({ error: error.message || 'Design Agent request failed.' }, error.status || 500);
  }
}

async function handleLocal(request, path, method, scope) {
  if (method === 'GET' && path.length === 1 && path[0] === 'agent-skills') {
    return json(listSkills());
  }

  if (method === 'GET' && path.length === 1 && path[0] === 'sessions') {
    return json(await repo.listSessions(scope));
  }

  if (method === 'POST' && path.length === 1 && path[0] === 'sessions') {
    const body = await readJson(request);
    return json(await repo.createSession({
      ...scope,
      name: body?.name || 'New Session',
    }));
  }

  if (path[0] === 'sessions' && path[1]) {
    return handleSessionRoute(request, path, method, scope);
  }

  if (path[0] === 'jobs' && path[1]) {
    return handleJobRoute(request, path, method, scope);
  }

  return json({ error: `Unknown Design Agent endpoint: ${method} ${path.join('/')}` }, 404);
}

async function handleSessionRoute(request, path, method, scope) {
  const sessionId = path[1];
  const session = await repo.getSession(sessionId, scope);
  if (!session) return json({ error: 'Session not found.' }, 404);

  if (method === 'PATCH' && path.length === 2) {
    const body = await readJson(request);
    const name = String(body?.name || '').trim();
    if (!name) return json({ error: 'Session name is required.' }, 400);
    return json(await repo.renameSession(sessionId, { ...scope, name }));
  }

  if (method === 'DELETE' && path.length === 2) {
    await repo.deleteSession(sessionId, scope);
    return json({ deleted: true });
  }

  if (method === 'GET' && path[2] === 'messages') {
    return json(await repo.getMessages(sessionId, scope));
  }

  if (method === 'PATCH' && path[2] === 'messages') {
    const body = await readJson(request);
    await repo.setMessages(sessionId, { ...scope, messages: body?.messages || [] });
    return json({ ok: true });
  }

  if (method === 'GET' && path[2] === 'assets') {
    return json(await repo.listAssets(sessionId, scope));
  }

  if (method === 'POST' && path[2] === 'assets') {
    const body = await readJson(request);
    if (!body?.url) return json({ error: 'Asset url is required.' }, 400);
    const asset = await repo.createAsset({
      sessionId,
      ...scope,
      url: body.url,
      kind: body.kind || 'image',
      sourceTool: body.source_tool || body.sourceTool || 'upload',
      model: body.model || null,
      prompt: body.prompt || null,
      metadata: body.metadata || {},
    });
    return json(asset);
  }

  if (method === 'GET' && path[2] === 'jobs') {
    return json(await repo.listJobs(sessionId, scope));
  }

  if (method === 'POST' && (path[2] === 'chat' || path[2] === 'run-skill')) {
    const body = await readJson(request);
    const job = await repo.createJob({
      sessionId,
      ...scope,
      action: path[2],
      payload: body,
    });
    await enqueueJob(job);
    return json({ job_id: job.id });
  }

  return json({ error: `Unknown session endpoint: ${method} ${path.join('/')}` }, 404);
}

async function handleJobRoute(request, path, method, scope) {
  const jobId = path[1];
  const job = await repo.getJob(jobId, scope);
  if (!job) return json({ error: 'Job not found.' }, 404);

  if (method === 'GET' && path[2] === 'events') {
    const url = new URL(request.url);
    const events = await repo.listEvents(jobId, {
      userId: scope.userId,
      since: url.searchParams.get('since') || 0,
    });
    const latestCursor = events.length ? events[events.length - 1].cursor : Number(url.searchParams.get('since') || 0);
    return json({
      events,
      cursor: latestCursor,
      done: terminal(job.status),
      approved: job.approved,
      status: job.status,
    });
  }

  if (method === 'GET' && path[2] === 'stream') {
    return streamJobEvents({ request, job, scope });
  }

  if (method === 'POST' && ['approve', 'reject', 'cancel'].includes(path[2])) {
    if (path[2] === 'approve') {
      await repo.updateJob(jobId, { approved: true });
      return json({ ok: true });
    }
    const status = path[2] === 'cancel' ? 'cancelled' : 'rejected';
    await repo.updateJob(jobId, { status, approved: false });
    await repo.addEvent({
      jobId,
      sessionId: job.session_id,
      userId: scope.userId,
      type: 'info',
      payload: { content: status === 'cancelled' ? 'Job cancelled.' : 'Plan rejected.' },
    });
    return json({ ok: true });
  }

  return json({ error: `Unknown job endpoint: ${method} ${path.join('/')}` }, 404);
}

export async function GET(request, { params }) {
  return withProvider(request, params, 'GET');
}

export async function POST(request, { params }) {
  return withProvider(request, params, 'POST');
}

export async function PATCH(request, { params }) {
  return withProvider(request, params, 'PATCH');
}

export async function DELETE(request, { params }) {
  return withProvider(request, params, 'DELETE');
}
