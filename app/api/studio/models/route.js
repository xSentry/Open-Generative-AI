import { errorResponse } from '@/modules/auth/server/errors';
import { getActiveProviderKey } from '@/modules/providers/server/providerKeys';
import { getSerializableStudioModelLists } from '@/modules/studio/server/studioCatalog';
import { handleStudioModelsRequest } from '@/modules/studio/server/apiHandlers';
import {
  getReplicateUnavailableCounts,
  getSerializableReplicateModelLists,
} from '@/modules/providers/replicate/server/catalog';

export const runtime = 'nodejs';

export async function GET(request) {
  return handleStudioModelsRequest(request, {
    errorResponse,
    getActiveProviderKey,
    getReplicateUnavailableCounts,
    getSerializableStudioModelLists,
    getSerializableReplicateModelLists,
  });
}
