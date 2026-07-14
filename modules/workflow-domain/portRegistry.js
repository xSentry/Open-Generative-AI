import { getUtilityNodeDefinition, getUtilityNodeSchema } from '../workflow/server/utilityNodes.js';

export const PORT_TYPES = {
  text: 'text',
  image: 'image_url',
  video: 'video_url',
  audio: 'audio_url',
  unknown: 'unknown',
};

const SOURCE_HANDLE_TO_PORT = {
  textOutput: { port: 'text', type: PORT_TYPES.text },
  concatOutput: { port: 'text', type: PORT_TYPES.text },
  imageOutput: { port: 'image', type: PORT_TYPES.image },
  videoOutput: { port: 'video', type: PORT_TYPES.video },
  audioOutput: { port: 'audio', type: PORT_TYPES.audio },
  apiOutput: { port: 'result', type: PORT_TYPES.unknown },
  utilityOutput: { port: 'result', type: PORT_TYPES.unknown },
};

const TARGET_HANDLE_TO_PORT = {
  textInput: { port: 'prompt', type: PORT_TYPES.text, maxConnections: 1 },
  imageInput: { port: 'prompt', type: PORT_TYPES.text, maxConnections: 1 },
  videoInput: { port: 'prompt', type: PORT_TYPES.text, maxConnections: 1 },
  audioInput2: { port: 'prompt', type: PORT_TYPES.text, maxConnections: 1 },
  apiInput: { port: 'prompt', type: PORT_TYPES.text, maxConnections: 1 },
  textInput4: { port: 'system_prompt', type: PORT_TYPES.text, maxConnections: 1 },

  textInput2: { port: 'image_url', type: PORT_TYPES.image, maxConnections: 1 },
  videoInput2: { port: 'image_url', type: PORT_TYPES.image, maxConnections: 1 },
  imageInput3: { port: 'image_url', type: PORT_TYPES.image, maxConnections: 1 },
  audioInput3: { port: 'image_url', type: PORT_TYPES.image, maxConnections: 1 },
  apiInput3: { port: 'image_url', type: PORT_TYPES.image, maxConnections: 1 },

  textInput3: { port: 'images_list', type: PORT_TYPES.image, maxConnections: Infinity },
  imageInput2: { port: 'images_list', type: PORT_TYPES.image, maxConnections: Infinity },
  videoInput6: { port: 'images_list', type: PORT_TYPES.image, maxConnections: Infinity },
  apiInput2: { port: 'images_list', type: PORT_TYPES.image, maxConnections: Infinity },

  videoInput3: { port: 'last_image', type: PORT_TYPES.image, maxConnections: 1 },
  videoInput4: { port: 'video_url', type: PORT_TYPES.video, maxConnections: 1 },
  audioInput4: { port: 'video_url', type: PORT_TYPES.video, maxConnections: 1 },
  videoInput7: { port: 'videos_list', type: PORT_TYPES.video, maxConnections: Infinity },
  videoInput8: { port: 'audios_list', type: PORT_TYPES.audio, maxConnections: Infinity },
  audioInput: { port: 'audio_url', type: PORT_TYPES.audio, maxConnections: 1 },
  videoInput5: { port: 'audio_url', type: PORT_TYPES.audio, maxConnections: 1 },

  concatInput: { port: 'prompt', type: PORT_TYPES.text, maxConnections: Infinity },
};

const DEFAULT_TARGET_HANDLE_BY_PORT = {
  prompt: 'textInput',
  system_prompt: 'textInput4',
  image_url: 'textInput2',
  images_list: 'textInput3',
  last_image: 'videoInput3',
  video_url: 'videoInput4',
  videos_list: 'videoInput7',
  audios_list: 'videoInput8',
  audio_url: 'audioInput',
};

const OUTPUT_BY_CATEGORY = {
  text: { text: { type: PORT_TYPES.text, label: 'Text' } },
  image: { image: { type: PORT_TYPES.image, label: 'Image' } },
  video: { video: { type: PORT_TYPES.video, label: 'Video' } },
  audio: { audio: { type: PORT_TYPES.audio, label: 'Audio' } },
  api: { result: { type: PORT_TYPES.unknown, label: 'Result' } },
};

const COMPAT_INPUT_PORTS = {
  prompt: { type: PORT_TYPES.text, maxConnections: 1 },
  system_prompt: { type: PORT_TYPES.text, maxConnections: 1 },
  image_url: { type: PORT_TYPES.image, maxConnections: 1 },
  images_list: { type: PORT_TYPES.image, maxConnections: Infinity },
  last_image: { type: PORT_TYPES.image, maxConnections: 1 },
  video_url: { type: PORT_TYPES.video, maxConnections: 1 },
  videos_list: { type: PORT_TYPES.video, maxConnections: Infinity },
  video_files: { type: PORT_TYPES.video, maxConnections: Infinity },
  audio_url: { type: PORT_TYPES.audio, maxConnections: 1 },
  audios_list: { type: PORT_TYPES.audio, maxConnections: Infinity },
  audio_files: { type: PORT_TYPES.audio, maxConnections: Infinity },
};

const SOURCE_HANDLE_BY_PORT = {
  text: 'textOutput',
  image: 'imageOutput',
  video: 'videoOutput',
  audio: 'audioOutput',
  result: 'utilityOutput',
};

export function inferNodeKind(category, model) {
  if (category === 'api') return 'api';
  if (category === 'utility') return 'utility';
  if (typeof model === 'string' && model.endsWith('-passthrough')) return 'input';
  return 'generation';
}

export function nodeTypeForCategory(category, model) {
  if (category === 'text') return 'textNode';
  if (category === 'image') return 'imageNode';
  if (category === 'video') return 'videoNode';
  if (category === 'audio') return 'audioNode';
  if (category === 'api') return 'apiNode';
  if (model === 'prompt-concatenator') return 'concatNode';
  if (model === 'video-combiner') return 'vidConcatNode';
  return 'utilityNode';
}

export function categoryFromNodeType(nodeType) {
  if (nodeType === 'textNode') return 'text';
  if (nodeType === 'imageNode') return 'image';
  if (nodeType === 'videoNode') return 'video';
  if (nodeType === 'audioNode') return 'audio';
  if (nodeType === 'apiNode') return 'api';
  return 'utility';
}

export function sourcePortFromHandle(handle, sourceNode = null) {
  if (handle === 'utilityOutput' && sourceNode?.modelId) {
    const def = getUtilityNodeDefinition(sourceNode.modelId);
    const outputType = def?.output?.type;
    if (outputType === 'text') return { port: 'text', type: PORT_TYPES.text };
    if (outputType === 'image_url') return { port: 'image', type: PORT_TYPES.image };
    if (outputType === 'video_url') return { port: 'video', type: PORT_TYPES.video };
    if (outputType === 'audio_url') return { port: 'audio', type: PORT_TYPES.audio };
  }
  return SOURCE_HANDLE_TO_PORT[handle] || { port: 'result', type: PORT_TYPES.unknown };
}

export function targetPortFromHandle(handle) {
  return TARGET_HANDLE_TO_PORT[handle] || { port: handle || 'input', type: PORT_TYPES.unknown, maxConnections: 1 };
}

export function sourceHandleForPort(port, node = null) {
  if (node?.nodeType === 'concatNode') return 'concatOutput';
  if (node?.nodeType === 'apiNode') return 'apiOutput';
  if (node?.nodeType === 'utilityNode' || node?.nodeType === 'vidConcatNode') return 'utilityOutput';
  return SOURCE_HANDLE_BY_PORT[port] || 'utilityOutput';
}

export function targetHandleForPort(port, node = null) {
  if (node?.nodeType === 'concatNode' && port === 'prompt') return 'concatInput';
  if (node?.nodeType === 'vidConcatNode' && port === 'videos_list') return 'videoInput7';
  if (node?.nodeType === 'utilityNode') return port;
  if (node?.nodeType === 'apiNode' && port !== 'prompt') return port;
  return DEFAULT_TARGET_HANDLE_BY_PORT[port] || port;
}

function propertiesFromCatalog(catalog, category, model) {
  const entry = catalog?.categories?.[category]?.models?.[model];
  const inputSchema = entry?.input_schema;
  return inputSchema?.schemas?.input_data?.properties || inputSchema || {};
}

export function getInputPortDefinitions({ category, modelId, nodeType, catalog } = {}) {
  const compat = category === 'api' ? {} : COMPAT_INPUT_PORTS;
  if (category === 'utility' && modelId) {
    const schema = getUtilityNodeSchema(modelId);
    if (Object.keys(schema).length > 0) return schemaToPorts(schema);
  }
  const props = propertiesFromCatalog(catalog, category, modelId);
  if (Object.keys(props).length > 0) return { ...compat, ...schemaToPorts(props) };
  if (nodeType === 'concatNode') return { prompt: { type: PORT_TYPES.text, maxConnections: Infinity } };
  return { ...compat };
}

export function getOutputPortDefinitions({ category, modelId } = {}) {
  if (category === 'utility' && modelId) {
    const def = getUtilityNodeDefinition(modelId);
    const outputType = def?.output?.type;
    if (outputType === 'text') return { text: { type: PORT_TYPES.text, label: 'Text' } };
    if (outputType === 'image_url') return { image: { type: PORT_TYPES.image, label: 'Image' } };
    if (outputType === 'video_url') return { video: { type: PORT_TYPES.video, label: 'Video' } };
    if (outputType === 'audio_url') return { audio: { type: PORT_TYPES.audio, label: 'Audio' } };
  }
  return OUTPUT_BY_CATEGORY[category] || { result: { type: PORT_TYPES.unknown, label: 'Result' } };
}

export function schemaToPorts(properties = {}) {
  const ports = {};
  for (const [key, meta] of Object.entries(properties || {})) {
    if (meta?.connectable === false) continue;
    ports[key] = {
      type: inferPortType(key, meta),
      maxConnections: meta?.type === 'array' || /_list$|_files$|images|videos|audios/.test(key)
        ? Infinity
        : 1,
      required: meta?.required === true,
    };
  }
  return ports;
}

export function inferPortType(key, meta = {}) {
  const field = `${key} ${meta.field || ''} ${meta.mediaKind || ''}`;
  if (/image/i.test(field)) return PORT_TYPES.image;
  if (/video/i.test(field)) return PORT_TYPES.video;
  if (/audio/i.test(field)) return PORT_TYPES.audio;
  return PORT_TYPES.text;
}

export function portTypesCompatible(sourceType, targetType) {
  if (!sourceType || !targetType) return true;
  if (sourceType === PORT_TYPES.unknown || targetType === PORT_TYPES.unknown) return true;
  return sourceType === targetType;
}
