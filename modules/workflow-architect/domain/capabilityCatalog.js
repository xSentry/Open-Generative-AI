import { buildNodeSchemas } from '../../workflow/server/schemas.js';

export const ARCHITECT_CATALOG_VERSION = 'replicate-architect-catalog/v1';

export const CURATED_MODEL_PROFILES = {
  image: [
    {
      modelId: 'flux-schnell',
      label: 'Fast image generation',
      promptPort: 'prompt',
      qualityTier: 'standard',
      speedTier: 'fast',
      defaultParameters: {
        aspect_ratio: '1:1',
        output_format: 'webp',
      },
    },
    {
      modelId: 'imagen-4-fast',
      label: 'Fast Imagen 4 generation',
      promptPort: 'prompt',
      qualityTier: 'standard',
      speedTier: 'fast',
      defaultParameters: {
        aspect_ratio: '1:1',
        output_format: 'jpg',
      },
    },
  ],
  video: [
    {
      modelId: 'seedance-2-0-mini',
      label: 'Short text-to-video generation',
      promptPort: 'prompt',
      qualityTier: 'standard',
      speedTier: 'balanced',
      defaultParameters: {
        duration: 5,
        aspect_ratio: '16:9',
      },
    },
  ],
  audio: [
    {
      modelId: 'realtime-tts-2',
      label: 'Text-to-speech narration',
      promptPort: 'text',
      qualityTier: 'standard',
      speedTier: 'fast',
      defaultParameters: {},
    },
  ],
  text: [
    {
      modelId: 'gpt-5-nano',
      label: 'Text generation',
      promptPort: 'prompt',
      qualityTier: 'standard',
      speedTier: 'fast',
      defaultParameters: {
        max_completion_tokens: 800,
      },
    },
  ],
};

function modelEntry(fullCatalog, category, modelId) {
  return fullCatalog?.categories?.[category]?.models?.[modelId] || null;
}

function cloneEntry(entry, profile) {
  if (!entry) return null;
  return {
    ...entry,
    architectEnabled: true,
    architectProfile: {
      promptPort: profile.promptPort,
      qualityTier: profile.qualityTier,
      speedTier: profile.speedTier,
    },
  };
}

export function getArchitectModelProfile(category, modelId) {
  return (CURATED_MODEL_PROFILES[category] || []).find((profile) => profile.modelId === modelId) || null;
}

export function defaultArchitectModelProfile(category) {
  return CURATED_MODEL_PROFILES[category]?.[0] || null;
}

export function buildArchitectCapabilityCatalog(provider = 'replicate', fullCatalog = null) {
  if (provider !== 'replicate') {
    return {
      version: ARCHITECT_CATALOG_VERSION,
      provider,
      categories: {},
      compact: [],
    };
  }

  const sourceCatalog = fullCatalog || buildNodeSchemas(provider);
  const categories = {};
  const compact = [];

  for (const [category, profiles] of Object.entries(CURATED_MODEL_PROFILES)) {
    categories[category] = { models: {} };
    for (const profile of profiles) {
      const entry = cloneEntry(modelEntry(sourceCatalog, category, profile.modelId), profile);
      if (!entry) continue;
      categories[category].models[profile.modelId] = entry;
      compact.push({
        category,
        model_id: profile.modelId,
        label: profile.label,
        prompt_port: profile.promptPort,
        speed_tier: profile.speedTier,
        quality_tier: profile.qualityTier,
        default_parameters: profile.defaultParameters || {},
      });
    }
  }

  for (const category of ['text', 'image', 'video', 'audio']) {
    const passthroughId = `${category}-passthrough`;
    const passthrough = modelEntry(sourceCatalog, category, passthroughId);
    if (passthrough) {
      categories[category] = categories[category] || { models: {} };
      categories[category].models[passthroughId] = {
        ...passthrough,
        architectEnabled: true,
      };
    }
  }

  return {
    version: ARCHITECT_CATALOG_VERSION,
    provider,
    categories,
    compact,
  };
}
