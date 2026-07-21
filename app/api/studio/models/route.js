import { errorResponse } from '@/modules/auth/server/errors';
import { getActiveProviderKey } from '@/modules/providers/server/providerKeys';
import { handleStudioModelsRequest } from '@/modules/studio/server/apiHandlers';
import { requireProviderOperation } from '@/modules/providers/server/registry';

export const runtime = 'nodejs';

export async function GET(request) {
  return handleStudioModelsRequest(request, {
    errorResponse,
    getActiveProviderKey,
    requireProviderOperation,
  });
}
