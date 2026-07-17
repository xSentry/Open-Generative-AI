// Phase 3/4 — the workflow execution engine.
//
// Responsibilities:
//   1. Load the graph (nodes + edges) and topologically sort it (cycles are
//      rejected).
//   2. Resolve each node's params by substituting the `{{ nodeId.outputs[k].value }}`
//      template references the builder injects for connected inputs
//      (see packages/.../NodeFlow.jsx buildWorkflowPayload).
//   3. Execute nodes in order via nodeExecutors, persisting per-node status and
//      results so the UI's `run/{id}/status` polling reflects progress.
//
// Execution is intentionally driven by injected `repo`/`executeNode` deps so it
// runs under `node --test` without a DB or network.
import { executeNode as defaultExecuteNode } from './nodeExecutors.js';

const TEMPLATE_RE = /\{\{\s*([^.{}]+?)\.outputs\[(\d+)]\.value\s*}}/g;

// Build adjacency + indegree from edges (source -> target) and node.inputs.
function buildGraph(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const indegree = new Map();
  const adjacency = new Map();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, new Set());
  }

  const addEdge = (source, target) => {
    if (!ids.has(source) || !ids.has(target) || source === target) return;
    const targets = adjacency.get(source);
    if (targets.has(target)) return;
    targets.add(target);
    indegree.set(target, indegree.get(target) + 1);
  };

  for (const edge of edges || []) {
    addEdge(edge?.source, edge?.target);
  }
  // node.inputs lists upstream source ids; treat them as edges too.
  for (const node of nodes) {
    for (const source of node.inputs || []) {
      addEdge(source, node.id);
    }
  }

  return { indegree, adjacency };
}

// Kahn's algorithm. Throws on a cycle (a graph that can't be fully drained).
export function topoSort(nodes = [], edges = []) {
  const { indegree, adjacency } = buildGraph(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const queue = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  // Stable order: preserve the incoming node order for ready nodes.
  queue.sort((a, b) => nodes.findIndex((n) => n.id === a) - nodes.findIndex((n) => n.id === b));

  const ordered = [];
  while (queue.length) {
    const id = queue.shift();
    ordered.push(byId.get(id));
    for (const target of adjacency.get(id) || []) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }

  if (ordered.length !== nodes.length) {
    throw new Error('Workflow graph contains a cycle and cannot be executed.');
  }
  return ordered;
}

// Look up outputs[index].value for a referenced node from the results map.
function lookup(resultsByNodeId, nodeId, index) {
  const outputs = resultsByNodeId[nodeId];
  if (!Array.isArray(outputs)) return undefined;
  return outputs[index]?.value;
}

// Substitute template refs in a single value (string, array or object).
export function resolveValue(value, resultsByNodeId) {
  if (typeof value === 'string') {
    // Whole-string template → return the raw (possibly non-string) value so
    // arrays/objects flow through untouched.
    const whole = value.match(/^\s*\{\{\s*([^.{}]+?)\.outputs\[(\d+)]\.value\s*}}\s*$/);
    if (whole) {
      const resolved = lookup(resultsByNodeId, whole[1].trim(), Number(whole[2]));
      return resolved === undefined ? value : resolved;
    }
    // Embedded template(s) → string interpolation.
    return value.replace(TEMPLATE_RE, (match, id, idx) => {
      const resolved = lookup(resultsByNodeId, id.trim(), Number(idx));
      return resolved === undefined ? match : String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => resolveValue(item, resultsByNodeId))
      .filter((item) => item !== undefined && item !== null && item !== '');
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, resultsByNodeId);
    return out;
  }
  return value;
}

// Resolve every param of a node against upstream results.
export function resolveParams(params = {}, resultsByNodeId = {}) {
  return resolveValue(params, resultsByNodeId);
}

// Apply api-execute input overrides (keyed by node id) onto the node's params.
function applyInputOverride(node, override) {
  if (!override) return node.params || {};
  const params = { ...(node.params || {}) };
  for (const [key, value] of Object.entries(override)) {
    params[key] = value;
  }
  return params;
}

// Shape of a failure result the UI can render (reads outputs[0].value.error).
function failureResult(message) {
  return { id: `err-${Date.now()}`, outputs: [{ type: 'text', value: { error: String(message) }, id: `err-${Date.now()}` }] };
}

// Execute a whole graph. `nodeRunIds` maps nodeId -> pre-created node_run row id
// so we update in place (giving the UI exactly one row per node this run).
//
// `storeOutputs` (optional) mirrors media outputs into our S3 bucket before the
// result is persisted; it returns { result, keys }. Defaults to a no-op so the
// pure engine keeps working under `node --test` without S3.
export async function executeGraph({
  nodes,
  edges,
  runId,
  provider,
  apiKey,
  nodeRunIds = {},
  inputOverrides = {},
  initialResults = {},
  nodeConcurrency = Infinity,
  repo,
  executeNode = defaultExecuteNode,
  estimateNodeRuntime = async () => null,
  storeOutputs = async ({ result }) => ({ result, keys: [] }),
}) {
  let ordered;
  let graph;
  try {
    ordered = topoSort(nodes, edges);
    graph = buildGraph(nodes, edges);
  } catch (error) {
    await repo.updateRun(runId, { status: 'failed', error: error.message });
    return { status: 'failed', error: error.message };
  }

  const resultsByNodeId = { ...initialResults };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const ready = ordered
    .filter((node) => graph.indegree.get(node.id) === 0)
    .map((node) => node.id);
  const started = new Set();
  const completed = new Set();
  const maxConcurrency =
    Number.isFinite(Number(nodeConcurrency)) && Number(nodeConcurrency) > 0
      ? Number(nodeConcurrency)
      : Infinity;

  await repo.updateRun(runId, { status: 'running' });

  let active = 0;
  let failure = null;

  async function runNode(node) {
    const nodeRunId = nodeRunIds[node.id];
    const baseParams = applyInputOverride(node, inputOverrides[node.id]);
    const params = resolveParams(baseParams, resultsByNodeId);
    let runtimeEstimate = null;

    try {
      if (nodeRunId) {
        runtimeEstimate = await estimateNodeRuntime({ provider, model: node.model, params });
        await repo.updateNodeRun(nodeRunId, {
          status: 'running',
          ...(runtimeEstimate ? { result: { runtimeEstimate } } : {}),
        });
      }
      const raw = await executeNode({
        provider,
        apiKey,
        node: { ...node, params },
        onProviderStarted: nodeRunId
          ? async ({ predictionId, createdAt }) => repo.updateNodeRun(nodeRunId, {
              status: 'running',
              providerRef: predictionId || undefined,
              result: {
                ...(runtimeEstimate ? { runtimeEstimate } : {}),
                createdAt: createdAt || new Date().toISOString(),
              },
            })
          : undefined,
      });
      const { result, keys } = await storeOutputs({ result: raw, nodeId: node.id, nodeRunId });
      resultsByNodeId[node.id] = result.outputs || [];
      if (nodeRunId) {
        await repo.updateNodeRun(nodeRunId, { status: 'succeeded', result, outputKeys: keys });
      }
      completed.add(node.id);
    } catch (error) {
      const result = failureResult(error.message || 'Node execution failed');
      if (nodeRunId) {
        await repo.updateNodeRun(nodeRunId, { status: 'failed', result, error: error.message });
      }
      if (!failure) {
        failure = { status: 'failed', error: error.message, results: resultsByNodeId };
      }
    }
  }

  async function markUnstartedNodesFailed(message) {
    await Promise.all(nodes.map(async (node) => {
      if (started.has(node.id) || completed.has(node.id)) return;
      const nodeRunId = nodeRunIds[node.id];
      if (!nodeRunId) return;
      const result = failureResult(message);
      await repo.updateNodeRun(nodeRunId, { status: 'failed', result, error: message });
    }));
  }

  const result = await new Promise((resolve) => {
    let finalizing = false;

    const sortedReadyPush = (id) => {
      ready.push(id);
      ready.sort((a, b) => (nodeIndex.get(a) ?? 0) - (nodeIndex.get(b) ?? 0));
    };

    const finalize = async () => {
      if (finalizing) return;
      finalizing = true;
      if (failure) {
        const message = failure.error || 'Workflow failed before this node could run.';
        await markUnstartedNodesFailed(`Skipped because workflow failed: ${message}`);
        await repo.updateRun(runId, { status: 'failed', error: failure.error });
        resolve(failure);
        return;
      }
      await repo.updateRun(runId, { status: 'completed' });
      resolve({ status: 'completed', results: resultsByNodeId });
    };

    const schedule = () => {
      if (failure) {
        if (active === 0) finalize();
        return;
      }

      while (active < maxConcurrency && ready.length > 0) {
        const id = ready.shift();
        const node = byId.get(id);
        if (!node || started.has(id)) continue;
        started.add(id);
        active += 1;
        runNode(node).finally(() => {
          active -= 1;
          if (!failure) {
            for (const target of graph.adjacency.get(id) || []) {
              graph.indegree.set(target, graph.indegree.get(target) - 1);
              if (graph.indegree.get(target) === 0) sortedReadyPush(target);
            }
          }
          if ((failure || (ready.length === 0 && active === 0))) {
            finalize();
          } else {
            schedule();
          }
        });
      }

      if (ready.length === 0 && active === 0) {
        finalize();
      }
    };

    schedule();
  });

  return result;
}

// Execute a single node within an existing run. Upstream values come from the
// latest successful node results already recorded on the run.
export async function executeSingleNode({
  node,
  nodeRunId,
  runId,
  provider,
  apiKey,
  resultsByNodeId = {},
  repo,
  executeNode = defaultExecuteNode,
  estimateNodeRuntime = async () => null,
  storeOutputs = async ({ result }) => ({ result, keys: [] }),
}) {
  const params = resolveParams(node.params || {}, resultsByNodeId);
  try {
    const runtimeEstimate = await estimateNodeRuntime({ provider, model: node.model, params });
    if (runtimeEstimate) {
      await repo.updateNodeRun(nodeRunId, {
        status: 'running',
        result: { runtimeEstimate },
      });
    }
    const raw = await executeNode({
      provider,
      apiKey,
      node: { ...node, params },
      onProviderStarted: async ({ predictionId, createdAt }) => repo.updateNodeRun(nodeRunId, {
        status: 'running',
        providerRef: predictionId || undefined,
        result: {
          ...(runtimeEstimate ? { runtimeEstimate } : {}),
          createdAt: createdAt || new Date().toISOString(),
        },
      }),
    });
    const { result, keys } = await storeOutputs({ result: raw, nodeId: node.id, nodeRunId });
    if (runId) await repo.updateRun(runId, { status: 'completed' });
    await repo.updateNodeRun(nodeRunId, { status: 'succeeded', result, outputKeys: keys });
    return { status: 'succeeded', result };
  } catch (error) {
    const result = failureResult(error.message || 'Node execution failed');
    await repo.updateNodeRun(nodeRunId, { status: 'failed', result, error: error.message });
    if (runId) await repo.updateRun(runId, { status: 'failed', error: error.message });
    return { status: 'failed', error: error.message };
  }
}

// Build a nodeId -> outputs map from persisted node-run rows (latest wins).
export function latestResultsFromRuns(nodeRuns = []) {
  const map = {};
  for (const run of nodeRuns) {
    if (run.status === 'succeeded' && run.result?.outputs) {
      map[run.nodeId] = run.result.outputs;
    }
  }
  return map;
}

function workflowNodeLabel(node = {}) {
  const explicit =
    node.title ||
    node.input_params?.title ||
    node.input_params?.label ||
    node.label ||
    node.name;
  if (explicit) return explicit;

  const category = node.category || String(node.type || '').replace(/Node$/, '');
  const base = {
    text: 'Text',
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    api: 'API',
    utility: 'Utility',
  }[category] || 'Node';
  const index = String(node.id || '').replace(/^\D+/g, '');
  return index ? `${base} ${index}` : base;
}

// The playground exposes nodes explicitly marked as workflow outputs. If no
// nodes are marked, fall back to terminal outputs. Terminal nodes are those
// without any outgoing edge; outputs are flattened into a single list of
// { type, value, id } entries (matching WorkflowStudio's result.outputs render).
export function collectTerminalOutputs(nodes = [], edges = [], resultsByNodeId = {}) {
  const hasOutgoing = new Set();
  for (const edge of edges || []) {
    if (edge?.source) hasOutgoing.add(edge.source);
  }
  const markedOutputNodes = nodes.filter((node) => node?.input_params?.make_output === true);
  const outputNodes = markedOutputNodes.length > 0
    ? markedOutputNodes
    : nodes.filter((node) => !hasOutgoing.has(node.id));
  const outputs = [];
  for (const node of outputNodes) {
    const nodeOutputs = resultsByNodeId[node.id];
    if (Array.isArray(nodeOutputs)) {
      outputs.push(...nodeOutputs.map((output) => ({
        ...output,
        node_id: node.id,
        node_name: workflowNodeLabel(node),
      })));
    }
  }
  return outputs;
}




