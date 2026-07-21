// Local workflow engine dispatcher. Maps the MuAPI-compatible slug paths onto
// local handlers so the workflow UI works without MuAPI. This is the "else"
// branch of the single switch point in app/api/workflow/[[...path]]/route.js.
//
// All handlers are user-scoped via `ctx.user.id` and additionally filtered by
// `ctx.provider` so provider switching also switches the visible data space.
import * as workflowsRepo from './workflowsRepo.js';
import * as runsRepo from './runsRepo.js';
import {
  serializeWorkflowSummary,
  serializeWorkflowDef,
  serializeRunStatus,
  serializeRunHistory,
  serializeApiOutputs,
} from './serialization.js';
import {
  buildNodeSchemas,
  buildApiNodeSchemas,
  buildApiInputs,
  resolveWorkflowProviderModes,
} from './schemas.js';
import {
  executeGraph,
  executeSingleNode,
  latestResultsFromRuns,
  collectTerminalOutputs,
} from './engine.js';
import { signResultOutputs, signNodeOutputs } from './outputStorage.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// Tests can omit queue wiring; production injects enqueueWorkflowRunJob from the
// route layer. The router itself must not execute runs locally.
function defaultEnqueueRun() {
  return Promise.resolve();
}

// Build a result signer that refreshes presigned S3 URLs from stored keys, or
// null when S3 helpers aren't wired (tests / non-S3 deployments).
function makeSigner(impl) {
  if (!impl.getS3Config || !impl.createPresignedGetUrl) return null;
  let config;
  try {
    config = impl.getS3Config();
  } catch {
    return null;
  }
  return (result) =>
    result ? signResultOutputs(result, { config, createPresignedGetUrl: impl.createPresignedGetUrl }) : result;
}

// Best-effort deletion of stored S3 objects (ignores missing/failed deletes and
// no-ops when S3 helpers aren't wired).
async function cleanupKeys(impl, keys) {
  if (!keys?.length || !impl.getS3Config || !impl.deleteObject) return;
  let config;
  try {
    config = impl.getS3Config();
  } catch {
    return;
  }
  for (const key of keys) {
    if (!key) continue;
    try {
      await impl.deleteObject({ config, key });
    } catch {
      // already gone / transient — ignore
    }
  }
}

function withFreshThumbnailUrl(workflow, impl) {
  if (!workflow?.thumbnailObjectKey || !impl.getS3Config || !impl.createPresignedGetUrl) return workflow;
  try {
    return {
      ...workflow,
      thumbnailKey: impl.createPresignedGetUrl({
        config: impl.getS3Config(),
        key: workflow.thumbnailObjectKey,
      }),
    };
  } catch {
    return workflow;
  }
}

// `deps` lets tests inject a fake repo. In production it defaults to the real
// Postgres-backed workflowsRepo module (matches the studio DI handler pattern).
export async function handleLocalWorkflow(request, { params }, method, ctx, deps = {}) {
  const impl = {
    ...workflowsRepo,
    ...runsRepo,
    executeGraph,
    executeSingleNode,
    enqueueRun: defaultEnqueueRun,
    ...deps,
  };
  const {
    listWorkflows,
    listTemplates,
    listPublished,
    getWorkflow,
    upsertWorkflow,
    renameWorkflow,
    deleteWorkflow,
    setPublished,
    setTemplate,
    createTemplate,
    cloneWorkflow,
    clearThumbnail,
  } = impl;

  const slug = await params;
  const path = slug?.path || [];
  const p = path.join('/');
  const scope = { userId: ctx.user.id, provider: ctx.provider };
  const callerId = ctx.user.id;

  try {
    // ---- CRUD ----
    if (method === 'GET' && p === 'get-workflow-defs') {
      const rows = await listWorkflows(scope);
      return json(rows.map((row) => serializeWorkflowSummary(withFreshThumbnailUrl(row, impl), callerId)));
    }
    if (method === 'GET' && p === 'get-template-workflows') {
      const rows = await listTemplates(scope);
      return json(rows.map((row) => serializeWorkflowSummary(withFreshThumbnailUrl(row, impl), callerId)));
    }
    if (method === 'GET' && p === 'get-published-workflows') {
      const rows = await listPublished(scope);
      return json(rows.map((row) => serializeWorkflowSummary(withFreshThumbnailUrl(row, impl), callerId)));
    }
    if (method === 'GET' && path[0] === 'get-workflow-def' && path[1]) {
      const wf = await getWorkflow(path[1], scope);
      if (!wf) return json({ error: 'Not found' }, 404);
      const def = serializeWorkflowDef(wf, ctx.user.id);
      const sign = makeSigner(impl);

      // Hydrate node outputs, per-node history and the active run straight from
      // the DB (workflow_runs / workflow_node_runs). The saved node definitions
      // only hold whatever the client last persisted (often stale provider/proxy
      // URLs); the run tables are the real source of truth, so we rebuild each
      // node's output_params from its latest succeeded run and re-sign every S3
      // key into a fresh presigned URL.
      let nodeRuns = [];
      if (impl.listWorkflowNodeRuns) {
        try {
          nodeRuns = await impl.listWorkflowNodeRuns(wf.id, { userId: ctx.user.id });
        } catch (error) {
          console.error('[workflow] failed to load node runs for def:', error?.message || error);
          nodeRuns = [];
        }
      }
      if (sign) {
        nodeRuns = nodeRuns.map((nr) => ({ ...nr, result: nr.result ? sign(nr.result) : nr.result }));
      }

      // Latest succeeded result per node → current output_params (nodeRuns is
      // chronological, so the last write wins).
      const latestSucceeded = {};
      for (const nr of nodeRuns) {
        if (nr.status === 'succeeded' && nr.result?.outputs) latestSucceeded[nr.nodeId] = nr.result;
      }
      if (Array.isArray(def?.data?.nodes)) {
        def.data.nodes = def.data.nodes.map((node) => {
          const result = latestSucceeded[node.id];
          if (result) {
            const outputs = result.outputs || [];
            return { ...node, output_params: { outputs, resultUrl: outputs[0]?.value ?? null } };
          }
          // No DB run yet for this node — fall back to re-signing whatever was
          // saved so at least stored keys refresh.
          return sign ? signNodeOutputs(node, sign) : node;
        });
      }

      def.run_history = serializeRunHistory(nodeRuns);

      let latestRun = null;
      if (impl.getLatestRunForWorkflow) {
        try {
          latestRun = await impl.getLatestRunForWorkflow(wf.id, { userId: ctx.user.id });
        } catch (error) {
          console.error('[workflow] failed to load latest run for def:', error?.message || error);
        }
      }
      if (latestRun) {
        def.run_id = latestRun.id;
        def.run_status = latestRun.status;
      }
      return json(def);
    }
    if (method === 'POST' && p === 'create') {
      const body = await readBody(request);
      const wf = await upsertWorkflow({
        id: body.workflow_id || undefined,
        userId: ctx.user.id,
        provider: ctx.provider,
        name: body.name || 'Untitled',
        category: body.category || null,
        edges: body.edges || [],
        nodes: resolveWorkflowProviderModes(ctx.provider, body.data?.nodes || []),
        sourceWorkflowId: body.source_workflow_id || null,
        expectedRevision: body.expected_revision ?? body.revision ?? null,
      });
      return json({ workflow_id: wf.id, revision: wf.revision || 1 });
    }
    if (method === 'POST' && path[0] === 'update-name' && path[1]) {
      const body = await readBody(request);
      const wf = await renameWorkflow(path[1], { userId: ctx.user.id, name: body.name });
      if (!wf) return json({ error: 'Not found' }, 404);
      return json(serializeWorkflowSummary(wf));
    }
    if (method === 'DELETE' && path[0] === 'delete-workflow-def' && path[1]) {
      // Collect the workflow's stored output keys before the rows cascade away,
      // then purge the media from S3 after the DB delete succeeds. Key collection
      // is best-effort so a lookup failure never blocks the delete.
      let keys = [];
      try {
        if (impl.getWorkflowOutputKeys) {
          keys = await impl.getWorkflowOutputKeys(path[1], { userId: ctx.user.id });
        }
      } catch (error) {
        console.error('[workflow] failed to collect output keys for cleanup:', error?.message || error);
      }
      const wf = await deleteWorkflow(path[1], { userId: ctx.user.id });
      if (!wf) return json({ error: 'Not found' }, 404);
      keys = [...new Set([...(keys || []), wf.thumbnailObjectKey].filter(Boolean))];
      await cleanupKeys(impl, keys);
      return json({ workflow_id: wf.id, deleted: true });
    }
    if (method === 'POST' && path[0] === 'workflow' && path[2] === 'publish') {
      const body = await readBody(request);
      const wf = await setPublished(path[1], { userId: ctx.user.id, published: body.publish });
      if (!wf) return json({ error: 'Not found' }, 404);
      return json({ publish: wf.published });
    }
    // POST workflow/{id}/template — publish a fresh provider-wide template clone
    // while preserving the owner's editable source workflow and its run data.
    if (method === 'POST' && path[0] === 'workflow' && path[2] === 'template') {
      const body = await readBody(request);
      if (!body.is_template) {
        const wf = await setTemplate(path[1], { userId: ctx.user.id, isTemplate: false });
        if (!wf) return json({ error: 'Not found' }, 404);
        return json({ workflow_id: wf.id, is_template: false });
      }

      const source = await getWorkflow(path[1], scope);
      if (!source || source.userId !== ctx.user.id) return json({ error: 'Not found' }, 404);
      const template = await createTemplate(path[1], scope);
      if (!template) return json({ error: 'Not found' }, 404);

      if (source.thumbnailKey) {
        try {
          const sourceUrl = source.thumbnailObjectKey && impl.createPresignedGetUrl && impl.getS3Config
            ? impl.createPresignedGetUrl({ config: impl.getS3Config(), key: source.thumbnailObjectKey })
            : source.thumbnailKey;
          await storeWorkflowThumbnail(impl, ctx, template.id, { thumbnail: sourceUrl });
        } catch (error) {
          const removed = await deleteWorkflow(template.id, { userId: ctx.user.id }).catch(() => null);
          if (removed?.thumbnailObjectKey) await cleanupKeys(impl, [removed.thumbnailObjectKey]);
          throw error;
        }
      }
      return json({ workflow_id: template.id, is_template: true });
    }
    // POST {id}/clone — copy a readable (template/published/own) workflow into a
    // new private workflow owned by the caller. Returns the new workflow_id.
    if (method === 'POST' && path[1] === 'clone') {
      const wf = await cloneWorkflow(path[0], scope);
      if (!wf) return json({ error: 'Not found' }, 404);
      return json({ workflow_id: wf.id, revision: wf.revision || 1 });
    }
    // ---- Schemas (Phase 2) ----
    if (method === 'GET' && path[1] === 'node-schemas') {
      // Global provider-scoped model catalog; workflow id (path[0]) is ignored.
      return json(buildNodeSchemas(ctx.provider));
    }
    if (method === 'GET' && (path[1] === 'api-node-schemas' || path[1] === 'api-inputs')) {
      const wf = await getWorkflow(path[0], scope);
      if (!wf) return json({ error: 'Not found' }, 404);
      if (path[1] === 'api-node-schemas') return json(buildApiNodeSchemas(wf));
      return json(buildApiInputs(wf));
    }

    // ---- Execution (Phase 3) ----
    // POST {id}/run — start a full-graph run.
    if (method === 'POST' && path[1] === 'run' && path.length === 2) {
      return startRun(impl, ctx, path[0]);
    }
    // POST {id}/node/{nodeId}/run — start a single-node run within a run.
    if (method === 'POST' && path[1] === 'node' && path[3] === 'run') {
      const body = await readBody(request);
      return startNodeRun(impl, ctx, path[0], path[2], body);
    }
    // GET run/{runId}/status — aggregated node-run status the UI polls.
    if (method === 'GET' && path[0] === 'run' && path[2] === 'status') {
      return runStatus(impl, ctx, path[1]);
    }
    // GET runs/stream — Server-Sent Events push of node-run status changes for
    // the user (event-based updates, like Image Studio's generations stream).
    if (method === 'GET' && p === 'runs/stream') {
      return streamRuns(impl, ctx, request);
    }
    // DELETE node-run/{nodeRunId}
    if (method === 'DELETE' && path[0] === 'node-run' && path[1]) {
      const deleted = await impl.deleteNodeRun(path[1], { userId: ctx.user.id });
      if (!deleted) return json({ error: 'Not found' }, 404);
      // Purge this node-run's stored media from S3.
      await cleanupKeys(impl, deleted.outputKeys);
      return json({ node_run_id: deleted.id, deleted: true });
    }

    // ---- Playground API (Phase 4) ----
    // POST {id}/api-execute — run the graph with exposed inputs.
    if (method === 'POST' && path[1] === 'api-execute') {
      const body = await readBody(request);
      return apiExecute(impl, ctx, path[0], body?.inputs || {});
    }
    // GET run/{runId}/api-outputs — terminal outputs for the playground.
    if (method === 'GET' && path[0] === 'run' && path[2] === 'api-outputs') {
      return apiOutputs(impl, ctx, path[1]);
    }
    // POST {id}/thumbnail — persist a cover image URL for the workflow.
    if (method === 'POST' && path[1] === 'thumbnail') {
      return await saveThumbnail(impl, ctx, path[0], request);
    }
    if (method === 'DELETE' && path[1] === 'thumbnail' && path.length === 2) {
      const workflow = await clearThumbnail(path[0], { userId: ctx.user.id });
      if (!workflow) return json({ error: 'Not found' }, 404);
      await cleanupKeys(impl, [workflow.removedThumbnailObjectKey]);
      return json({ success: true, thumbnail: null });
    }

    return json({ error: `Unknown workflow endpoint: ${method} ${p}` }, 404);
  } catch (error) {
    if (error?.code === 'WORKFLOW_REVISION_CONFLICT') {
      return json({
        error: {
          code: 'WORKFLOW_REVISION_CONFLICT',
          message: error.message,
          current_revision: error.currentRevision,
          expected_revision: error.expectedRevision,
        },
      }, 409);
    }
    if (error?.status) return json({ error: error.message }, error.status);
    console.error('[workflow] local handler error:', error);
    return json({ error: error.message || 'Internal error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// Execution handlers (Phase 3/4/6)
// ---------------------------------------------------------------------------
//
// Runs are executed asynchronously by the run processor / worker loop (see
// runProcessor.js, worker.js). The handlers here only persist the run + seed the
// node-run rows, then hand off via `enqueueRun`. The UI polls run/{id}/status
// (or subscribes to runs/stream); because the work happens server-side it keeps
// going even if the user navigates away or refreshes.

// Pre-create one queued node-run per graph node so the UI knows the full run
// shape, while the engine can flip only actively executing nodes to running.
async function seedNodeRuns(impl, runId, nodes) {
  const nodeRunIds = {};
  for (const node of nodes) {
    const nr = await impl.createNodeRun({
      runId,
      nodeId: node.id,
      model: node.model || null,
      params: node.params || {},
      status: 'queued',
    });
    nodeRunIds[node.id] = nr.id;
  }
  return nodeRunIds;
}

async function startRun(impl, ctx, workflowId) {
  const scope = { userId: ctx.user.id, provider: ctx.provider };
  const wf = await impl.getWorkflow(workflowId, scope);
  if (!wf) return json({ error: 'Not found' }, 404);

  const nodes = wf.nodes || [];
  const run = await impl.createRun({
    workflowId: wf.id,
    userId: ctx.user.id,
    provider: ctx.provider,
    inputs: {},
  });
  await seedNodeRuns(impl, run.id, nodes);
  await impl.enqueueRun(run);
  await impl.publishWorkflowEvent?.({
    userId: ctx.user.id,
    workflowId: wf.id,
    runId: run.id,
    status: run.status,
    queueStatus: 'queued',
  });
  return json({ run_id: run.id });
}

async function startNodeRun(impl, ctx, workflowId, nodeId, body) {
  const scope = { userId: ctx.user.id, provider: ctx.provider };
  const wf = await impl.getWorkflow(workflowId, scope);
  if (!wf) return json({ error: 'Not found' }, 404);

  const node = (wf.nodes || []).find((n) => n.id === nodeId);
  if (!node) return json({ error: 'Node not found' }, 404);

  // A single-node execution is its own run (target_node_id set). The worker
  // resolves upstream inputs from whatever this workflow generated before, plus
  // the client-submitted (schema-resolved) params we persist on the node-run.
  const params = body?.params || node.params || {};
  const model = body?.model || node.model || null;
  const submittedResults = body?.upstream_results && typeof body.upstream_results === 'object' && !Array.isArray(body.upstream_results)
    ? body.upstream_results
    : {};
  const workflowNodeIds = new Set((wf.nodes || []).map((workflowNode) => workflowNode.id));
  const upstreamResults = Object.fromEntries(
    Object.entries(submittedResults).filter(([upstreamNodeId, outputs]) =>
      upstreamNodeId !== nodeId && workflowNodeIds.has(upstreamNodeId) && Array.isArray(outputs)
    )
  );

  const run = await impl.createRun({
    workflowId: wf.id,
    userId: ctx.user.id,
    provider: ctx.provider,
    targetNodeId: nodeId,
    inputs: { upstreamResults },
  });
  await impl.createNodeRun({ runId: run.id, nodeId, model, params });
  await impl.enqueueRun(run);
  await impl.publishWorkflowEvent?.({
    userId: ctx.user.id,
    workflowId: wf.id,
    runId: run.id,
    status: run.status,
    queueStatus: 'queued',
  });
  return json({ run_id: run.id });
}

async function runStatus(impl, ctx, runId) {
  const run = await impl.getRun(runId, { userId: ctx.user.id });
  if (!run) return json({ error: 'Not found' }, 404);
  const nodeRuns = await impl.listNodeRuns(runId);
  const sign = makeSigner(impl);
  const signed = sign
    ? nodeRuns.map((nr) => ({ ...nr, result: sign(nr.result) }))
    : nodeRuns;
  return json(serializeRunStatus(signed, run));
}

async function apiExecute(impl, ctx, workflowId, inputs) {
  const scope = { userId: ctx.user.id, provider: ctx.provider };
  const wf = await impl.getWorkflow(workflowId, scope);
  if (!wf) return json({ error: 'Not found' }, 404);

  const nodes = wf.nodes || [];
  const run = await impl.createRun({
    workflowId: wf.id,
    userId: ctx.user.id,
    provider: ctx.provider,
    inputs,
  });
  await seedNodeRuns(impl, run.id, nodes);
  await impl.enqueueRun(run);
  await impl.publishWorkflowEvent?.({
    userId: ctx.user.id,
    workflowId: wf.id,
    runId: run.id,
    status: run.status,
    queueStatus: 'queued',
  });
  return json({ run_id: run.id });
}

async function apiOutputs(impl, ctx, runId) {
  const run = await impl.getRun(runId, { userId: ctx.user.id });
  if (!run) return json({ error: 'Not found' }, 404);
  const nodeRuns = await impl.listNodeRuns(runId);
  const results = latestResultsFromRuns(nodeRuns);
  const wf = await impl.getWorkflow(run.workflowId, {
    userId: ctx.user.id,
    provider: ctx.provider,
  });
  let outputs = collectTerminalOutputs(wf?.nodes || [], wf?.edges || [], results);
  const sign = makeSigner(impl);
  if (sign) outputs = sign({ outputs }).outputs;
  return json(serializeApiOutputs(run, outputs, nodeRuns));
}

// Server-Sent Events stream of node-run status changes for the authenticated
// user. Internally polls listUpdatedNodeRuns on updated_at but holds one long-
// lived connection so the client doesn't poll (mirrors the studio stream).
// Emits an `id:` (the row's updated_at) with every frame and honours the
// `Last-Event-ID` reconnect header so no updates are missed across reconnects.
function streamRuns(impl, ctx, request) {
  if (!impl.listUpdatedNodeRuns) {
    return json({ error: 'Streaming not available' }, 501);
  }
  const encoder = new TextEncoder();
  const sign = makeSigner(impl);
  const intervalMs = impl.streamIntervalMs || 2000;
  const heartbeatMs = impl.streamHeartbeatMs || 15000;

  // Resume from the last delivered event when the browser reconnects.
  const lastEventId = request?.headers?.get?.('last-event-id');
  const resumeAt = lastEventId ? new Date(lastEventId) : null;
  // On a brand-new connection (no Last-Event-ID) look back a few seconds so the
  // just-seeded "processing" node-runs — created right before the client opens
  // the stream — are replayed. Without this the UI never receives the initial
  // loading state and nodes don't show "generating". Consumers filter by run_id,
  // so replaying a little recent history is harmless.
  const initialLookbackMs = impl.streamInitialLookbackMs ?? 15000;
  let since = resumeAt && !Number.isNaN(resumeAt.getTime())
    ? resumeAt
    : new Date(Date.now() - initialLookbackMs);
  let pollTimer = null;
  let heartbeatTimer = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (id, payload) =>
        controller.enqueue(encoder.encode(`id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`));
      const comment = (text) => controller.enqueue(encoder.encode(`: ${text}\n\n`));
      comment('connected');

      const tick = async () => {
        try {
          const rows = await impl.listUpdatedNodeRuns({ userId: ctx.user.id, since });
          for (const row of rows) {
            const updatedAt = row.streamUpdatedAt || row.updatedAt;
            if (updatedAt && new Date(updatedAt) > since) since = new Date(updatedAt);
            const eventId = updatedAt ? new Date(updatedAt).toISOString() : new Date().toISOString();
            send(eventId, {
              run_id: row.runId,
              workflow_id: row.workflowId,
              node_id: row.nodeId,
              node_run_id: row.id,
              status: row.status,
              run_status: row.runStatus,
              result: sign ? sign(row.result) : row.result,
              error: row.error || null,
            });
          }
        } catch {
          // transient DB error — keep the connection open, retry next tick
        }
      };

      pollTimer = setInterval(tick, intervalMs);
      heartbeatTimer = setInterval(() => comment('keep-alive'), heartbeatMs);
      // Deliver the current snapshot right away instead of waiting a full poll
      // interval, so the loading state appears immediately on connect.
      tick();

      const abort = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      if (request?.signal) {
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

const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;

function thumbnailError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function thumbnailExtension(name, contentType) {
  const mimeExtensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  if (mimeExtensions[contentType]) return mimeExtensions[contentType];
  const match = String(name || '').split(/[?#]/)[0].match(/\.([a-zA-Z0-9]{1,8})$/);
  return match?.[1]?.toLowerCase() || 'img';
}

async function thumbnailPayload(impl, source) {
  if (source?.file && typeof source.file.arrayBuffer === 'function') {
    const contentType = source.file.type || 'application/octet-stream';
    if (!contentType.startsWith('image/')) throw thumbnailError('Thumbnail must be an image', 415);
    if (source.file.size > MAX_THUMBNAIL_BYTES) throw thumbnailError('Thumbnail must be 10 MB or smaller', 413);
    return {
      body: Buffer.from(await source.file.arrayBuffer()),
      contentType,
      name: source.file.name,
    };
  }

  if (!source?.thumbnail || !/^https?:\/\//i.test(source.thumbnail)) {
    throw thumbnailError('Thumbnail image or URL is required', 400);
  }
  const response = await (impl.fetchFn || fetch)(source.thumbnail);
  if (!response.ok) throw thumbnailError(`Could not download thumbnail (${response.status})`, 422);
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType && !contentType.startsWith('image/')) throw thumbnailError('Thumbnail URL must point to an image', 415);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_THUMBNAIL_BYTES) throw thumbnailError('Thumbnail must be 10 MB or smaller', 413);
  return { body, contentType: contentType || 'application/octet-stream', name: source.thumbnail };
}

async function storeWorkflowThumbnail(impl, ctx, workflowId, source) {
  if (!impl.getS3Config || !impl.createWorkflowThumbnailObjectKey || !impl.uploadObject) {
    throw thumbnailError('Thumbnail storage is not configured', 503);
  }

  const workflow = await impl.getWorkflow(workflowId, { userId: ctx.user.id, provider: ctx.provider });
  if (!workflow || workflow.userId !== ctx.user.id) throw thumbnailError('Not found', 404);

  const payload = await thumbnailPayload(impl, source);
  const config = impl.getS3Config();
  const key = impl.createWorkflowThumbnailObjectKey({
    userId: ctx.user.id,
    workflowId,
    ext: thumbnailExtension(payload.name, payload.contentType),
  });

  let uploaded = false;
  try {
    const thumbnailUrl = await impl.uploadObject({
      config,
      key,
      body: payload.body,
      contentType: payload.contentType,
    });
    uploaded = true;
    const saved = await impl.setThumbnail(workflowId, {
      userId: ctx.user.id,
      thumbnailUrl,
      thumbnailObjectKey: key,
    });
    if (!saved) throw thumbnailError('Not found', 404);
    if (saved.replacedThumbnailObjectKey && saved.replacedThumbnailObjectKey !== key) {
      await cleanupKeys(impl, [saved.replacedThumbnailObjectKey]);
    }
    return saved;
  } catch (error) {
    if (uploaded) await cleanupKeys(impl, [key]);
    throw error;
  }
}

async function saveThumbnail(impl, ctx, workflowId, request) {
  const contentType = request.headers.get('content-type') || '';
  let source;
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    const form = await request.formData();
    source = { file: form.get('thumbnail') || form.get('file') };
  } else {
    source = await readBody(request);
  }
  const workflow = await storeWorkflowThumbnail(impl, ctx, workflowId, source);
  return json({ success: true, thumbnail: workflow.thumbnailKey });
}

