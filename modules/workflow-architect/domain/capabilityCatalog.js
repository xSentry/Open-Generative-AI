import { buildNodeSchemas } from '../../workflow/server/schemas.js';
import { canExecuteUtilityNode } from '../../workflow/server/utilityNodes.js';
import { requireProviderFeature } from '../../providers/publicRegistry.js';
import {
  getInputPortDefinitions,
  getOutputPortDefinitions,
  nodeTypeForCategory,
  portTypesCompatible,
  PORT_TYPES,
  schemaToPorts,
} from '../../workflow-domain/portRegistry.js';

export const ARCHITECT_CATALOG_VERSION = 'replicate-architect-catalog/v3';

export const ARCHITECT_CAPABILITY_ALIASES = {
  image_generation: ['image_generation', 'text_to_image', 'image'],
  image_editing: ['image_editing', 'image_to_image', 'image_reference'],
  video_generation: ['video_generation', 'text_to_video', 'video'],
  image_to_video: ['image_to_video'],
  video_to_video: ['video_to_video'],
  text_generation: ['text_generation', 'text'],
  text_to_speech: ['text_to_speech', 'tts', 'audio_generation'],
  utility_text_merge: ['utility_text_merge', 'prompt_merge', 'prompt_concatenation'],
  utility_video_combine: ['utility_video_combine', 'video_combine'],
  utility_frame_extraction: ['utility_frame_extraction', 'frame_extraction'],
};

export const CURATED_MODEL_PROFILES = {
  image: [
    {
      modelId: 'nano-banana-2',
      label: 'Nano Banana image generation',
      promptPort: 'prompt',
      qualityTier: 'high',
      speedTier: 'fast',
      cost: 'normal',
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
      cost: 'expensive',
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
      cost: 'expensive',
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
      cost: 'expensive',
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
      cost: 'cheap',
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
      cost: 'cheap',
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
      cost: 'normal',
      defaultParameters: {
        reasoning_effort: 'none',
        verbosity: 'medium',
      },
    },
  ],
};

export const CURATED_MODEL_PROFILES_BY_PROVIDER = Object.freeze({
  replicate: CURATED_MODEL_PROFILES,
});

export function getProviderArchitectProfiles(provider = 'replicate') {
  return CURATED_MODEL_PROFILES_BY_PROVIDER[provider] || {};
}

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
      cost: profile.cost,
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
  const props = inputProperties(entry);
  return Object.entries(props)
    .filter(([, meta]) => meta?.required === true)
    .map(([name]) => name);
}

function defaultParameters(entry) {
  const props = inputProperties(entry);
  const out = {};
  for (const [key, meta] of Object.entries(props)) {
    if (meta && Object.prototype.hasOwnProperty.call(meta, 'default') && meta.default != null) {
      out[key] = meta.default;
    }
  }
  return out;
}

function inputProperties(entry) {
  return entry?.input_schema?.schemas?.input_data?.properties || entry?.input_schema || {};
}

function declaredInputPorts(entry, fallback = {}) {
  const ports = schemaToPorts(inputProperties(entry));
  return Object.keys(ports).length > 0 ? ports : fallback;
}

function hasPortType(ports, type) {
  return Object.values(ports || {}).some((port) => port.type === type);
}

function requiredPortTypes(inputPorts = {}) {
  return [...new Set(Object.values(inputPorts).filter((port) => port.required).map((port) => port.type))];
}

function capabilityForNode(category, modelId, inputPorts, outputPorts) {
  if (category === 'utility') {
    if (modelId === 'prompt-concatenator') return 'utility_text_merge';
    if (modelId === 'video-combiner') return 'utility_video_combine';
    if (modelId === 'video-frame-extractor') return 'utility_frame_extraction';
    return 'utility';
  }
  if (category === 'text') return 'text_generation';
  if (category === 'audio') return 'text_to_speech';
  if (category === 'image') {
    return hasPortType(inputPorts, PORT_TYPES.image) ? 'image_editing' : 'image_generation';
  }
  if (category === 'video') {
    if (hasPortType(inputPorts, PORT_TYPES.video)) return 'video_to_video';
    if (hasPortType(inputPorts, PORT_TYPES.image)) return 'image_to_video';
    return 'video_generation';
  }
  return category;
}

function operationModes(category, inputPorts, capability) {
  const modes = new Set();
  if (category === 'utility') modes.add('utility');
  else modes.add('generate');
  if (hasPortType(inputPorts, PORT_TYPES.image)) modes.add('image_input');
  if (hasPortType(inputPorts, PORT_TYPES.video)) modes.add('video_input');
  if (hasPortType(inputPorts, PORT_TYPES.audio)) modes.add('audio_input');
  if (capability === 'image_editing') modes.add('edit');
  if (capability === 'image_to_video') modes.add('image_to_video');
  if (capability === 'video_to_video') modes.add('video_to_video');
  return [...modes];
}

function canIntroduceOnEmptyCanvas(category, inputPorts) {
  if (category === 'utility') return false;
  return requiredPortTypes(inputPorts).every((type) => type === PORT_TYPES.text);
}

function introductionMetadata(category, inputPorts, executable = true) {
  if (!executable) {
    return {
      status: 'explanation_only',
      reason: 'Node is exposed for explanation because it has no supported execution path.',
    };
  }
  if (canIntroduceOnEmptyCanvas(category, inputPorts)) {
    return {
      status: 'introducible',
      reason: 'Node can be introduced with text/default inputs on an empty canvas.',
    };
  }
  const requiredMedia = requiredPortTypes(inputPorts).filter((type) => type !== PORT_TYPES.text);
  if (requiredMedia.length > 0) {
    return {
      status: 'requires_upstream_input',
      reason: `Node requires upstream ${requiredMedia.join(', ')} input before it can be introduced safely.`,
    };
  }
  if (category === 'utility') {
    return {
      status: 'requires_upstream_input',
      reason: 'Utility nodes require compatible upstream workflow data before introduction.',
    };
  }
  return {
    status: 'requires_parameters',
    reason: 'Node requires parameters or context that are not safe to synthesize on an empty canvas.',
  };
}

function promptPortForInputs(inputPorts = {}) {
  if (inputPorts.prompt) return 'prompt';
  if (inputPorts.text) return 'text';
  if (inputPorts.instruction) return 'instruction';
  if (inputPorts.system_prompt) return 'system_prompt';
  return Object.entries(inputPorts).find(([, def]) => def.type === PORT_TYPES.text)?.[0] || null;
}

function compactNodeRecord(node) {
  return {
    category: node.category,
    model_id: node.model_id,
    label: node.model_label,
    capability: node.capability,
    capability_aliases: node.capability_aliases,
    operation_modes: node.operation_modes,
    node_type: node.node_type,
    kind: node.kind,
    input_ports: node.input_ports,
    output_ports: node.output_ports,
    required_media_inputs: node.required_media_inputs,
    output_media_type: node.output_media_type,
    introducible_on_empty_canvas: node.introducible_on_empty_canvas,
    introduction_status: node.introduction_status,
    not_introducible_reason: node.not_introducible_reason,
    stability: node.stability,
    prompt_port: node.model_preferences?.prompt_port || null,
    speed_tier: node.speed_tier,
    quality_tier: node.quality_tier,
    cost: node.cost,
    default_parameters: node.default_parameters || {},
  };
}

function catalogNode(category, profile, entry) {
  const modelId = profile.modelId;
  const nodeType = nodeTypeForCategory(category, modelId);
  const fallbackInputs = getInputPortDefinitions({ category, modelId, nodeType, catalog: { categories: { [category]: { models: { [modelId]: entry } } } } });
  const inputs = declaredInputPorts(entry, fallbackInputs);
  const outputs = getOutputPortDefinitions({ category, modelId });
  const compactInputs = compactPorts(inputs);
  const compactOutputs = compactPorts(outputs);
  const capability = capabilityForNode(category, modelId, compactInputs, compactOutputs);
  const introduction = introductionMetadata(category, compactInputs);
  return {
    node_type: nodeType,
    category,
    capability,
    capability_aliases: ARCHITECT_CAPABILITY_ALIASES[capability] || [capability, category],
    kind: modelId.endsWith('-passthrough') ? 'input' : 'generation',
    model_id: modelId,
    model_label: profile.label,
    architect_enabled: true,
    exposure_support: true,
    stability: profileStability(profile),
    speed_tier: profile.speedTier,
    quality_tier: profile.qualityTier,
    cost: profile.cost || 'normal',
    operation_modes: operationModes(category, compactInputs, capability),
    input_ports: compactInputs,
    output_ports: compactOutputs,
    required_media_inputs: requiredPortTypes(compactInputs).filter((type) => type !== PORT_TYPES.text),
    output_media_type: Object.values(compactOutputs)[0]?.type || 'unknown',
    introducible_on_empty_canvas: canIntroduceOnEmptyCanvas(category, compactInputs),
    introduction_status: introduction.status,
    not_introducible_reason: introduction.status === 'introducible' ? null : introduction.reason,
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
  const inputPorts = compactPorts(declaredInputPorts(entry, getInputPortDefinitions({ category, modelId, nodeType, catalog: { categories: { [category]: { models: { [modelId]: entry } } } } })));
  const outputPorts = compactPorts(getOutputPortDefinitions({ category, modelId }));
  const introduction = introductionMetadata(category, inputPorts);
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
    cost: 'cheap',
    operation_modes: ['input'],
    capability_aliases: [category, `${category}_input`],
    input_ports: inputPorts,
    output_ports: outputPorts,
    required_media_inputs: requiredPortTypes(inputPorts).filter((type) => type !== PORT_TYPES.text),
    output_media_type: Object.values(outputPorts)[0]?.type || 'unknown',
    introducible_on_empty_canvas: true,
    introduction_status: introduction.status,
    not_introducible_reason: null,
    required_parameters: requiredParameters(entry),
    default_parameters: {},
    model_preferences: {
      curated_default: false,
      prompt_port: category === 'text' ? 'prompt' : category,
    },
  };
}

function catalogNodeFromEntry(category, modelId, entry) {
  const nodeType = entry?.workflow?.node_type || nodeTypeForCategory(category, modelId);
  const catalog = { categories: { [category]: { models: { [modelId]: entry } } } };
  const inputPorts = compactPorts(declaredInputPorts(entry, getInputPortDefinitions({ category, modelId, nodeType, catalog })));
  const outputPorts = compactPorts(getOutputPortDefinitions({ category, modelId }));
  const capability = capabilityForNode(category, modelId, inputPorts, outputPorts);
  const utilityExecutable = category !== 'utility' || canExecuteUtilityNode(modelId);
  const promptPort = promptPortForInputs(inputPorts);
  const introduction = introductionMetadata(category, inputPorts, utilityExecutable);
  return {
    node_type: nodeType,
    category,
    capability,
    capability_aliases: ARCHITECT_CAPABILITY_ALIASES[capability] || [capability, category],
    kind: modelId.endsWith('-passthrough') ? 'input' : category === 'utility' ? 'utility' : 'generation',
    model_id: modelId,
    model_label: entry?.name || modelId,
    architect_enabled: utilityExecutable,
    exposure_support: category !== 'utility',
    stability: entry?.stability || 'catalog',
    speed_tier: entry?.speedTier || 'balanced',
    quality_tier: entry?.qualityTier || 'standard',
    cost: entry?.cost || 'normal',
    operation_modes: operationModes(category, inputPorts, capability),
    input_ports: inputPorts,
    output_ports: outputPorts,
    required_media_inputs: requiredPortTypes(inputPorts).filter((type) => type !== PORT_TYPES.text),
    output_media_type: Object.values(outputPorts)[0]?.type || 'unknown',
    introducible_on_empty_canvas: utilityExecutable && canIntroduceOnEmptyCanvas(category, inputPorts),
    introduction_status: introduction.status,
    not_introducible_reason: introduction.status === 'introducible' ? null : introduction.reason,
    required_parameters: requiredParameters(entry),
    default_parameters: defaultParameters(entry),
    execution_support: {
      local_utility: category === 'utility',
      executable: utilityExecutable,
    },
    model_preferences: {
      curated_default: false,
      prompt_port: promptPort,
    },
  };
}

function buildConnectionRules(nodes) {
  const rules = [];
  const seen = new Set();
  for (const source of nodes) {
    for (const target of nodes) {
      if (source.model_id === target.model_id && source.kind === 'input') continue;
      for (const [sourcePort, sourceDef] of Object.entries(source.output_ports || {})) {
        for (const [targetPort, targetDef] of Object.entries(target.input_ports || {})) {
          if (!portTypesCompatible(sourceDef.type, targetDef.type)) continue;
          const key = [
            source.capability,
            sourcePort,
            sourceDef.type,
            target.capability,
            targetPort,
            targetDef.type,
            targetDef.cardinality,
          ].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          rules.push({
            source_capability: source.capability,
            source_port: sourcePort,
            output_type: sourceDef.type,
            target_capability: target.capability,
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

export function getArchitectModelProfile(category, modelId, provider = 'replicate') {
  return (getProviderArchitectProfiles(provider)[category] || []).find((profile) => profile.modelId === modelId) || null;
}

export function getArchitectNodeProfile(category, modelId, catalog = null, provider = catalog?.provider || 'replicate') {
  const curated = getArchitectModelProfile(category, modelId, provider);
  if (curated) return curated;
  const entry = modelEntry(catalog, category, modelId);
  if (!entry) return null;
  const node = catalogNodeFromEntry(category, modelId, entry);
  if (!node.architect_enabled) return null;
  return {
    modelId,
    label: node.model_label,
    promptPort: node.model_preferences.prompt_port,
    qualityTier: node.quality_tier,
    speedTier: node.speed_tier,
    cost: node.cost,
    stability: node.stability,
    defaultParameters: node.default_parameters,
    capability: node.capability,
    category,
  };
}

export function defaultArchitectModelProfile(category, {
  catalog = null,
  capability = null,
  operationMode = null,
  introducibleOnEmptyCanvas = false,
  provider = catalog?.provider || 'replicate',
} = {}) {
  const providerProfiles = getProviderArchitectProfiles(provider);
  const curated = providerProfiles[category]?.find((profile) => {
    const entry = modelEntry(catalog, category, profile.modelId);
    if (!entry) return true;
    const node = catalogNode(category, profile, entry);
    if (capability && node.capability !== capability && !node.capability_aliases.includes(capability)) return false;
    if (operationMode && !node.operation_modes.includes(operationMode)) return false;
    if (introducibleOnEmptyCanvas && !node.introducible_on_empty_canvas) return false;
    return true;
  });
  if (curated) return curated;
  const models = catalog?.categories?.[category]?.models || {};
  for (const [modelId, entry] of Object.entries(models)) {
    const node = catalogNodeFromEntry(category, modelId, entry);
    if (!node.architect_enabled) continue;
    if (capability && node.capability !== capability && !node.capability_aliases.includes(capability)) continue;
    if (operationMode && !node.operation_modes.includes(operationMode)) continue;
    if (introducibleOnEmptyCanvas && !node.introducible_on_empty_canvas) continue;
    return getArchitectNodeProfile(category, modelId, catalog, provider);
  }
  return providerProfiles[category]?.[0] || null;
}

export function buildArchitectCapabilityCatalog(provider = 'replicate', fullCatalog = null) {
  requireProviderFeature(provider, 'workflowArchitect');

  const sourceCatalog = fullCatalog || buildNodeSchemas(provider);
  const categories = {};
  const compact = [];
  const nodeTypes = [];
  const providerProfiles = getProviderArchitectProfiles(provider);

  for (const category of ['text', 'image', 'video', 'audio', 'utility']) {
    categories[category] = { models: {} };
    const sourceModels = sourceCatalog.categories?.[category]?.models || {};
    for (const [modelId, sourceEntry] of Object.entries(sourceModels)) {
      const curated = (providerProfiles[category] || []).find((profile) => profile.modelId === modelId) || null;
      const entry = curated ? cloneEntry(sourceEntry, curated) : { ...sourceEntry, architectEnabled: true };
      const node = curated ? catalogNode(category, curated, entry) : catalogNodeFromEntry(category, modelId, entry);
      if (!node.architect_enabled) continue;
      categories[category].models[modelId] = entry;
      nodeTypes.push(node);
      compact.push(compactNodeRecord(node));
    }
  }

  for (const category of ['text', 'image', 'video', 'audio']) {
    const passthroughId = `${category}-passthrough`;
    if (categories[category]?.models?.[passthroughId]) continue;
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
