// Core workflow run processing: atomically claim a pending run, resolve the
// user's provider key, execute the graph (or a single node) via the engine, and
// mirror media outputs into our S3 bucket. Dependencies are injected so the
// logic is unit-testable without real DB/S3/network.
//
// Heavy `@/`-aliased modules are pulled in lazily inside createDefaultRunDeps()
// so importing the pure functions in tests doesn't require Next's alias
// resolution (mirrors modules/studio/server/processGeneration.js).
import { executeGraph, executeSingleNode, latestResultsFromRuns } from './engine.js';
import { executeNode as defaultExecuteNode } from './nodeExecutors.js';
import { storeNodeOutputs, signResultOutputs } from './outputStorage.js';

export async function createDefaultRunDeps() {
  const [
    s3,
    runsRepo,
    workflowsRepo,
    { getUserMuapiApiKey, getUserReplicateApiKey },
  ] = await Promise.all([
    import('@/modules/storage/server/s3'),
    import('./runsRepo.js'),
    import('./workflowsRepo.js'),
    import('@/modules/auth/server/users'),
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
    fetchFn: (...args) => fetch(...args),
    resolveProviderKey: async ({ userId, provider }) =>
      provider === 'muapi'
        ? (await getUserMuapiApiKey(userId)) || process.env.MUAPI_API_KEY || null
        : (await getUserReplicateApiKey(userId)) || process.env.REPLICATE_API_TOKEN || null,
  };
}

// Execute an already-claimed run: load the graph, resolve the key, and run the
// engine with an S3-mirroring storeOutputs hook.
export async function runClaimedRun(run, injectedDeps) {
  const deps = injectedDeps || (await createDefaultRunDeps());
  const config = deps.getS3Config();

  const workflow = await deps.getWorkflowById(run.workflowId);
  if (!workflow) {
    await deps.updateRun(run.id, { status: 'failed', error: 'Workflow not found.' });
    return { status: 'failed', error: 'Workflow not found.' };
  }

  const provider = run.provider || workflow.provider;
  let apiKey;
  try {
    apiKey = await deps.resolveProviderKey({ userId: run.userId, provider });
    if (!apiKey) throw new Error('No provider API key available for this user.');
  } catch (error) {
    await deps.updateRun(run.id, { status: 'failed', error: error.message });
    return { status: 'failed', error: error.message };
  }

  const nodes = workflow.nodes || [];
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
      await deps.updateRun(run.id, { status: 'failed', error: 'Target node not found.' });
      return { status: 'failed', error: 'Target node not found.' };
    }
    // Upstream values come from whatever this workflow generated before, plus the
    // params the client stored on the seeded node-run.
    const previousResults = await deps.latestResultsForWorkflow(workflow.id);
    const resultsByNodeId = Object.fromEntries(
      Object.entries(previousResults).map(([nodeId, outputs]) => [nodeId, signStoredOutputs(outputs)])
    );
    return deps.executeSingleNode({
      node: { ...node, model: nodeRun.model || node.model, params: nodeRun.params || node.params || {} },
      nodeRunId: nodeRun.id,
      runId: run.id,
      provider,
      apiKey,
      resultsByNodeId,
      repo: deps,
      executeNode: deps.executeNode,
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
    repo: deps,
    executeNode: deps.executeNode,
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
