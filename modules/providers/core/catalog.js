import { ProviderError } from './errors.js';

const INPUT_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

export function normalizeModelLists(provider, lists = {}) {
  return Object.fromEntries(Object.entries(lists).map(([mode, models]) => [
    mode,
    (models || []).map((model) => ({
      ...model,
      provider,
      mode,
      inputs: Object.fromEntries(Object.entries(model.inputs || {}).map(([field, input]) => [
        field,
        input?.type === 'int' ? { ...input, type: 'integer' } : { ...input },
      ])),
    })),
  ]));
}

export function validateModelCatalog(provider, lists) {
  if (!lists || typeof lists !== 'object' || Array.isArray(lists)) {
    throw new ProviderError('provider_catalog_invalid', `Provider "${provider}" returned an invalid catalog.`, { provider });
  }
  for (const [mode, models] of Object.entries(lists)) {
    if (!Array.isArray(models)) throw new ProviderError('provider_catalog_invalid', `Catalog ${provider}/${mode} must be an array.`, { provider, mode });
    const ids = new Set();
    for (const model of models) {
      if (!model?.id || typeof model.id !== 'string') throw new ProviderError('provider_catalog_invalid', `Catalog ${provider}/${mode} contains a model without an id.`, { provider, mode });
      if (ids.has(model.id)) throw new ProviderError('provider_catalog_invalid', `Catalog ${provider}/${mode} contains duplicate model "${model.id}".`, { provider, mode, modelId: model.id });
      ids.add(model.id);
      if (!model.inputs || typeof model.inputs !== 'object' || Array.isArray(model.inputs)) {
        throw new ProviderError('provider_catalog_invalid', `Catalog model ${provider}/${mode}/${model.id} has invalid inputs.`, { provider, mode, modelId: model.id });
      }
      for (const [field, input] of Object.entries(model.inputs)) {
        if (input?.type && !INPUT_TYPES.has(input.type)) {
          throw new ProviderError('provider_catalog_invalid', `Catalog input ${provider}/${mode}/${model.id}/${field} has unknown type "${input.type}".`, { provider, mode, modelId: model.id, field });
        }
        if (input?.enum && !Array.isArray(input.enum)) {
          throw new ProviderError('provider_catalog_invalid', `Catalog input ${provider}/${mode}/${model.id}/${field} has an invalid enum.`, { provider, mode, modelId: model.id, field });
        }
      }
    }
  }
  return lists;
}

const CATEGORY_MODES = Object.freeze({
  text: ['t2t'],
  image: ['t2i', 'i2i', 'cinema'],
  video: ['t2v', 'i2v', 'v2v', 'recast', 'marketing'],
  audio: ['audio', 'lipsync'],
});

function hasMedia(params, keys) {
  return keys.some((key) => {
    const value = params?.[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
}

export function inferProviderMode(category, params = {}) {
  if (category === 'text') return 't2t';
  if (category === 'image') {
    return hasMedia(params, ['image_url', 'images_list', 'swap_url', 'swaps_list']) ? 'i2i' : 't2i';
  }
  if (category === 'video') {
    if (hasMedia(params, ['video_url', 'videos_list', 'video_files'])) return 'v2v';
    if (hasMedia(params, ['image_url', 'images_list', 'last_image'])) return 'i2v';
    return 't2v';
  }
  if (category === 'audio') {
    return hasMedia(params, ['video_url', 'videos_list', 'image_url', 'images_list']) ? 'lipsync' : 'audio';
  }
  return null;
}

export function resolveCatalogModel(lists, modelId, { mode = null, category = null, params = {} } = {}) {
  if (mode) return lists?.[mode]?.find((model) => model.id === modelId) || null;
  const inferred = inferProviderMode(category, params);
  if (inferred) {
    const match = lists?.[inferred]?.find((model) => model.id === modelId);
    if (match) return match;
  }
  const allowedModes = CATEGORY_MODES[category] || Object.keys(lists || {});
  const candidates = allowedModes.flatMap((candidateMode) =>
    (lists?.[candidateMode] || [])
      .filter((model) => model.id === modelId)
      .map((model) => ({ ...model, mode: model.mode || candidateMode })),
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const signatures = new Set(candidates.map((model) =>
    model.metadata?.nativeId || model.replicate?.ref || model.endpoint || model.id,
  ));
  return signatures.size === 1 ? candidates[0] : null;
}
