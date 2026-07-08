// Local workflow engine dispatcher. Maps the MuAPI-compatible slug paths onto
// local handlers so the workflow UI works without MuAPI. This is the "else"
// branch of the single switch point in app/api/workflow/[[...path]]/route.js.
//
// All handlers are user-scoped via `ctx.user.id` and additionally filtered by
// `ctx.provider` so provider switching also switches the visible data space.
import * as workflowsRepo from './workflowsRepo.js';
import * as runsRepo from './runsRepo.js';
import * as architectRepo from './architectRepo.js';
import {
  serializeWorkflowSummary,
  serializeWorkflowDef,
  serializeRunStatus,
  serializeRunHistory,
  serializeApiOutputs,
  serializeArchitectResult,
} from './serialization.js';
import {
  buildNodeSchemas,
  buildApiNodeSchemas,
  buildApiInputs,
} from './schemas.js';
import {
  executeGraph,
  executeSingleNode,
  latestResultsFromRuns,
  collectTerminalOutputs,
} from './engine.js';
import { signResultOutputs, signNodeOutputs } from './outputStorage.js';
import { generateWorkflowDef } from './architect.js';

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

// Default async enqueue: hand the run off to the run processor on a microtask so
// the HTTP response returns immediately and the graph keeps executing server-
// side (surviving page navigation/refresh). processRun atomically claims the run
// so this and the worker loop never double-process it. The `@/`-heavy processor
// is imported lazily so this module stays importable under `node --test`.
function defaultEnqueueRun(runId) {
  Promise.resolve()
    .then(async () => {
      const { processRun } = await import('./runProcessor.js');
      return processRun(runId);
    })
    .catch((error) => console.error('[workflow] run failed:', error));
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

// `deps` lets tests inject a fake repo. In production it defaults to the real
// Postgres-backed workflowsRepo module (matches the studio DI handler pattern).
export async function handleLocalWorkflow(request, { params }, method, ctx, deps = {}) {
  const impl = {
    ...workflowsRepo,
    ...runsRepo,
    ...architectRepo,
    executeGraph,
    executeSingleNode,
    generateWorkflowDef,
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
    cloneWorkflow,
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
      return json(rows.map((row) => serializeWorkflowSummary(row, callerId)));
    }
    if (method === 'GET' && p === 'get-template-workflows') {
      const rows = await listTemplates(scope);
      return json(rows.map((row) => serializeWorkflowSummary(row, callerId)));
    }
    if (method === 'GET' && p === 'get-published-workflows') {
      const rows = await listPublished(scope);
      return json(rows.map((row) => serializeWorkflowSummary(row, callerId)));
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
        nodes: body.data?.nodes || [],
        sourceWorkflowId: body.source_workflow_id || null,
      });
      return json({ workflow_id: wf.id });
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
      await cleanupKeys(impl, keys);
      return json({ workflow_id: wf.id, deleted: true });
    }
    if (method === 'POST' && path[0] === 'workflow' && path[2] === 'publish') {
      const body = await readBody(request);
      const wf = await setPublished(path[1], { userId: ctx.user.id, published: body.publish });
      if (!wf) return json({ error: 'Not found' }, 404);
      return json({ publish: wf.published });
    }
    // POST workflow/{id}/template — mark/unmark as a provider-wide template so it
    // shows up in every user's Templates list (owner only).
    if (method === 'POST' && path[0] === 'workflow' && path[2] === 'template') {
      const body = await readBody(request);
      const wf = await setTemplate(path[1], { userId: ctx.user.id, isTemplate: body.is_template });
      if (!wf) return json({ error: 'Not found' }, 404);
      return json({ is_template: wf.isTemplate });
    }
    // POST {id}/clone — copy a readable (template/published/own) workflow into a
    // new private workflow owned by the caller. Returns the new workflow_id.
    if (method === 'POST' && path[1] === 'clone') {
      const wf = await cloneWorkflow(path[0], scope);
      if (!wf) return json({ error: 'Not found' }, 404);
      return json({ workflow_id: wf.id });
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
      const body = await readBody(request);
      return saveThumbnail(impl, ctx, path[0], body);
    }

    // ---- AI generation (Phase 5) ----
    // POST architect — generate a workflow graph from a prompt via an LLM.
    if (method === 'POST' && p === 'architect') {
      const body = await readBody(request);
      return architect(impl, ctx, body);
    }
    // GET poll-architect/{request_id}/result — poll the generated result.
    if (method === 'GET' && path[0] === 'poll-architect' && path[2] === 'result') {
      return architectResult(impl, ctx, path[1]);
    }

    return json({ error: `Unknown workflow endpoint: ${method} ${p}` }, 404);
  } catch (error) {
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

// Pre-create one processing node-run per graph node so the UI shows every node
// as loading and the "all succeeded" poll check sees the full node set.
async function seedNodeRuns(impl, runId, nodes) {
  const nodeRunIds = {};
  for (const node of nodes) {
    const nr = await impl.createNodeRun({
      runId,
      nodeId: node.id,
      model: node.model || null,
      params: node.params || {},
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
  await impl.enqueueRun(run.id);
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

  const run = await impl.createRun({
    workflowId: wf.id,
    userId: ctx.user.id,
    provider: ctx.provider,
    targetNodeId: nodeId,
    inputs: {},
  });
  await impl.createNodeRun({ runId: run.id, nodeId, model, params });
  await impl.enqueueRun(run.id);
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
  await impl.enqueueRun(run.id);
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
  return json(serializeApiOutputs(run, outputs));
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
            if (row.updatedAt && new Date(row.updatedAt) > since) since = new Date(row.updatedAt);
            const eventId = row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date().toISOString();
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

// ---------------------------------------------------------------------------
// Thumbnail + AI architect handlers (Phase 5)
// ---------------------------------------------------------------------------

async function saveThumbnail(impl, ctx, workflowId, body) {
  const thumbnail = body?.thumbnail;
  if (!thumbnail) return json({ error: 'Thumbnail URL is required' }, 400);
  const wf = await impl.setThumbnail(workflowId, {
    userId: ctx.user.id,
    thumbnailKey: thumbnail,
  });
  if (!wf) return json({ error: 'Not found' }, 404);
  return json({ success: true });
}

// Generate a workflow graph from a prompt. The LLM call runs synchronously and
// the result is persisted, so the client's poll immediately sees `completed`
// (or `failed` with a helpful message when no LLM is configured).
async function architect(impl, ctx, body) {
  const prompt = body?.prompt;
  if (!prompt || !String(prompt).trim()) {
    return json({ error: 'A prompt is required' }, 400);
  }
  const req = await impl.createArchitectRequest({
    userId: ctx.user.id,
    provider: ctx.provider,
    workflowId: body?.workflow_id || null,
    prompt,
  });

  try {
    const result = await impl.generateWorkflowDef({
      prompt,
      history: body?.history || [],
      provider: ctx.provider,
    });
    await impl.updateArchitectRequest(req.id, { status: 'completed', result });
  } catch (error) {
    await impl.updateArchitectRequest(req.id, { status: 'failed', error: error.message });
  }

  return json({ request_id: req.id, status: 'processing' });
}

async function architectResult(impl, ctx, requestId) {
  const req = await impl.getArchitectRequest(requestId, { userId: ctx.user.id });
  if (!req) return json({ error: 'Not found' }, 404);
  return json(serializeArchitectResult(req));
}




