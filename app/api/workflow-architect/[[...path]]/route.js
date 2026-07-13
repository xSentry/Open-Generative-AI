import { NextResponse } from 'next/server';
import {
  getActiveProviderKey,
  getProviderMissingKeyMessage,
} from '@/modules/providers/server/providerKeys';
import { errorResponse } from '@/modules/auth/server/errors';
import { handleWorkflowArchitect } from '@/modules/workflow-architect/api/router';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function dispatch(request, ctx, method) {
  let active;
  try {
    active = await getActiveProviderKey(request);
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }

  const { user, provider, apiKey } = active;

  if (provider !== 'replicate') {
    return NextResponse.json(
      {
        error: {
          code: 'UNSUPPORTED_PROVIDER',
          message: 'Workflow Architect is only available for Replicate workflows.',
        },
      },
      { status: 400 }
    );
  }

  if (!apiKey) {
    return NextResponse.json(
      {
        error: {
          code: 'PROVIDER_KEY_MISSING',
          message: getProviderMissingKeyMessage(provider),
        },
      },
      { status: 401 }
    );
  }

  return handleWorkflowArchitect(request, ctx, method, { user, provider, apiKey });
}

export const GET = (request, ctx) => dispatch(request, ctx, 'GET');
export const POST = (request, ctx) => dispatch(request, ctx, 'POST');
export const DELETE = (request, ctx) => dispatch(request, ctx, 'DELETE');
