import { buildNodeSchemas } from '../../workflow/server/schemas.js';
import {
  getInputPortDefinitions,
  getOutputPortDefinitions,
  nodeTypeForCategory,
  portTypesCompatible,
} from '../../workflow-domain/portRegistry.js';

export const ARCHITECT_CATALOG_VERSION = 'replicate-architect-catalog/v2';

export const CURATED_MODEL_PROFILES = {
  image: [
    {
      modelId: 'nano-banana-2',
      label: 'Nano Banana image generation',
      promptPort: 'prompt',
      qualityTier: 'high',
      speedTier: 'fast',
      defaultParameters: {
        aspect_ratio: 'match_input_image',
        resolution: '1K',
        google_search: false,
        image_search: false,
        output_format: 'jpg',
      },
    },
    {
      modelId: 'gpt-image-2',
      label: 'GPT Image generation',
      promptPort: 'prompt',
      qualityTier: 'high',
      speedTier: 'balanced',
      defaultParameters: {
        aspect_ratio: '1:1',
        number_of_images: 1,
        quality: 'auto',
        background: 'auto',
        output_compression: 90,
        output_format: 'webp',
        moderation: 'auto',
      },
    },
  ],
  video: [
    {
      modelId: 'seedance-2-0-mini',
      label: 'Seedance 2.0 Mini video generation',
      promptPort: 'prompt',
      qualityTier: 'standard',
      speedTier: 'fast',
      defaultParameters: {
        duration: 5,
        resolution: '720p',
        aspect_ratio: '16:9',
        generate_audio: true,
      },
    },
  ],
  audio: [
    {
      modelId: 'realtime-tts-2',
      label: 'Text-to-speech narration',
      promptPort: 'text',
      qualityTier: 'high',
      speedTier: 'fast',
      defaultParameters: {
        voice_id: 'Ashley',
        language: 'auto',
        temperature: 0,
        audio_format: 'mp3',
        sample_rate: 48000,
        speaking_rate: 0,
        text_normalization: 'auto',
      },
    },
    {
      modelId: 'gemini-3-1-flash-tts',
      label: 'Gemini Flash text-to-speech',
      promptPort: 'text',
      qualityTier: 'high',
      speedTier: 'fast',
      defaultParameters: {
        voice: 'Kore',
        prompt: 'Say the following.',
        language_code: 'en-US',
      },
    },
  ],
  text: [
    {
      modelId: 'gpt-5-mini',
      label: 'GPT-5 Mini text generation',
      promptPort: 'prompt',
      qualityTier: 'high',
      speedTier: 'fast',
      defaultParameters: {
        reasoning_effort: 'minimal',
        verbosity: 'medium',
      },
    },
    {
      modelId: 'gpt-5-6-luna',
      label: 'GPT-5.6 Luna text generation',
      promptPort: 'prompt',
      qualityTier: 'high',
      speedTier: 'fast',
      defaultParameters: {
        reasoning_effort: 'none',
        verbosity: 'medium',
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

function profileStability(profile) {
  return profile.stability || 'stable';
}

function compactPorts(ports = {}) {
  return Object.fromEntries(
    Object.entries(ports).map(([name, def]) => [
      name,
      {
        type: def.type || 'unknown',
        cardinality: def.maxConnections === Infinity ? 'many' : 'one',
        required: def.required === true,
      },
    ])
  );
}

function requiredParameters(entry) {
  const props = entry?.input_schema?.schemas?.input_data?.properties || entry?.input_schema || {};
  return Object.entries(props)
    .filter(([, meta]) => meta?.required === true)
    .map(([name]) => name);
}

function catalogNode(category, profile, entry) {
  const modelId = profile.modelId;
  const nodeType = nodeTypeForCategory(category, modelId);
  const inputs = getInputPortDefinitions({ category, modelId, nodeType, catalog: { categories: { [category]: { models: { [modelId]: entry } } } } });
  const outputs = getOutputPortDefinitions({ category, modelId });
  return {
    node_type: nodeType,
    category,
    capability: category,
    kind: modelId.endsWith('-passthrough') ? 'input' : 'generation',
    model_id: modelId,
    model_label: profile.label,
    architect_enabled: true,
    exposure_support: true,
    stability: profileStability(profile),
    speed_tier: profile.speedTier,
    quality_tier: profile.qualityTier,
    input_ports: compactPorts(inputs),
    output_ports: compactPorts(outputs),
    required_parameters: requiredParameters(entry),
    default_parameters: profile.defaultParameters || {},
    model_preferences: {
      curated_default: true,
      prompt_port: profile.promptPort,
    },
  };
}

function passthroughNode(category, entry) {
  const modelId = `${category}-passthrough`;
  const nodeType = nodeTypeForCategory(category, modelId);
  return {
    node_type: nodeType,
    category,
    capability: category,
    kind: 'input',
    model_id: modelId,
    model_label: `${category} input`,
    architect_enabled: true,
    exposure_support: true,
    stability: 'stable',
    speed_tier: 'fast',
    quality_tier: 'standard',
    input_ports: compactPorts(getInputPortDefinitions({ category, modelId, nodeType, catalog: { categories: { [category]: { models: { [modelId]: entry } } } } })),
    output_ports: compactPorts(getOutputPortDefinitions({ category, modelId })),
    required_parameters: requiredParameters(entry),
    default_parameters: {},
    model_preferences: {
      curated_default: false,
      prompt_port: category === 'text' ? 'prompt' : category,
    },
  };
}

function buildConnectionRules(nodes) {
  const rules = [];
  for (const source of nodes) {
    for (const target of nodes) {
      if (source.model_id === target.model_id && source.kind === 'input') continue;
      for (const [sourcePort, sourceDef] of Object.entries(source.output_ports || {})) {
        for (const [targetPort, targetDef] of Object.entries(target.input_ports || {})) {
          if (!portTypesCompatible(sourceDef.type, targetDef.type)) continue;
          rules.push({
            source_capability: source.capability,
            source_model_id: source.model_id,
            source_port: sourcePort,
            output_type: sourceDef.type,
            target_capability: target.capability,
            target_model_id: target.model_id,
            target_port: targetPort,
            input_type: targetDef.type,
            target_cardinality: targetDef.cardinality,
          });
        }
      }
    }
  }
  return rules;
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
  const nodeTypes = [];

  for (const [category, profiles] of Object.entries(CURATED_MODEL_PROFILES)) {
    categories[category] = { models: {} };
    for (const profile of profiles) {
      const entry = cloneEntry(modelEntry(sourceCatalog, category, profile.modelId), profile);
      if (!entry) continue;
      categories[category].models[profile.modelId] = entry;
      const node = catalogNode(category, profile, entry);
      nodeTypes.push(node);
      compact.push({
        category,
        model_id: profile.modelId,
        label: profile.label,
        capability: category,
        node_type: node.node_type,
        kind: node.kind,
        input_ports: node.input_ports,
        output_ports: node.output_ports,
        stability: node.stability,
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
      nodeTypes.push(passthroughNode(category, passthrough));
    }
  }

  return {
    version: ARCHITECT_CATALOG_VERSION,
    provider,
    categories,
    compact,
    node_types: nodeTypes,
    connection_rules: buildConnectionRules(nodeTypes),
  };
}
