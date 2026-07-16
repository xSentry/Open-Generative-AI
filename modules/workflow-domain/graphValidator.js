import { WORKFLOW_GRAPH_VERSION, NODE_CATEGORIES, NODE_KINDS, PROVIDERS } from './graphSchema.js';
import {
  getInputPortDefinitions,
  getOutputPortDefinitions,
  portTypesCompatible,
} from './portRegistry.js';
import { workflowGraphToSavedPayload } from './workflowAdapters.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET_KEY_RE = /(api[_-]?key|authorization|bearer|token|secret|password|credential)/i;
const SECRET_VALUE_RE = /(sk-[A-Za-z0-9_-]{20,}|r8_[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})/;
const NODE_TYPES = new Set(['textNode', 'imageNode', 'videoNode', 'audioNode', 'apiNode', 'concatNode', 'vidConcatNode', 'utilityNode']);

function issue(severity, code, message, path = '') {
  return { severity, code, message, path };
}

function scanValue(value, path, issues) {
  if (value == null) return;
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) {
      issues.push(issue('error', 'SECRET_VALUE', 'Secret-like value is not allowed in workflow graph.', path));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(item, `${path}[${index}]`, issues));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEYS.has(key)) {
        issues.push(issue('error', 'FORBIDDEN_KEY', `Forbidden object key "${key}".`, childPath));
      }
      if (SECRET_KEY_RE.test(key)) {
        issues.push(issue('error', 'SECRET_KEY', `Secret-bearing field "${key}" is not allowed.`, childPath));
      }
      scanValue(child, childPath, issues);
    }
  }
}

function validateAcyclic(nodes, edges, issues) {
  const ids = new Set(nodes.map((node) => node.id));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!ids.has(edge.source.nodeId) || !ids.has(edge.target.nodeId)) continue;
    adjacency.get(edge.source.nodeId).push(edge.target.nodeId);
    indegree.set(edge.target.nodeId, indegree.get(edge.target.nodeId) + 1);
  }
  const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const target of adjacency.get(id) || []) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  if (visited !== nodes.length) {
    issues.push(issue('error', 'GRAPH_CYCLE', 'Workflow graph contains a cycle and cannot be executed.', 'edges'));
  }
}

function maxGraphDepth(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (adjacency.has(edge.source.nodeId)) adjacency.get(edge.source.nodeId).push(edge.target.nodeId);
  }
  const memo = new Map();
  const depth = (id, visiting = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return Infinity;
    visiting.add(id);
    const next = adjacency.get(id) || [];
    const value = next.length === 0 ? 1 : 1 + Math.max(...next.map((child) => depth(child, visiting)));
    visiting.delete(id);
    memo.set(id, value);
    return value;
  };
  return nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => depth(node.id)));
}

function catalogHasModel(catalog, category, modelId) {
  if (!catalog || !modelId) return true;
  return !!catalog.categories?.[category]?.models?.[modelId];
}

function catalogModel(catalog, category, modelId) {
  if (!catalog || !modelId) return null;
  return catalog.categories?.[category]?.models?.[modelId] || null;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function bindingConnections(binding) {
  if (binding?.type === 'connection') {
    return [{ sourceNodeId: binding.sourceNodeId, sourcePort: binding.sourcePort }];
  }
  if (binding?.type === 'connections' && Array.isArray(binding.connections)) {
    return binding.connections;
  }
  return [];
}

export function validateWorkflowGraph(graph, {
  catalog = null,
  allowedProviders = PROVIDERS,
  maxNodes = 50,
  maxEdges = 100,
  maxDepth = 25,
} = {}) {
  const issues = [];

  if (!graph || typeof graph !== 'object') {
    return { valid: false, errors: [issue('error', 'GRAPH_REQUIRED', 'Workflow graph is required.')], warnings: [], issues: [] };
  }
  if (graph.version !== WORKFLOW_GRAPH_VERSION) {
    issues.push(issue('error', 'UNSUPPORTED_GRAPH_VERSION', `Unsupported workflow graph version "${graph.version}".`, 'version'));
  }
  if (!Array.isArray(graph.nodes)) issues.push(issue('error', 'NODES_REQUIRED', 'Graph nodes must be an array.', 'nodes'));
  if (!Array.isArray(graph.edges)) issues.push(issue('error', 'EDGES_REQUIRED', 'Graph edges must be an array.', 'edges'));
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return splitIssues(issues);
  }
  if (graph.nodes.length > maxNodes) issues.push(issue('error', 'GRAPH_NODE_LIMIT', `Graph exceeds the ${maxNodes} node limit.`, 'nodes'));
  if (graph.edges.length > maxEdges) issues.push(issue('error', 'GRAPH_EDGE_LIMIT', `Graph exceeds the ${maxEdges} edge limit.`, 'edges'));
  scanValue(graph.metadata || {}, 'metadata', issues);

  const nodeIds = new Set();
  const allNodeIds = new Set(graph.nodes.map((node) => node?.id).filter(Boolean));
  const edgeIds = new Set();
  const nodesById = new Map();
  for (const [index, node] of graph.nodes.entries()) {
    const path = `nodes[${index}]`;
    if (!node?.id || typeof node.id !== 'string') issues.push(issue('error', 'NODE_ID_REQUIRED', 'Node id is required.', `${path}.id`));
    if (nodeIds.has(node.id)) issues.push(issue('error', 'DUPLICATE_NODE_ID', `Duplicate node id "${node.id}".`, `${path}.id`));
    nodeIds.add(node.id);
    nodesById.set(node.id, node);

    if (!NODE_TYPES.has(node.nodeType)) issues.push(issue('error', 'INVALID_NODE_TYPE', `Invalid node type "${node.nodeType}".`, `${path}.nodeType`));
    if (!NODE_CATEGORIES.has(node.category)) issues.push(issue('error', 'INVALID_NODE_CATEGORY', `Invalid node category "${node.category}".`, `${path}.category`));
    if (!NODE_KINDS.has(node.kind)) issues.push(issue('error', 'INVALID_NODE_KIND', `Invalid node kind "${node.kind}".`, `${path}.kind`));
    if (!allowedProviders.has(node.provider)) issues.push(issue('error', 'INVALID_PROVIDER', `Invalid provider "${node.provider}".`, `${path}.provider`));
    if (node.modelId && !catalogHasModel(catalog, node.category, node.modelId)) {
      issues.push(issue('error', 'UNKNOWN_MODEL', `Unknown model "${node.modelId}" for category "${node.category}".`, `${path}.modelId`));
    }
    const model = catalogModel(catalog, node.category, node.modelId);
    if (model?.deprecated === true) {
      issues.push(issue('error', 'DEPRECATED_MODEL', `Model "${node.modelId}" is deprecated.`, `${path}.modelId`));
    }
    if (model?.architectEnabled === false) {
      issues.push(issue('error', 'ARCHITECT_DISABLED_MODEL', `Model "${node.modelId}" is disabled for Architect workflows.`, `${path}.modelId`));
    }

    const inputDefs = getInputPortDefinitions({ category: node.category, modelId: node.modelId, nodeType: node.nodeType, catalog });
    for (const [port, binding] of Object.entries(node.inputs || {})) {
      const inputDef = inputDefs[port];
      if (Object.keys(inputDefs).length > 0 && !inputDef) {
        issues.push(issue('error', 'UNKNOWN_INPUT_PORT', `Unknown input port "${port}" on node "${node.id}".`, `${path}.inputs.${port}`));
      }
      if (!binding || !['constant', 'connection', 'connections'].includes(binding.type)) {
        issues.push(issue('error', 'INVALID_INPUT_BINDING', `Invalid binding for input port "${port}".`, `${path}.inputs.${port}`));
      }
      if (binding?.type === 'connections' && !Array.isArray(binding.connections)) {
        issues.push(issue('error', 'INVALID_INPUT_BINDING', `Connections binding for input port "${port}" must contain a connections array.`, `${path}.inputs.${port}`));
      }
      if (binding?.type === 'connections' && (inputDef?.maxConnections ?? 1) !== Infinity) {
        issues.push(issue('error', 'PORT_CARDINALITY', `Input port "${port}" does not accept multiple connection bindings.`, `${path}.inputs.${port}`));
      }
      const seenBindingConnections = new Set();
      for (const connection of bindingConnections(binding)) {
        const connectionKey = `${connection.sourceNodeId}:${connection.sourcePort}`;
        if (seenBindingConnections.has(connectionKey)) {
          issues.push(issue('error', 'DUPLICATE_BINDING_CONNECTION', `Duplicate connection binding for input port "${port}".`, `${path}.inputs.${port}`));
        }
        seenBindingConnections.add(connectionKey);
        if (!allNodeIds.has(connection.sourceNodeId)) {
          issues.push(issue('error', 'UNKNOWN_BINDING_SOURCE_NODE', `Unknown connection source node "${connection.sourceNodeId}".`, `${path}.inputs.${port}`));
        }
        if (
          !graph.edges.some((edge) =>
            edge.source.nodeId === connection.sourceNodeId &&
            edge.source.port === connection.sourcePort &&
            edge.target.nodeId === node.id &&
            edge.target.port === port
          )
        ) {
          issues.push(issue('error', 'MISSING_BINDING_EDGE', `Connection binding for "${port}" has no matching edge.`, `${path}.inputs.${port}`));
        }
      }
      if (binding?.type === 'constant' && inputDef?.required && isEmpty(binding.value)) {
        issues.push(issue('error', 'REQUIRED_INPUT_UNRESOLVED', `Required input port "${port}" is empty.`, `${path}.inputs.${port}`));
      }
    }
    for (const [port, inputDef] of Object.entries(inputDefs)) {
      if (!inputDef.required) continue;
      const binding = node.inputs?.[port];
      const parameter = node.parameters?.[port];
      if (!binding && isEmpty(parameter)) {
        issues.push(issue('error', 'REQUIRED_INPUT_UNRESOLVED', `Required input port "${port}" is unresolved.`, `${path}.inputs.${port}`));
      }
    }
    scanValue({ title: node.title, exposure: node.exposure || {} }, path, issues);
    scanValue(node.parameters || {}, `${path}.parameters`, issues);
  }

  const targetCounts = new Map();
  const seenEdges = new Set();
  for (const [index, edge] of graph.edges.entries()) {
    const path = `edges[${index}]`;
    if (!edge?.id || typeof edge.id !== 'string') issues.push(issue('error', 'EDGE_ID_REQUIRED', 'Edge id is required.', `${path}.id`));
    if (edgeIds.has(edge.id)) issues.push(issue('error', 'DUPLICATE_EDGE_ID', `Duplicate edge id "${edge.id}".`, `${path}.id`));
    edgeIds.add(edge.id);

    const sourceNode = nodesById.get(edge?.source?.nodeId);
    const targetNode = nodesById.get(edge?.target?.nodeId);
    if (!sourceNode) issues.push(issue('error', 'UNKNOWN_SOURCE_NODE', `Unknown source node "${edge?.source?.nodeId}".`, `${path}.source.nodeId`));
    if (!targetNode) issues.push(issue('error', 'UNKNOWN_TARGET_NODE', `Unknown target node "${edge?.target?.nodeId}".`, `${path}.target.nodeId`));
    if (!sourceNode || !targetNode) continue;

    const outDefs = getOutputPortDefinitions({ category: sourceNode.category, modelId: sourceNode.modelId });
    const inDefs = getInputPortDefinitions({ category: targetNode.category, modelId: targetNode.modelId, nodeType: targetNode.nodeType, catalog });
    const outDef = outDefs[edge.source.port];
    const inDef = inDefs[edge.target.port];
    if (!outDef) issues.push(issue('error', 'UNKNOWN_OUTPUT_PORT', `Unknown output port "${edge.source.port}" on node "${sourceNode.id}".`, `${path}.source.port`));
    if (Object.keys(inDefs).length > 0 && !inDef) {
      issues.push(issue('error', 'UNKNOWN_INPUT_PORT', `Unknown input port "${edge.target.port}" on node "${targetNode.id}".`, `${path}.target.port`));
    }
    if (outDef && inDef && !portTypesCompatible(outDef.type, inDef.type)) {
      issues.push(issue('error', 'INCOMPATIBLE_PORT_TYPES', `Cannot connect ${outDef.type} output to ${inDef.type} input.`, path));
    }

    const edgeKey = `${edge.source.nodeId}:${edge.source.port}->${edge.target.nodeId}:${edge.target.port}`;
    if (seenEdges.has(edgeKey)) issues.push(issue('error', 'DUPLICATE_EDGE', 'Duplicate edge between the same source and target port.', path));
    seenEdges.add(edgeKey);

    const targetKey = `${edge.target.nodeId}:${edge.target.port}`;
    targetCounts.set(targetKey, (targetCounts.get(targetKey) || 0) + 1);
    const maxConnections = inDef?.maxConnections ?? 1;
    if (targetCounts.get(targetKey) > maxConnections) {
      issues.push(issue('error', 'PORT_CARDINALITY', `Input port "${edge.target.port}" accepts only ${maxConnections} connection.`, path));
    }
    const binding = targetNode.inputs?.[edge.target.port];
    if (binding?.type === 'constant' && maxConnections === 1) {
      issues.push(issue('error', 'CONSTANT_CONNECTION_CONFLICT', `Input port "${edge.target.port}" has both a constant and a connection.`, path));
    }
    const hasMatchingBinding = bindingConnections(binding).some((connection) =>
      connection.sourceNodeId === edge.source.nodeId &&
      connection.sourcePort === edge.source.port
    );
    if (!hasMatchingBinding && binding?.type !== 'constant') {
      issues.push(issue('error', 'MISSING_EDGE_BINDING', `Edge "${edge.id}" has no matching input binding.`, path));
    }
  }

  validateAcyclic(graph.nodes, graph.edges, issues);
  const depth = maxGraphDepth(graph.nodes, graph.edges);
  if (depth > maxDepth) issues.push(issue('error', 'GRAPH_DEPTH_LIMIT', `Graph depth ${depth} exceeds the ${maxDepth} limit.`, 'edges'));

  try {
    JSON.stringify(workflowGraphToSavedPayload(graph));
  } catch (error) {
    issues.push(issue('error', 'SERIALIZATION_FAILED', `Graph cannot serialize through the legacy save path: ${error.message}`, ''));
  }

  return splitIssues(issues);
}

function splitIssues(issues) {
  const errors = issues.filter((item) => item.severity === 'error');
  const warnings = issues.filter((item) => item.severity === 'warning');
  return { valid: errors.length === 0, errors, warnings, issues };
}
