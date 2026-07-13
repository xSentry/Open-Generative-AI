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
