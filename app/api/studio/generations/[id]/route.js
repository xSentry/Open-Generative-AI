import { requireUser } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';
import {
  handleDeleteGenerationRequest,
  handleGetGenerationRequest,
} from '@/modules/studio/server/apiHandlers';
import { deleteGeneration, getGeneration } from '@/modules/studio/server/generationsRepo';
import { createPresignedGetUrl, deleteObject, getS3Config } from '@/modules/storage/server/s3';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  const { id } = await params;
  return handleGetGenerationRequest(request, {
    id,
    deps: {
      errorResponse,
      requireUser,
      getGeneration,
      createPresignedGetUrl,
      getS3Config,
    },
  });
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  return handleDeleteGenerationRequest(request, {
    id,
    deps: {
      errorResponse,
      requireUser,
      getGeneration,
      deleteGeneration,
      deleteObject,
      getS3Config,
    },
  });
}

