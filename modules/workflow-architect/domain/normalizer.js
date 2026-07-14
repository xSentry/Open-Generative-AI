import {
  defaultArchitectModelProfile,
  getArchitectModelProfile,
} from './capabilityCatalog.js';
import { validateCreateWorkflowIr } from './architectIrSchema.js';

const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 2000;
const TARGET_CATEGORIES = new Set(['image', 'video', 'audio', 'text']);

function clampString(value, fallback, maxLength) {
  const text = typeof value === 'string' ? value.trim() : fallback;
  return text.slice(0, maxLength).trim() || fallback;
}

function pruneParameters(parameters = {}, allowedKeys = new Set()) {
  const out = {};
  for (const [key, value] of Object.entries(parameters || {})) {
    if (!allowedKeys.has(key)) continue;
    if (value == null || value === '') continue;
    if (['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value)) {
      out[key] = value;
    }
  }
  return out;
}

function inputProperties(catalog, category, modelId) {
  const schema = catalog?.categories?.[category]?.models?.[modelId]?.input_schema;
  return schema?.schemas?.input_data?.properties || schema || {};
}

export function normalizeCreateWorkflowIr(rawIr, { userRequest, catalog }) {
  const requestedCategory = TARGET_CATEGORIES.has(rawIr?.target_category)
    ? rawIr.target_category
    : inferCategory(userRequest);
  const fallbackProfile = defaultArchitectModelProfile(requestedCategory) || defaultArchitectModelProfile('image');
  const modelId = getArchitectModelProfile(requestedCategory, rawIr?.model_id)
    ? rawIr.model_id
    : fallbackProfile?.modelId;

  const props = inputProperties(catalog, requestedCategory, modelId);
  const allowedParameterKeys = new Set(Object.keys(props));
  const parameters = {
    ...(fallbackProfile?.defaultParameters || {}),
    ...pruneParameters(rawIr?.parameters, allowedParameterKeys),
  };

  const normalized = {
    operation: 'create_workflow',
    workflow_name: clampString(rawIr?.workflow_name, titleFromRequest(userRequest), MAX_NAME_LENGTH),
    target_category: requestedCategory,
    model_id: modelId,
    prompt: clampString(rawIr?.prompt, userRequest || 'Generate a creative result.', MAX_PROMPT_LENGTH),
    parameters,
    assumptions: Array.isArray(rawIr?.assumptions)
      ? rawIr.assumptions.filter((item) => typeof item === 'string').slice(0, 5)
      : [],
  };

  const validation = validateCreateWorkflowIr(normalized, { catalog });
  if (!validation.valid) {
    const error = new Error(validation.errors.map((item) => item.message).join('; '));
    error.code = 'ARCHITECT_IR_INVALID';
    error.validation = validation;
    throw error;
  }
  return normalized;
}

function coerceScalar(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseParameterUpdates(text, selectedNode) {
  const updates = {};
  const request = String(text || '');
  const known = Object.keys(selectedNode?.parameters || {});
  for (const key of known) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = request.match(new RegExp(`\\b${escaped}\\b\\s*(?:to|=|:)\\s*([^,.;]+)`, 'i'));
    if (match) updates[key] = coerceScalar(match[1]);
  }
  return updates;
}

function prunePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    if (child == null || child === '') continue;
    if (['string', 'number', 'boolean'].includes(typeof child) || Array.isArray(child)) {
      out[key] = child;
    }
  }
  return out;
}

function normalizeInsertNode(request = {}) {
  const raw = request.insert_node && typeof request.insert_node === 'object' ? request.insert_node : null;
  if (!raw) return null;
  return normalizeInsertNodeValue(raw, request);
}

function normalizeInsertNodeValue(raw = {}, request = {}) {
  const category = TARGET_CATEGORIES.has(raw.category) ? raw.category : inferCategory(`${raw.model_id || ''} ${request.prompt_redacted || ''}`);
  const fallbackProfile = defaultArchitectModelProfile(category);
  const requestedModelId = typeof raw.model_id === 'string' ? raw.model_id.trim() : null;
  if (requestedModelId && !getArchitectModelProfile(category, requestedModelId)) {
    const error = new Error(`Model "${requestedModelId}" is not a curated ${category} insertion model.`);
    error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
    throw error;
  }
  const modelId = requestedModelId || fallbackProfile?.modelId;
  const position = raw.position === 'before' || raw.position === 'after'
    ? raw.position
    : request.position === 'before'
      ? 'before'
      : 'after';

  return {
    position,
    category,
    model_id: modelId,
    title: typeof raw.title === 'string' ? raw.title.trim().slice(0, MAX_NAME_LENGTH) : null,
    node_id: typeof raw.node_id === 'string' ? raw.node_id.trim() : null,
    parameters: {
      ...(fallbackProfile?.defaultParameters || {}),
      ...prunePlainObject(raw.parameters),
    },
  };
}

function normalizeInsertNodes(request = {}) {
  const explicit = Array.isArray(request.insert_nodes)
    ? request.insert_nodes
    : Array.isArray(request.nodes_to_add)
      ? request.nodes_to_add
      : null;
  if (explicit) {
    return explicit
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .slice(0, 4)
      .map((item) => normalizeInsertNodeValue(item, request));
  }
  const single = normalizeInsertNode(request);
  return single ? [single] : [];
}

function normalizeStringList(value, max = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeConnections(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .slice(0, 8)
    .map((item) => ({
      edge_id: typeof item.edge_id === 'string' ? item.edge_id.trim() : null,
      source_node_id: typeof item.source_node_id === 'string' ? item.source_node_id.trim() : typeof item.sourceNodeId === 'string' ? item.sourceNodeId.trim() : null,
      source_port: typeof item.source_port === 'string' ? item.source_port.trim() : typeof item.sourcePort === 'string' ? item.sourcePort.trim() : null,
      target_node_id: typeof item.target_node_id === 'string' ? item.target_node_id.trim() : typeof item.targetNodeId === 'string' ? item.targetNodeId.trim() : null,
      target_port: typeof item.target_port === 'string' ? item.target_port.trim() : typeof item.targetPort === 'string' ? item.targetPort.trim() : null,
      mode: item.mode === 'replace_existing' ? 'replace_existing' : 'fail_if_occupied',
    }))
    .filter((item) => item.source_node_id && item.source_port && item.target_node_id && item.target_port);
}

export function normalizeBoundedEditRequest(request = {}, context) {
  const selectedNode = context.selectedNode;
  const parameterUpdates = {
    ...parseParameterUpdates(request.prompt_redacted, selectedNode),
    ...prunePlainObject(request.parameter_updates),
  };
  const replacementModelId = typeof request.replacement_model_id === 'string'
    ? request.replacement_model_id.trim()
    : null;
  const insertNodes = normalizeInsertNodes(request);
  const insertNode = insertNodes[0] || null;
  const replaceEdgeId = typeof request.replace_edge_id === 'string'
    ? request.replace_edge_id.trim()
    : typeof request.branch_replacement?.edge_id === 'string'
      ? request.branch_replacement.edge_id.trim()
      : null;
  const replaceEdgeIds = [
    ...(replaceEdgeId ? [replaceEdgeId] : []),
    ...normalizeStringList(request.replace_edge_ids || request.branch_replacement?.edge_ids),
  ].filter((item, index, values) => values.indexOf(item) === index).slice(0, 8);

  if (replacementModelId && !getArchitectModelProfile(selectedNode.category, replacementModelId)) {
    const error = new Error(`Model "${replacementModelId}" is not a curated ${selectedNode.category} alternative.`);
    error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
    throw error;
  }
  for (const node of insertNodes) {
    if (!getArchitectModelProfile(node.category, node.model_id)) {
      const error = new Error(`Model "${node.model_id}" is not a curated ${node.category} insertion model.`);
      error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
      throw error;
    }
  }

  return {
    parameter_updates: parameterUpdates,
    replacement_model_id: replacementModelId || null,
    insert_node: insertNode,
    insert_nodes: insertNodes,
    replace_edge_id: replaceEdgeId,
    replace_edge_ids: replaceEdgeIds,
    disconnect_edge_ids: normalizeStringList(request.disconnect_edge_ids || request.disconnects),
    connections: normalizeConnections(request.connections || request.rewire_connections),
    assumptions: [],
  };
}

function inferCategory(text = '') {
  const lower = text.toLowerCase();
  if (/\b(audio|voice|speech|tts|narration|song|music)\b/.test(lower)) return 'audio';
  if (/\b(video|animation|clip|movie|cinematic)\b/.test(lower)) return 'video';
  if (/\b(text|caption|copy|story|article|summary)\b/.test(lower)) return 'text';
  return 'image';
}

function titleFromRequest(text = '') {
  const compact = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s-]/g, '')
    .trim();
  if (!compact) return 'Architect workflow';
  return compact.length <= MAX_NAME_LENGTH ? compact : `${compact.slice(0, MAX_NAME_LENGTH - 1).trim()}`;
}
