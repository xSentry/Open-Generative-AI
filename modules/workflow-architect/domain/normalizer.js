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

export function normalizeBoundedEditRequest(request = {}, context) {
  const selectedNode = context.selectedNode;
  const parameterUpdates = {
    ...parseParameterUpdates(request.prompt_redacted, selectedNode),
    ...prunePlainObject(request.parameter_updates),
  };
  const replacementModelId = typeof request.replacement_model_id === 'string'
    ? request.replacement_model_id.trim()
    : null;
  const insertNode = normalizeInsertNode(request);

  if (replacementModelId && !getArchitectModelProfile(selectedNode.category, replacementModelId)) {
    const error = new Error(`Model "${replacementModelId}" is not a curated ${selectedNode.category} alternative.`);
    error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
    throw error;
  }
  if (insertNode && !getArchitectModelProfile(insertNode.category, insertNode.model_id)) {
    const error = new Error(`Model "${insertNode.model_id}" is not a curated ${insertNode.category} insertion model.`);
    error.code = 'ARCHITECT_MODEL_NOT_ENABLED';
    throw error;
  }

  return {
    parameter_updates: parameterUpdates,
    replacement_model_id: replacementModelId || null,
    insert_node: insertNode,
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
