import { NextResponse } from 'next/server';
import {
  getActiveProviderKey,
  getProviderMissingKeyMessage,
} from '@/modules/providers/server/providerKeys';
import { getUserReplicateApiKey } from '@/modules/auth/server/users';
import { errorResponse } from '@/modules/auth/server/errors';
import { handleWorkflowArchitect } from '@/modules/workflow-architect/api/router';
import {
  publishUserEvent,
  workflowArchitectJobEvent,
} from '@/modules/events/server/publisher';

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

  const { user, provider } = active;

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

  const userReplicateApiKey = await getUserReplicateApiKey(user.id);

  if (!userReplicateApiKey) {
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

  return handleWorkflowArchitect(request, ctx, method, { user, provider, apiKey: userReplicateApiKey }, {
    publishArchitectEvent: (event) =>
      publishUserEvent(event.userId, workflowArchitectJobEvent(event)),
  });
}

export const GET = (request, ctx) => dispatch(request, ctx, 'GET');
export const POST = (request, ctx) => dispatch(request, ctx, 'POST');
export const DELETE = (request, ctx) => dispatch(request, ctx, 'DELETE');
