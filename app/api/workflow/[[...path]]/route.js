import { NextResponse } from 'next/server';
import {
  getActiveProviderKey,
  getProviderMissingKeyMessage,
} from '@/modules/providers/server/providerKeys';
import { errorResponse } from '@/modules/auth/server/errors';
import { proxyToMuapi } from '@/modules/providers/muapi/server/workflowProxy';
import { handleLocalWorkflow } from '@/modules/workflow/server/router';
import {
  createPresignedGetUrl,
  deleteObject,
  getS3Config,
} from '@/modules/storage/server/s3';
import {
  enqueueWorkflowArchitectJob,
  enqueueWorkflowRunJob,
} from '@/modules/workflow/server/runQueue';
import {
  publishUserEvent,
  workflowRunEvent,
} from '@/modules/events/server/publisher';

export const runtime = 'nodejs';
// SSE (runs/stream) and per-user data must never be cached.
export const dynamic = 'force-dynamic';

// Execution/storage deps handed to the local engine. Kept here (route layer) so
// the router module stays free of `@/` aliases and unit-testable, mirroring the
// studio DI pattern.
const executionDeps = {
  getS3Config,
  createPresignedGetUrl,
  deleteObject,
  enqueueRun: (run) => enqueueWorkflowRunJob(run),
  enqueueArchitect: (request, options) => enqueueWorkflowArchitectJob(request, options),
  publishWorkflowEvent: (event) =>
    publishUserEvent(event.userId, workflowRunEvent(event)),
};

// Single switch point (see docs/workflow-self-hosting-plan.md section 0/2):
//   provider === 'muapi' -> unchanged MuAPI proxy behaviour
//   otherwise            -> our own self-hosted workflow engine
async function dispatch(request, ctx, method) {
  let active;
  try {
    active = await getActiveProviderKey(request);
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }

  const { user, provider, apiKey } = active;
  const routeParams = await ctx.params;
  const path = routeParams?.path || [];

  // Node schemas are a mixed catalog: provider-backed generation models plus
  // local utility nodes. Keep this local for every provider so provider-
  // independent utility nodes are always visible in Workflow Studio.
  if (method === 'GET' && path[1] === 'node-schemas') {
    return handleLocalWorkflow(
      request,
      { params: Promise.resolve(routeParams) },
      method,
      { user, provider, apiKey },
      executionDeps
    );
  }

  if (provider === 'muapi') {
    return proxyToMuapi(request, { params: Promise.resolve(routeParams) }, method, apiKey);
  }

  if (!apiKey) {
    return NextResponse.json(
      { error: getProviderMissingKeyMessage(provider) },
      { status: 401 }
    );
  }

  return handleLocalWorkflow(request, ctx, method, { user, provider, apiKey }, executionDeps);
}

export const GET = (request, ctx) => dispatch(request, ctx, 'GET');
export const POST = (request, ctx) => dispatch(request, ctx, 'POST');
export const PUT = (request, ctx) => dispatch(request, ctx, 'PUT');
export const DELETE = (request, ctx) => dispatch(request, ctx, 'DELETE');
