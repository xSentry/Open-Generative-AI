// Core workflow run processing: atomically claim a pending run, resolve the
// user's provider key, execute the graph (or a single node) via the engine, and
// mirror media outputs into our S3 bucket. Dependencies are injected so the
// logic is unit-testable without real DB/S3/network.
//
// Heavy `@/`-aliased modules are pulled in lazily inside createDefaultRunDeps()
// so importing the pure functions in tests doesn't require Next's alias
// resolution (mirrors modules/studio/server/processGeneration.js).
import { executeGraph, executeSingleNode, latestResultsFromRuns } from './engine.js';
import { executeNode as defaultExecuteNode, estimateReplicateNodeRuntime } from './nodeExecutors.js';
import { storeNodeOutputs, signResultOutputs } from './outputStorage.js';

function nodeNeedsProviderCredential(node) {
  const category = node?.category;
  const model = node?.model;
  if (category === 'utility') return false;
  if (typeof model === 'string' && model.endsWith('-passthrough')) return false;
  if (category === 'text' && (!model || model === 'text-passthrough')) return false;
  if (!category) return true;
  return ['text', 'image', 'video', 'audio'].includes(category);
}

export async function createDefaultRunDeps() {
  const [
    s3,
    runsRepo,
    workflowsRepo,
    { getUserProviderCredential },
    { publishUserEvent, workflowRunEvent },
  ] = await Promise.all([
    import('../../storage/server/s3.js'),
    import('./runsRepo.js'),
    import('./workflowsRepo.js'),
    import('../../providers/server/credentials.js'),
    import('../../events/server/publisher.js'),
  ]);

  return {
    // runs repo
    getRun: runsRepo.getRun,
    claimRun: runsRepo.claimRun,
    updateRun: runsRepo.updateRun,
    updateNodeRun: runsRepo.updateNodeRun,
    listNodeRuns: runsRepo.listNodeRuns,
    latestResultsForWorkflow: runsRepo.latestResultsForWorkflow,
    // workflows repo
    getWorkflowById: workflowsRepo.getWorkflowById,
    // s3
    getS3Config: s3.getS3Config,
    createWorkflowOutputObjectKey: s3.createWorkflowOutputObjectKey,
    uploadObject: s3.uploadObject,
    createPresignedGetUrl: s3.createPresignedGetUrl,
    // engine + inference
    executeGraph,
    executeSingleNode,
    executeNode: defaultExecuteNode,
    estimateNodeRuntime: estimateReplicateNodeRuntime,
    fetchFn: (...args) => fetch(...args),
    publishWorkflowEvent: (event) =>
      publishUserEvent(event.userId, workflowRunEvent(event)),
    resolveProviderKey: ({ userId, provider }) => getUserProviderCredential(userId, provider),
  };
}

// Execute an already-claimed run: load the graph, resolve the key, and run the
// engine with an S3-mirroring storeOutputs hook.
export async function runClaimedRun(run, injectedDeps) {
  const deps = injectedDeps || (await createDefaultRunDeps());
  const config = deps.getS3Config();

  // The browser's shared event stream hydrates the run status whenever it
  // receives a workflow notification. Publish after every persisted run/node
  // transition, not only when the BullMQ job starts and ends, so long-running
  // graphs visibly advance from queued -> running -> generated node by node.
  // Event delivery is best-effort: a Redis outage must not fail the workflow.
  const publishUpdate = async ({ nodeRunId = null, status = null, error = null } = {}) => {
    if (!deps.publishWorkflowEvent) return;
    try {
      await deps.publishWorkflowEvent({
        userId: run.userId,
        workflowId: run.workflowId,
        runId: run.id,
        nodeRunId,
        status,
        error,
      });
    } catch {
      // The persisted status remains authoritative and clients can still poll.
    }
  };

  const eventedRepo = {
    ...deps,
    updateRun: async (id, patch) => {
      const updated = await deps.updateRun(id, patch);
      await publishUpdate({ status: updated?.status || patch?.status, error: updated?.error || patch?.error });
      return updated;
    },
    updateNodeRun: async (id, patch) => {
      const updated = await deps.updateNodeRun(id, patch);
      await publishUpdate({ nodeRunId: id, status: updated?.status || patch?.status, error: updated?.error || patch?.error });
      return updated;
    },
  };

  const workflow = await deps.getWorkflowById(run.workflowId);
  if (!workflow) {
    await eventedRepo.updateRun(run.id, { status: 'failed', error: 'Workflow not found.' });
    return { status: 'failed', error: 'Workflow not found.' };
  }

  const provider = run.provider || workflow.provider;
  const nodes = workflow.nodes || [];
  const selectedNodes = run.targetNodeId
    ? nodes.filter((node) => node.id === run.targetNodeId)
    : nodes;
  const needsCredential = selectedNodes.some(nodeNeedsProviderCredential);
  let apiKey;
  try {
    apiKey = needsCredential
      ? await deps.resolveProviderKey({ userId: run.userId, provider })
      : null;
    if (needsCredential && !apiKey) throw new Error('No provider API key available for this user.');
  } catch (error) {
    await eventedRepo.updateRun(run.id, { status: 'failed', error: error.message });
    return { status: 'failed', error: error.message };
  }

  const nodeRuns = await deps.listNodeRuns(run.id);

  // storeOutputs mirrors media into our bucket and reports the stored keys so the
  // engine persists them onto the node-run row for later cleanup.
  const storeOutputs = ({ result, nodeRunId }) =>
    storeNodeOutputs({
      result,
      userId: run.userId,
      workflowId: workflow.id,
      runId: run.id,
      nodeRunId,
      config,
      deps,
    });

  const signStoredOutputs = (outputs) => {
    if (!deps.createPresignedGetUrl) return outputs;
    return signResultOutputs(
      { outputs },
      { config, createPresignedGetUrl: deps.createPresignedGetUrl }
    ).outputs;
  };

  // ---- Single-node run ----
  if (run.targetNodeId) {
    const node = nodes.find((n) => n.id === run.targetNodeId);
    const nodeRun = nodeRuns.find((nr) => nr.nodeId === run.targetNodeId);
    if (!node || !nodeRun) {
      await eventedRepo.updateRun(run.id, { status: 'failed', error: 'Target node not found.' });
      return { status: 'failed', error: 'Target node not found.' };
    }
    // Upstream values come from whatever this workflow generated before, plus the
    // params the client stored on the seeded node-run.
    const previousResults = await deps.latestResultsForWorkflow(workflow.id);
    const selectedResults = run.inputs?.upstreamResults && typeof run.inputs.upstreamResults === 'object'
      ? run.inputs.upstreamResults
      : {};
    const validSelectedResults = Object.fromEntries(
      Object.entries(selectedResults).filter(([, outputs]) => Array.isArray(outputs))
    );
    const effectiveResults = { ...previousResults, ...validSelectedResults };
    const resultsByNodeId = Object.fromEntries(
      Object.entries(effectiveResults).map(([nodeId, outputs]) => [nodeId, signStoredOutputs(outputs)])
    );
    return deps.executeSingleNode({
      node: { ...node, model: nodeRun.model || node.model, params: nodeRun.params || node.params || {} },
      nodeRunId: nodeRun.id,
      runId: run.id,
      provider,
      apiKey,
      resultsByNodeId,
      repo: eventedRepo,
      executeNode: deps.executeNode,
      estimateNodeRuntime: deps.estimateNodeRuntime,
      storeOutputs,
    });
  }

  // ---- Full-graph run ----
  const nodeRunIds = {};
  for (const nr of nodeRuns) nodeRunIds[nr.nodeId] = nr.id;

  return deps.executeGraph({
    nodes,
    edges: workflow.edges || [],
    runId: run.id,
    provider,
    apiKey,
    nodeRunIds,
    inputOverrides: run.inputs || {},
    initialResults: latestResultsFromRuns(nodeRuns),
    repo: eventedRepo,
    executeNode: deps.executeNode,
    estimateNodeRuntime: deps.estimateNodeRuntime,
    storeOutputs,
  });
}

// Worker/inline entry: atomically claim the run (so the inline enqueue and the
// worker loop never both process it), then run it.
export async function processRun(runId, injectedDeps) {
  const deps = injectedDeps || (await createDefaultRunDeps());
  const run = typeof deps.claimRun === 'function'
    ? await deps.claimRun(runId)
    : await deps.getRun(runId);
  if (!run) return null; // already claimed / not pending
  return runClaimedRun(run, deps);
}
