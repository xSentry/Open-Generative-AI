function json(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}


function badRequest(message, code = 'invalid_request') {
  return json({ error: code, message }, { status: 400 });
}

function typedError(error) {
  return error?.status && error?.code
    ? json({ error: error.code, message: error.message }, { status: error.status })
    : null;
}

function uploadError(error, message, status) {
  return json({ error, message }, { status });
}

// Scan generation params for references to our own studio-uploads/* objects so
// the worker can clean them up after the generation finishes.
function extractInputAssets(params = {}) {
  const assets = [];
  const seen = new Set();

  const consider = (role, value) => {
    if (typeof value !== 'string' || !value) return;
    const match = value.match(/studio-uploads\/[^?"'\s]+/);
    if (!match) return;
    const key = match[0];
    if (seen.has(key)) return;
    seen.add(key);
    assets.push({ key, url: value, role, deleted: false });
  };

  for (const [role, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((item) => consider(role, item));
    } else {
      consider(role, value);
    }
  }

  return assets;
}

function isAsyncEnabled(deps) {
  if (typeof deps.isAsyncEnabled === 'function') return deps.isAsyncEnabled();
  const value = deps.env?.STUDIO_ASYNC_GENERATIONS;
  return String(value ?? '').toLowerCase() === 'true';
}

export function serializeGeneration(generation, deps) {
  if (!generation) return null;
  let url = null;
  if (generation.outputKey && deps?.createPresignedGetUrl && deps?.getS3Config) {
    try {
      url = deps.createPresignedGetUrl({ config: deps.getS3Config(), key: generation.outputKey });
    } catch {
      url = null;
    }
  }
  return {
    id: generation.id,
    mode: generation.mode,
    mediaType: generation.mediaType,
    provider: generation.provider,
    model: generation.model,
    prompt: generation.prompt,
    params: generation.params || {},
    status: generation.status,
    url,
    outputType: generation.outputType || null,
    outputMeta: generation.outputMeta || null,
    error: generation.error || null,
    createdAt: generation.createdAt,
    completedAt: generation.completedAt || null,
  };
}

export async function handleStudioModelsRequest(request, deps) {
  try {
    const { provider } = await deps.getActiveProviderKey(request);

    if (provider === 'muapi') {
      return json({
        provider,
        models: deps.getSerializableStudioModelLists(),
        unavailableCounts: {},
      });
    }

    return json({
      provider: 'replicate',
      models: deps.getSerializableReplicateModelLists(),
      unavailableCounts: deps.getReplicateUnavailableCounts(),
    });
  } catch (error) {
    const { body, status } = deps.errorResponse(error);
    return json(body, { status });
  }
}

export async function handleStudioGenerateRequest(request, deps) {
  try {
    const active = await deps.getActiveProviderKey(request);
    const { provider, apiKey } = active;
    if (!apiKey) {
      return json(
        { error: 'missing_provider_key', message: deps.getProviderMissingKeyMessage(provider) },
        { status: 401 }
      );
    }

    const body = await request.json();
    const mode = body?.mode;
    const modelId = body?.model;
    const params = body?.params || {};

    // Validate the model up-front and capture a runner closure per provider.
    let runProvider;
    if (provider === 'muapi') {
      const studioModel = deps.getStudioModel(mode, modelId);
      if (!studioModel) {
        return badRequest(`Unknown Studio model "${modelId}" for mode "${mode}".`, 'unknown_model');
      }
      runProvider = () =>
        deps.runMuapiPrediction({ apiKey, endpoint: studioModel.endpoint || studioModel.id, params });
    } else {
      const replicateModel = deps.getReplicateStudioModel(mode, modelId);
      if (!replicateModel) {
        return badRequest(
          `Model "${modelId}" is not available for Replicate in mode "${mode}".`,
          'unsupported_replicate_model'
        );
      }
      runProvider = () => deps.runReplicatePrediction({ apiKey, model: replicateModel, params, mode });
    }

    // Persistence is enabled when the route wires DB deps and a user is present.
    const userId = active.user?.id;
    const persistenceEnabled = Boolean(deps.createGeneration && userId);

    if (persistenceEnabled) {
      const mediaType = deps.mediaTypeForMode ? deps.mediaTypeForMode(mode) : 'image';
      const prompt = typeof params.prompt === 'string' ? params.prompt : null;
      const inputAssets = extractInputAssets(params);

      const generation = await deps.createGeneration({
        userId,
        mode,
        mediaType,
        provider: provider === 'muapi' ? 'muapi' : 'replicate',
        model: modelId,
        prompt,
        params,
        inputAssets,
      });

      // Async flow: return immediately, worker/detached task finishes the job.
      if (isAsyncEnabled(deps)) {
        if (typeof deps.enqueueGeneration === 'function') {
          Promise.resolve(deps.enqueueGeneration(generation.id)).catch(() => {});
        }
        return json({ generations: [serializeGeneration(generation, deps)] }, { status: 202 });
      }

      // Synchronous flow (Phase 1): run provider, store output, return the row.
      const providerResult = await runProvider();
      const stored = await deps.storeGenerationOutputs({ generation, providerResult });
      return json({ generation: serializeGeneration(stored, deps) });
    }

    // Legacy (no persistence): behave exactly as before.
    const result = await runProvider();
    return json({ ...result, model: modelId, provider: provider === 'muapi' ? 'muapi' : 'replicate' });
  } catch (error) {
    const typedResponse = typedError(error);
    if (typedResponse) return typedResponse;

    const { body, status } = deps.errorResponse(error);
    if (status !== 500) {
      return json(body, { status });
    }

    return json(
      { error: 'generation_failed', message: error.message || 'Generation failed.' },
      { status: error.status || 500 }
    );
  }
}

export async function handleStudioUploadRequest(request, deps) {
  try {
    const user = await deps.requireUser(request);
    const { provider } = await deps.getActiveProviderKey(request);
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || typeof file.arrayBuffer !== 'function') {
      return uploadError('invalid_file', 'A file field is required.', 400);
    }

    if (file.size <= 0) {
      return uploadError('invalid_file', 'Uploaded file is empty.', 400);
    }

    if (file.size > deps.maxUploadBytes) {
      return uploadError('file_too_large', 'Uploaded file is larger than 250 MB.', 413);
    }

    const config = deps.getS3Config();
    const readBaseUrl = config.publicBaseUrl || config.endpoint || '';
    if (provider === 'replicate' && !readBaseUrl.startsWith('https://')) {
      return uploadError(
        'upload_url_not_public',
        'Replicate uploads require an HTTPS S3_PUBLIC_BASE_URL or deployed HTTPS bucket endpoint.',
        500
      );
    }

    const key = deps.createObjectKey({ userId: user.id, filename: file.name });
    const url = await deps.uploadObject({
      config,
      key,
      body: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || 'application/octet-stream',
    });

    return json({ url, file_url: url, key });
  } catch (error) {
    const { body, status } = deps.errorResponse(error);
    if (status !== 500) {
      return json(body, { status });
    }
    return uploadError('upload_failed', error.message || 'File upload failed.', error.status || 500);
  }
}

export async function handleMuapiV1PostRequest(request, { path, deps }) {
  try {
    const body = await request.text();
    const activeProvider = await deps.getActiveProviderKey(request);

    if (activeProvider.provider === 'replicate') {
      const replicateMatch = deps.findReplicateModelByEndpoint(path);

      if (replicateMatch) {
        if (!activeProvider.apiKey) {
          return json(
            { error: 'missing_provider_key', message: deps.getProviderMissingKeyMessage('replicate') },
            { status: 401 }
          );
        }

        const payload = body ? JSON.parse(body) : {};
        const result = await deps.runReplicatePrediction({
          apiKey: activeProvider.apiKey,
          model: replicateMatch.model,
          params: payload,
          mode: replicateMatch.mode,
        });

        return json({ ...result, model: replicateMatch.model.id, provider: 'replicate' });
      }
    }

    if (activeProvider.provider === 'muapi' && !activeProvider.apiKey) {
      return json(
        { error: 'missing_provider_key', message: deps.getProviderMissingKeyMessage('muapi') },
        { status: 401 }
      );
    }

    return deps.proxyMuapiV1Request({
      request,
      path,
      apiKey: activeProvider.provider === 'muapi' ? activeProvider.apiKey : deps.getRequestApiKey(request),
      body,
    });
  } catch (error) {
    const typedResponse = typedError(error);
    if (typedResponse) return typedResponse;

    const { body, status } = deps.errorResponse(error);
    if (status !== 500) {
      return json(body, { status });
    }

    return json(
      { error: 'proxy_request_failed', message: error.message },
      { status: error.status || 500 }
    );
  }
}

export async function handleListGenerationsRequest(request, deps) {
  try {
    const user = await deps.requireUser(request);
    const url = new URL(request.url);
    const mediaType = url.searchParams.get('mediaType') || undefined;
    // `mode` supports a comma-separated list so tools spanning several modes
    // (e.g. Video Studio: t2v,i2v,v2v) can scope their history in one request.
    const rawMode = url.searchParams.get('mode') || undefined;
    const modeValues = rawMode
      ? rawMode.split(',').map((value) => value.trim()).filter(Boolean)
      : [];
    const mode = modeValues.length > 1 ? modeValues : modeValues[0] || undefined;
    const status = url.searchParams.get('status') || undefined;
    const limit = url.searchParams.get('limit') || undefined;
    const cursorCreatedAt = url.searchParams.get('cursorCreatedAt');
    const cursorId = url.searchParams.get('cursorId');
    const cursor = cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : undefined;

    const { items, nextCursor } = await deps.listGenerations({
      userId: user.id,
      mediaType,
      mode,
      status,
      limit,
      cursor,
    });

    return json({
      items: items.map((item) => serializeGeneration(item, deps)),
      nextCursor,
    });
  } catch (error) {
    const { body, status } = deps.errorResponse(error);
    return json(body, { status });
  }
}

export async function handleGetGenerationRequest(request, { id, deps }) {
  try {
    const user = await deps.requireUser(request);
    const generation = await deps.getGeneration(id, user.id);
    if (!generation) {
      return json({ error: 'not_found', message: 'Generation not found.' }, { status: 404 });
    }
    return json({ generation: serializeGeneration(generation, deps) });
  } catch (error) {
    const { body, status } = deps.errorResponse(error);
    return json(body, { status });
  }
}

export async function handleDeleteGenerationRequest(request, { id, deps }) {
  try {
    const user = await deps.requireUser(request);
    const generation = await deps.getGeneration(id, user.id);
    if (!generation) {
      return json({ error: 'not_found', message: 'Generation not found.' }, { status: 404 });
    }

    const config = deps.getS3Config();
    // Delete stored output object (ignore missing).
    if (generation.outputKey) {
      try {
        await deps.deleteObject({ config, key: generation.outputKey });
      } catch {
        // ignore
      }
    }
    // Safety net: remove any input assets still flagged present.
    for (const asset of generation.inputAssets || []) {
      if (asset?.key && !asset.deleted) {
        try {
          await deps.deleteObject({ config, key: asset.key });
        } catch {
          // ignore
        }
      }
    }

    await deps.deleteGeneration(id, user.id);
    return json({ deleted: true });
  } catch (error) {
    const { body, status } = deps.errorResponse(error);
    return json(body, { status });
  }
}

// Server-Sent Events stream that pushes incremental generation status changes
// for the authenticated user. Uses DB polling on `updated_at` internally but
// holds a single long-lived connection so the client doesn't poll.
export async function handleGenerationsStreamRequest(request, deps) {
  let user;
  try {
    user = await deps.requireUser(request);
  } catch (error) {
    const { body, status } = deps.errorResponse(error);
    return json(body, { status });
  }

  const encoder = new TextEncoder();
  const intervalMs = deps.intervalMs || 2000;
  const heartbeatMs = deps.heartbeatMs || 15000;
  let since = new Date();
  let pollTimer = null;
  let heartbeatTimer = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const comment = (text) => {
        controller.enqueue(encoder.encode(`: ${text}\n\n`));
      };

      comment('connected');

      const tick = async () => {
        try {
          const rows = await deps.listUpdatedGenerations({ userId: user.id, since });
          for (const row of rows) {
            if (row.updatedAt && new Date(row.updatedAt) > since) {
              since = new Date(row.updatedAt);
            }
            send(serializeGeneration(row, deps));
          }
        } catch {
          // transient DB error; keep the connection open and retry next tick
        }
      };

      pollTimer = setInterval(tick, intervalMs);
      heartbeatTimer = setInterval(() => comment('keep-alive'), heartbeatMs);

      const abort = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      if (request.signal) {
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort);
      }
    },
    cancel() {
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

