import { requireUser } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';
import { handleGenerationsStreamRequest } from '@/modules/studio/server/apiHandlers';
import { listUpdatedGenerations } from '@/modules/studio/server/generationsRepo';
import { createPresignedGetUrl, getS3Config } from '@/modules/storage/server/s3';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  return handleGenerationsStreamRequest(request, {
    errorResponse,
    requireUser,
    listUpdatedGenerations,
    createPresignedGetUrl,
    getS3Config,
  });
}

