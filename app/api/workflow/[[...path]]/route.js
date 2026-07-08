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
import { processRun } from '@/modules/workflow/server/runProcessor';

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
  // Fire-and-forget async execution; processRun atomically claims the run so the
  // worker loop and this call never double-process it.
  enqueueRun: (runId) => {
    Promise.resolve()
      .then(() => processRun(runId))
      .catch((error) => console.error('[workflow] run failed:', error));
  },
};

// Single switch point (see docs/workflow-self-hosting-plan.md §0/§2):
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

    if (provider === 'muapi') {
        return proxyToMuapi(request, ctx, method, apiKey);
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
