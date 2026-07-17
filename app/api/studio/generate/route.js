import { requireUser } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';
import {
  getActiveProviderKey,
  getProviderMissingKeyMessage,
} from '@/modules/providers/server/providerKeys';
import { getStudioModel } from '@/modules/studio/server/studioCatalog';
import { handleStudioGenerateRequest } from '@/modules/studio/server/apiHandlers';
import { getReplicateStudioModel } from '@/modules/providers/replicate/server/catalog';
import { runReplicatePrediction } from '@/modules/providers/replicate/server/run';
import { runMuapiPrediction } from '@/modules/providers/muapi/server/run';
import { createRuntimeSignature } from '@/modules/providers/runtime/server/signature';
import { estimatePredictionRuntime } from '@/modules/providers/runtime/server/samples';
import { createGeneration } from '@/modules/studio/server/generationsRepo';
import { mediaTypeForMode } from '@/modules/studio/server/generationMedia';
import {
  createDefaultProcessDeps,
  failGeneration,
  storeGenerationOutputs,
} from '@/modules/studio/server/processGeneration';
import { enqueueGenerationJob } from '@/modules/studio/server/generationQueue';
import {
  publishUserEvent,
  studioGenerationEvent,
} from '@/modules/events/server/publisher';
import { createPresignedGetUrl, getS3Config } from '@/modules/storage/server/s3';

export const runtime = 'nodejs';

export async function POST(request) {
  const processDeps = await createDefaultProcessDeps();

  return handleStudioGenerateRequest(request, {
    errorResponse,
    getActiveProviderKey,
    getProviderMissingKeyMessage,
    getReplicateStudioModel,
    getStudioModel,
    runMuapiPrediction,
    createRuntimeSignature,
    estimatePredictionRuntime,
    runReplicatePrediction,
    // Persistence + async wiring
    requireUser,
    createGeneration,
    mediaTypeForMode,
    createPresignedGetUrl,
    getS3Config,
    env: process.env,
    storeGenerationOutputs: ({ generation, providerResult }) =>
      storeGenerationOutputs({ generation, providerResult, deps: processDeps }),
    failGeneration: ({ generation, error }) =>
      failGeneration({ generation, error, deps: processDeps }),
    enqueueGeneration: (generation) => enqueueGenerationJob(generation),
    publishGenerationEvent: (event) =>
      publishUserEvent(event.userId, studioGenerationEvent(event)),
  });
}
