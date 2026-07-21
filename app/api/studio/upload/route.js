import { requireUser } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';
import { getActiveProviderKey } from '@/modules/providers/server/providerKeys';
import { requireProviderOperation } from '@/modules/providers/server/registry';
import {
  handleStudioUploadDeleteRequest,
  handleStudioUploadRequest,
} from '@/modules/studio/server/apiHandlers';
import {
  createObjectKey,
  deleteObject,
  getS3Config,
  uploadObject,
} from '@/modules/storage/server/s3';

export const runtime = 'nodejs';

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

export async function POST(request) {
  return handleStudioUploadRequest(request, {
    createObjectKey,
    errorResponse,
    getActiveProviderKey,
    getS3Config,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    requireUser,
    requireProviderOperation,
    uploadObject,
  });
}

export async function DELETE(request) {
  return handleStudioUploadDeleteRequest(request, {
    deleteObject,
    errorResponse,
    getS3Config,
    requireUser,
  });
}
