import { requireUser } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';
import { handleListGenerationsRequest } from '@/modules/studio/server/apiHandlers';
import { listGenerations } from '@/modules/studio/server/generationsRepo';
import { createPresignedGetUrl, getS3Config } from '@/modules/storage/server/s3';

export const runtime = 'nodejs';

export async function GET(request) {
  return handleListGenerationsRequest(request, {
    errorResponse,
    requireUser,
    listGenerations,
    createPresignedGetUrl,
    getS3Config,
  });
}

