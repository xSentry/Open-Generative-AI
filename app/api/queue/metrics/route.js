import { NextResponse } from 'next/server';
import { requireUser } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';
import { collectQueueMetricsSnapshot } from '@/modules/queue/server/metrics';
import { getStudioGenerationQueue } from '@/modules/studio/server/generationQueue';
import { getWorkflowRunQueue } from '@/modules/workflow/server/runQueue';
import { getDesignAgentQueue } from '@/modules/design-agent/server/jobQueue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function GET(request) {
  try {
    await requireUser(request);

    const snapshot = await collectQueueMetricsSnapshot({
      queues: [
        {
          name: process.env.STUDIO_QUEUE_NAME || 'studio-generations',
          queue: getStudioGenerationQueue(),
          configuredConcurrency: positiveNumber(process.env.STUDIO_WORKER_CONCURRENCY, 4),
        },
        {
          name: process.env.WORKFLOW_QUEUE_NAME || 'workflow-runs',
          queue: getWorkflowRunQueue(),
          configuredConcurrency: positiveNumber(process.env.WORKFLOW_WORKER_CONCURRENCY, 2),
        },
        {
          name: process.env.DESIGN_AGENT_QUEUE_NAME || 'design-agent-jobs',
          queue: getDesignAgentQueue(),
          configuredConcurrency: positiveNumber(process.env.DESIGN_AGENT_WORKER_CONCURRENCY, 2),
        },
      ],
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
