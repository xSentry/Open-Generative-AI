import { createWorkflowGraph, cloneJson, makeConstantBinding, makeConnectionBinding, makeConnectionsBinding } from './graphSchema.js';
import {
  categoryFromNodeType,
  inferNodeKind,
  nodeTypeForCategory,
  sourceHandleForPort,
  sourcePortFromHandle,
  targetHandleForPort,
  targetPortFromHandle,
  getInputPortDefinitions,
  getOutputPortDefinitions,
} from './portRegistry.js';

const TEMPLATE_RE = /^\s*\{\{\s*([^.{}]+?)\.outputs\[(\d+)]\.value\s*}}\s*$/;

function templateFor(sourceNodeId) {
  return `{{ ${sourceNodeId}.outputs[0].value }}`;
}

function isEmptyValue(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

export function templateToConnection(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(TEMPLATE_RE);
  if (!match) return null;
  return { sourceNodeId: match[1].trim(), sourceOutputIndex: Number(match[2]) };
}

function stripTemplateValues(value) {
  if (templateToConnection(value)) return undefined;
  if (Array.isArray(value)) {
    const kept = value.map(stripTemplateValues).filter((item) => item !== undefined);
    return kept.length > 0 ? kept : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const stripped = stripTemplateValues(child);
      if (stripped !== undefined) out[key] = stripped;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}

function inferCategory(node) {
  return node?.category || categoryFromNodeType(node?.type || node?.nodeType);
}

function inferModel(category, node) {
  if (node?.model) return node.model;
  if (category === 'utility') {
    if (node?.type === 'vidConcatNode') return 'video-combiner';
    return 'prompt-concatenator';
  }
  return `${category}-passthrough`;
}

function buildNodeFromSaved(savedNode, provider, catalog) {
  const category = inferCategory(savedNode);
  const modelId = inferModel(category, savedNode);
  const nodeType = savedNode.type || nodeTypeForCategory(category, modelId);
  const rawParams = savedNode.params || {};
  const inputParams = savedNode.input_params || {};
  const parameters = {};
  const inputs = {};
  const inputDefs = getInputPortDefinitions({ category, modelId, nodeType, catalog });

  for (const [key, value] of Object.entries(inputParams)) {
    if (key === 'make_input' || key === 'make_output') continue;
    const stripped = stripTemplateValues(value);
    if (stripped !== undefined) {
      parameters[key] = stripped;
      if (inputDefs[key]) inputs[key] = makeConstantBinding(stripped);
    }
  }
  for (const [key, value] of Object.entries(rawParams)) {
    if (key === 'make_input' || key === 'make_output') continue;
    const stripped = stripTemplateValues(value);
    if (stripped !== undefined) {
      parameters[key] = stripped;
      if (inputDefs[key]) inputs[key] = makeConstantBinding(stripped);
    }
  }

  const outputDefs = getOutputPortDefinitions({ category, modelId });

  return {
    id: String(savedNode.id),
    nodeType,
    category,
    kind: inferNodeKind(category, modelId),
    title: savedNode.title || savedNode.label || savedNode.name || String(savedNode.id),
    provider,
    ...(modelId ? { modelId } : {}),
    ...((savedNode.provider_mode || savedNode.providerMode)
      ? { providerMode: savedNode.provider_mode || savedNode.providerMode }
      : {}),
    parameters,
    inputs,
    outputs: outputDefs,
    exposure: {
      makeInput: inputParams.make_input === true,
      makeOutput: inputParams.make_output === true,
      ...(inputParams.play_label ? { playLabel: inputParams.play_label } : {}),
    },
    ...(savedNode.position ? { layout: { x: savedNode.position.x, y: savedNode.position.y } } : {}),
  };
}

function applyConnectionBindings(graph, savedEdges = [], catalog = null) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of savedEdges || []) {
    const sourceNode = nodesById.get(String(edge.source));
    const targetNode = nodesById.get(String(edge.target));
    if (!sourceNode || !targetNode) continue;
    const source = sourcePortFromHandle(edge.sourceHandle, sourceNode);
    const target = targetPortFromHandle(edge.targetHandle);
    const inputDefs = getInputPortDefinitions({
      category: targetNode.category,
      modelId: targetNode.modelId,
      nodeType: targetNode.nodeType,
      catalog,
    });
    if (inputDefs[target.port]?.maxConnections === Infinity) {
      const existing = targetNode.inputs[target.port];
      const connections = existing?.type === 'connections'
        ? [...existing.connections]
        : existing?.type === 'connection'
          ? [{ sourceNodeId: existing.sourceNodeId, sourcePort: existing.sourcePort }]
          : [];
      if (!connections.some((connection) => connection.sourceNodeId === sourceNode.id && connection.sourcePort === source.port)) {
        connections.push({ sourceNodeId: sourceNode.id, sourcePort: source.port });
      }
      targetNode.inputs[target.port] = makeConnectionsBinding(connections);
    } else {
      targetNode.inputs[target.port] = makeConnectionBinding(sourceNode.id, source.port);
    }
  }
}

export function savedPayloadToWorkflowGraph(payload = {}, { provider = 'replicate', catalog = null } = {}) {
  const nodes = payload.data?.nodes || payload.nodes || [];
  const edges = payload.edges || [];
  const graphNodes = nodes.map((node) => buildNodeFromSaved(node, provider, catalog));
  const graphEdges = edges.map((edge, index) => {
    const sourceNode = graphNodes.find((node) => node.id === String(edge.source));
    const source = sourcePortFromHandle(edge.sourceHandle, sourceNode);
    const target = targetPortFromHandle(edge.targetHandle);
    return {
      id: edge.id || `${edge.source}->${edge.target}:${target.port}:${index}`,
      source: { nodeId: String(edge.source), port: source.port },
      target: { nodeId: String(edge.target), port: target.port },
      legacy: {
        sourceHandle: edge.sourceHandle || sourceHandleForPort(source.port, sourceNode),
        targetHandle: edge.targetHandle || targetHandleForPort(target.port),
      },
    };
  });

  const graph = createWorkflowGraph({
    workflowId: payload.workflow_id || payload.id,
    revision: payload.revision,
    name: payload.name || 'Untitled',
    category: payload.category || undefined,
    source: payload.source || 'manual',
    nodes: graphNodes,
    edges: graphEdges,
  });
  applyConnectionBindings(graph, edges, catalog);
  return graph;
}

function paramsWithConnections(node, graphEdges) {
  const params = cloneJson(node.parameters || {});
  for (const edge of graphEdges) {
    if (edge.target.nodeId !== node.id) continue;
    const port = edge.target.port;
    const inputDef = getInputPortDefinitions({
      category: node.category,
      modelId: node.modelId,
      nodeType: node.nodeType,
    })[port];
    const value = templateFor(edge.source.nodeId);
    if (inputDef?.maxConnections === Infinity || Array.isArray(params[port])) {
      const list = Array.isArray(params[port]) ? [...params[port]] : [];
      if (!list.includes(value)) list.push(value);
      params[port] = list;
    } else {
      params[port] = value;
    }
  }
  for (const [key, value] of Object.entries(params)) {
    if (isEmptyValue(value)) delete params[key];
  }
  return params;
}

export function workflowGraphToSavedPayload(graph) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.map((edge) => {
    const sourceNode = nodesById.get(edge.source.nodeId);
    const targetNode = nodesById.get(edge.target.nodeId);
    return {
      id: edge.id,
      source: edge.source.nodeId,
      target: edge.target.nodeId,
      sourceHandle: edge.legacy?.sourceHandle || sourceHandleForPort(edge.source.port, sourceNode),
      targetHandle: edge.legacy?.targetHandle || targetHandleForPort(edge.target.port, targetNode),
    };
  });

  const nodes = graph.nodes.map((node) => {
    const input_params = {
      ...cloneJson(node.parameters || {}),
      ...(node.exposure?.makeInput ? { make_input: true } : {}),
      ...(node.exposure?.makeOutput ? { make_output: true } : {}),
      ...(node.exposure?.playLabel ? { play_label: node.exposure.playLabel } : {}),
    };
    return {
      id: node.id,
      title: node.title,
      category: node.category,
      model: node.modelId || null,
      ...(node.providerMode ? { provider_mode: node.providerMode } : {}),
      input_params,
      output_params: { resultUrl: null, outputs: [] },
      params: paramsWithConnections(node, graph.edges),
      ...(node.layout ? { position: { x: node.layout.x, y: node.layout.y } } : {}),
      ...(graph.edges.some((edge) => edge.target.nodeId === node.id)
        ? { inputs: graph.edges.filter((edge) => edge.target.nodeId === node.id).map((edge) => edge.source.nodeId) }
        : {}),
    };
  });

  return {
    workflow_id: graph.workflowId || null,
    name: graph.metadata?.name || 'Untitled',
    category: graph.metadata?.category || null,
    edges,
    data: { nodes },
  };
}

export function workflowGraphToExecutionPlan(graph) {
  const payload = workflowGraphToSavedPayload(graph);
  return {
    nodes: payload.data.nodes,
    edges: payload.edges,
  };
}

export function reactFlowStateToWorkflowGraph({ nodes = [], edges = [] } = {}, {
  workflowId = undefined,
  revision = undefined,
  name = 'Untitled',
  category = undefined,
  provider = 'replicate',
  catalog = null,
} = {}) {
  const savedNodes = nodes.map((node) => {
    const inferredCategory = inferCategory(node);
    const model = node.data?.selectedModel?.id || node.data?.modelId || inferModel(inferredCategory, node);
    return {
      id: node.id,
      title: node.data?.title || node.title || node.id,
      category: inferredCategory,
      model,
      ...((node.data?.selectedModel?.mode || node.data?.providerMode)
        ? { provider_mode: node.data?.selectedModel?.mode || node.data?.providerMode }
        : {}),
      input_params: cloneJson(node.data?.formValues || {}),
      output_params: {
        resultUrl: node.data?.resultUrl || null,
        outputs: cloneJson(node.data?.outputs || []),
      },
      params: cloneJson(node.data?.formValues || {}),
      position: cloneJson(node.position || { x: 0, y: 0 }),
      type: node.type || nodeTypeForCategory(inferredCategory, model),
    };
  });
  const savedEdges = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle || null,
    targetHandle: edge.targetHandle || null,
  }));
  return savedPayloadToWorkflowGraph(
    {
      workflow_id: workflowId,
      revision,
      name,
      category,
      edges: savedEdges,
      data: { nodes: savedNodes },
    },
    { provider, catalog }
  );
}

export function workflowGraphToReactFlowState(graph) {
  const saved = workflowGraphToSavedPayload(graph);
  return {
    nodes: saved.data.nodes.map((node) => ({
      id: node.id,
      type: nodeTypeForCategory(node.category, node.model),
      position: cloneJson(node.position || { x: 0, y: 0 }),
      data: {
        title: node.title,
        modelId: node.model,
        providerMode: node.provider_mode || null,
        selectedModel: node.model
          ? { id: node.model, ...(node.provider_mode ? { mode: node.provider_mode } : {}) }
          : null,
        outputs: cloneJson(node.output_params?.outputs || []),
        resultUrl: node.output_params?.resultUrl || null,
        formValues: cloneJson(node.input_params || {}),
      },
    })),
    edges: saved.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle || null,
      targetHandle: edge.targetHandle || null,
    })),
  };
}
