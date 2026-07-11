// Core generation processing: download provider output(s), persist them to our
// own S3 bucket, update the DB row, and clean up input assets. Dependencies are
// injected so the logic is unit-testable without real network/DB/S3.
//
// Heavy `@/`-aliased modules (DB repo, S3 client, provider runners) are pulled
// in lazily inside createDefaultProcessDeps() so importing the pure functions in
// tests does not require Next's module-alias resolution.
import { inferExtension } from './generationMedia.js';

function shouldDeleteInputs(env = process.env) {
  const value = env.STUDIO_DELETE_INPUTS_AFTER_GENERATION;
  if (value === undefined || value === null || value === '') return true;
  return String(value).toLowerCase() === 'true';
}

function extractOutputs(providerResult) {
  if (!providerResult) return [];
  if (Array.isArray(providerResult.outputs) && providerResult.outputs.length > 0) {
    return providerResult.outputs.filter(Boolean);
  }
  if (providerResult.url) return [providerResult.url];
  return [];
}

function extractTextOutput(providerResult) {
  if (!providerResult) return null;
  if (typeof providerResult.text === 'string') return providerResult.text;
  if (Array.isArray(providerResult.outputs) && providerResult.outputs.length > 0) {
    const textOutputs = providerResult.outputs.filter((value) => typeof value === 'string' && !/^https?:\/\//i.test(value));
    if (textOutputs.length > 0) return textOutputs.join('');
  }
  return null;
}

export async function createDefaultProcessDeps() {
  const [
    { createOutputObjectKey, deleteObject, getS3Config, uploadObject },
    repo,
    { getReplicateStudioModel },
    { getStudioModel },
    { runReplicatePrediction },
    { runMuapiPrediction },
    { getUserMuapiApiKey, getUserReplicateApiKey },
  ] = await Promise.all([
    import('../../storage/server/s3.js'),
    import('./generationsRepo.js'),
    import('../../providers/replicate/server/catalog.js'),
    import('./studioCatalog.js'),
    import('../../providers/replicate/server/run.js'),
    import('../../providers/muapi/server/run.js'),
    import('../../auth/server/users.js'),
  ]);

  return {
    getGeneration: repo.getGeneration,
    createGeneration: repo.createGeneration,
    updateGenerationResult: repo.updateGenerationResult,
    markGenerationFailed: repo.markGenerationFailed,
    setProviderRef: repo.setProviderRef,
    claimGeneration: repo.claimGeneration,
    createOutputObjectKey,
    uploadObject,
    deleteObject,
    getS3Config,
    fetchFn: (...args) => fetch(...args),
    runReplicatePrediction,
    runMuapiPrediction,
    getReplicateStudioModel,
    getStudioModel,
    resolveProviderKey: async ({ userId, provider }) =>
      provider === 'muapi'
        ? (await getUserMuapiApiKey(userId)) || process.env.MUAPI_API_KEY || null
        : (await getUserReplicateApiKey(userId)) || process.env.REPLICATE_API_TOKEN || null,
  };
}

// Download one remote URL and upload it to our bucket. Returns the stored key +
// content type.
async function storeSingleOutput({ generationId, userId, mediaType, url, config, deps }) {
  const response = await deps.fetchFn(url);
  if (!response.ok) {
    throw new Error(`Failed to download output (${response.status}) from provider.`);
  }
  const contentType = response.headers.get('content-type') || null;
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = inferExtension({ url, contentType, mediaType });
  const key = deps.createOutputObjectKey({ userId, generationId, ext });
  await deps.uploadObject({ config, key, body: buffer, contentType: contentType || undefined });
  return { key, contentType };
}

// Delete input assets from S3 (studio-uploads/*) and flag them on the row.
export async function cleanupGenerationInputs({ generation, config, deps, env = process.env }) {
  if (!shouldDeleteInputs(env)) return generation.inputAssets || [];
  const assets = generation.inputAssets || [];
  if (assets.length === 0) return assets;

  const updated = [];
  for (const asset of assets) {
    if (asset?.key && !asset.deleted) {
      try {
        await deps.deleteObject({ config, key: asset.key });
      } catch {
        // Missing/already-deleted objects are ignored; keep going.
      }
      updated.push({ ...asset, deleted: true });
    } else {
      updated.push(asset);
    }
  }
  return updated;
}

// Store all provider outputs for a generation: the first goes onto the existing
// row, extras fan out into sibling rows. Returns the updated primary row.
export async function storeGenerationOutputs({ generation, providerResult, deps, config, env = process.env }) {
  const textOutput = generation.mediaType === 'text' ? extractTextOutput(providerResult) : null;
  const outputs = extractOutputs(providerResult);
  const resolvedConfig = config || deps.getS3Config();

  if (generation.mediaType === 'text') {
    const cleaned = await cleanupGenerationInputs({ generation, config: resolvedConfig, deps, env });
    if (textOutput === null || textOutput === '') {
      return deps.markGenerationFailed(generation.id, {
        error: 'Provider returned no text output.',
        inputAssets: cleaned,
      });
    }
    return deps.updateGenerationResult(generation.id, {
      status: 'succeeded',
      outputType: 'text/plain',
      outputMeta: { text: textOutput },
      providerRef: providerResult.replicateId || providerResult.request_id || null,
      inputAssets: cleaned,
    });
  }

  if (outputs.length === 0) {
    const cleaned = await cleanupGenerationInputs({ generation, config: resolvedConfig, deps, env });
    return deps.markGenerationFailed(generation.id, {
      error: 'Provider returned no output.',
      inputAssets: cleaned,
    });
  }

  // Primary output onto the existing row.
  const primary = await storeSingleOutput({
    generationId: generation.id,
    userId: generation.userId,
    mediaType: generation.mediaType,
    url: outputs[0],
    config: resolvedConfig,
    deps,
  });

  // Extra outputs fan out into sibling rows.
  for (const extraUrl of outputs.slice(1)) {
    const sibling = await deps.createGeneration({
      userId: generation.userId,
      mode: generation.mode,
      mediaType: generation.mediaType,
      provider: generation.provider,
      model: generation.model,
      prompt: generation.prompt,
      params: generation.params,
      inputAssets: [],
      status: 'generating',
    });
    const stored = await storeSingleOutput({
      generationId: sibling.id,
      userId: generation.userId,
      mediaType: generation.mediaType,
      url: extraUrl,
      config: resolvedConfig,
      deps,
    });
    await deps.updateGenerationResult(sibling.id, {
      status: 'succeeded',
      outputKey: stored.key,
      outputType: stored.contentType,
      providerRef: providerResult.replicateId || providerResult.request_id || null,
    });
  }

  const cleaned = await cleanupGenerationInputs({ generation, config: resolvedConfig, deps, env });

  return deps.updateGenerationResult(generation.id, {
    status: 'succeeded',
    outputKey: primary.key,
    outputType: primary.contentType,
    providerRef: providerResult.replicateId || providerResult.request_id || null,
    inputAssets: cleaned,
  });
}

// Run the provider for a generation given a resolved API key.
async function runProviderForGeneration({ generation, apiKey, deps }) {
  if (generation.provider === 'muapi') {
    const model = deps.getStudioModel(generation.mode, generation.model);
    if (!model) throw new Error(`Unknown Studio model "${generation.model}".`);
    return deps.runMuapiPrediction({
      apiKey,
      endpoint: model.endpoint || model.id,
      params: generation.params,
    });
  }

  const model = deps.getReplicateStudioModel(generation.mode, generation.model);
  if (!model) throw new Error(`Replicate model "${generation.model}" is unavailable.`);
  return deps.runReplicatePrediction({ apiKey, model, params: generation.params, mode: generation.mode });
}

// Process an already-claimed generation row (no claiming here). Runs the
// provider, stores outputs and cleans up inputs. On failure marks failed and
// still cleans up inputs.
export async function runClaimedGeneration(generation, injectedDeps, env = process.env) {
  const deps = injectedDeps || (await createDefaultProcessDeps());
  const config = deps.getS3Config();

  try {
    const apiKey = await deps.resolveProviderKey({
      userId: generation.userId,
      provider: generation.provider,
    });
    if (!apiKey) throw new Error('No provider API key available for this user.');

    const providerResult = await runProviderForGeneration({ generation, apiKey, deps });

    if (deps.setProviderRef && (providerResult.replicateId || providerResult.request_id)) {
      await deps.setProviderRef(generation.id, providerResult.replicateId || providerResult.request_id);
    }

    return await storeGenerationOutputs({ generation, providerResult, deps, config, env });
  } catch (error) {
    const cleaned = await cleanupGenerationInputs({ generation, config, deps, env }).catch(() => undefined);
    return deps.markGenerationFailed(generation.id, {
      error: error?.message || 'Generation failed.',
      inputAssets: cleaned,
    });
  }
}

// Worker/inline entry: atomically claim the row so inline firing and the worker
// loop never both process the same generation, then process it.
export async function processGeneration(generationId, injectedDeps, env = process.env) {
  const deps = injectedDeps || (await createDefaultProcessDeps());

  let generation;
  if (typeof deps.claimGeneration === 'function') {
    generation = await deps.claimGeneration(generationId);
    if (!generation) return null;
  } else {
    generation = await deps.getGeneration(generationId);
    if (!generation) return null;
  }

  return runClaimedGeneration(generation, deps, env);
}










