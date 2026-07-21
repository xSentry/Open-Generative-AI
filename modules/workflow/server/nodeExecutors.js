// Phase 3 — provider-agnostic node execution.
//
// Each graph node has a `category` (text/image/video/audio/api/utility) and a
// `model` + resolved `params`. This module turns one node into the UI output
// contract: { id, outputs: [{ type, value, id }] } with
//   type ∈ { image_url, video_url, audio_url, text }.
//
// Pure/local node types (text, passthrough, prompt-concatenator) run inline.
// Media nodes delegate the actual inference to the existing provider
// abstraction (modules/providers/*), which is what keeps the engine
// provider-independent: adding a custom provider only means adding a runner in
// `runModel`.
import { requireProviderOperation } from '../../providers/server/registry.js';
import { executeUtilityNode } from './utilityNodes.js';

function newId() {
  return (globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// UI output type for a node, derived from its category. Text/utility concat
// nodes emit text; media nodes emit the matching *_url type.
function outputTypeForCategory(category) {
  switch (category) {
    case 'image':
      return 'image_url';
    case 'video':
      return 'video_url';
    case 'audio':
      return 'audio_url';
    default:
      return 'text';
  }
}

function textOutput(value) {
  return { id: newId(), outputs: [{ type: 'text', value: value ?? '', id: newId() }] };
}

// Normalize a provider result ({ url, outputs, text }) into the UI output list.
function normalizeOutputs(providerResult, category) {
  const type = outputTypeForCategory(category);
  if (type === 'text') {
    if (typeof providerResult?.text === 'string') {
      return [{ type, value: providerResult.text, id: newId() }];
    }
    if (Array.isArray(providerResult?.outputs) && providerResult.outputs.length) {
      return providerResult.outputs.map((value) => ({ type, value, id: newId() }));
    }
  }
  const urls = Array.isArray(providerResult?.outputs) && providerResult.outputs.length
    ? providerResult.outputs
    : providerResult?.url
      ? [providerResult.url]
      : [];
  return urls.map((value) => ({ type, value, id: newId() }));
}

// Dispatch real model inference to the active provider. Injectable via
// executeNode's `runners` for tests.
async function defaultRunModel({ provider, apiKey, model, mode, category, params, onStarted }) {
  const adapter = requireProviderOperation(provider, 'workflow');
  const resolved = await adapter.catalog.getModelById(model, {
    mode: mode || null,
    category: category || null,
    params,
  });
  if (!resolved) throw new Error(`Unknown model "${model}" for provider "${provider}".`);
  return adapter.predictions.run({ apiKey, model: resolved, params, onStarted });
}

function isPassthrough(model) {
  return typeof model === 'string' && model.endsWith('-passthrough');
}

// Best-effort only: an unavailable runtime-history DB must never stop a node.
// Kept next to model resolution so workflow nodes use the exact same signature
// policy as Studio and the shared Replicate runner.
export async function estimateReplicateNodeRuntime({ provider, model, mode, category, params }) {
  const adapter = requireProviderOperation(provider, 'workflow');
  if (!adapter.runtime?.estimate) return null;
  const resolved = await adapter.catalog.getModelById(model, { mode, category, params });
  if (!resolved) return null;
  try {
    return await adapter.runtime.estimate({ model: resolved, params });
  } catch (error) {
    console.warn('[provider-runtime] could not calculate workflow node estimate:', error?.message || error);
    return null;
  }
}

// Execute a single node with already-resolved params.
export async function executeNode({
  provider,
  apiKey,
  node,
  runModel = defaultRunModel,
  onProviderStarted,
}) {
  const category = node.category || null;
  const model = node.model || null;
  const params = node.params || {};

  // ---- Pure local nodes (no inference) ----

  // Text input node — emits its prompt text downstream. A text node with a real
  // model id is handled by the inference branch below.
  if ((category === 'text' && (!model || model === 'text-passthrough')) || model === 'text-passthrough') {
    return textOutput(params.prompt ?? params.text ?? '');
  }

  // Registered local utility nodes (prompt concatenator, media transforms, etc.).
  if (category === 'utility') {
    const result = await executeUtilityNode({ model, params });
    if (result) return result;
  }

  // Media passthrough / upload nodes — surface the provided URL unchanged.
  if (isPassthrough(model)) {
    const value =
      params.image_url ?? params.video_url ?? params.audio_url ?? params.prompt ?? '';
    return { id: newId(), outputs: [{ type: outputTypeForCategory(category), value, id: newId() }] };
  }

  // ---- Inference nodes (text / image / video / audio) ----
  if (category === 'text' || category === 'image' || category === 'video' || category === 'audio') {
    const providerResult = await runModel({
      provider,
      apiKey,
      model,
      mode: node.providerMode || node.provider_mode || node.mode || null,
      category,
      params,
      onStarted: onProviderStarted,
    });
    return { id: newId(), outputs: normalizeOutputs(providerResult, category) };
  }

  // API nodes and any utility that is only schema-registered are not part of
  // the local engine. Fail clearly so the UI surfaces an actionable message.
  throw new Error(`Node type not supported by the local engine yet (category="${category}", model="${model}").`);
}

export { normalizeOutputs, outputTypeForCategory };

