// Registry for local/programmatic workflow utility nodes.
//
// Add new custom utilities here (or import them into this file) with:
//   id, name, inputSchema, output, execute(params)
//
// The workflow builder consumes the metadata in `workflow` to render generic
// handles. The execution engine calls `executeUtilityNode` for local logic.
import { extractVideoFrame } from './videoFrameExtractor.js';
import { combineVideos } from './videoCombiner.js';

function newId() {
  return (globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function textResult(value) {
  return { id: newId(), outputs: [{ type: 'text', value: value ?? '', id: newId() }] };
}

export const UTILITY_NODE_DEFINITIONS = {
  'prompt-concatenator': {
    id: 'prompt-concatenator',
    name: 'Prompt Concatenator',
    nodeType: 'concatNode',
    inputSchema: {
      prompt: {
        examples: [''],
        description: 'Text prompt fragments to concatenate.',
        type: 'string',
        title: 'Prompt',
        name: 'prompt',
      },
    },
    output: { type: 'text', label: 'Text' },
    execute: async ({ params }) => {
      const parts = [];
      if (Array.isArray(params.prompt)) parts.push(...params.prompt);
      else if (params.prompt != null && params.prompt !== '') parts.push(params.prompt);
      return textResult(parts.filter((p) => p != null && p !== '').join(' '));
    },
  },

  'video-combiner': {
    id: 'video-combiner',
    name: 'Video Combiner',
    nodeType: 'vidConcatNode',
    inputSchema: {
      videos_list: {
        examples: ['https://d3adwkbyhxyrtq.cloudfront.net/webassets/videomodels/seedance-v2.0-i2v.mp4'],
        description: 'Upload the video clips you want to combine, in order. Each clip can be 5-60 seconds.',
        field: 'videos_list',
        type: 'array',
        items: { type: 'string' },
        title: 'Video Clips',
        name: 'videos_list',
        maxItems: 20,
      },
      aspect_ratio: {
        enum: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'],
        title: 'Aspect Ratio',
        name: 'aspect_ratio',
        type: 'string',
        default: 'auto',
        description: "Output aspect ratio. 'auto' uses the aspect ratio of the first uploaded clip.",
      },
    },
    output: { type: 'video_url', label: 'Video' },
    execute: async ({ params }) => {
      const video = await combineVideos(params);
      return {
        id: newId(),
        outputs: [{ type: 'video_url', value: video, id: newId() }],
      };
    },
  },

  'video-frame-extractor': {
    id: 'video-frame-extractor',
    name: 'Video Frame Extractor',
    nodeType: 'utilityNode',
    inputSchema: {
      video_url: {
        examples: [],
        description: 'Video to extract a frame from.',
        field: 'video',
        type: 'string',
        title: 'Video',
        name: 'video_url',
        required: true,
      },
      frame_mode: {
        enum: ['First Frame', 'Last Frame', 'Custom Frame'],
        title: 'Frame',
        name: 'frame_mode',
        type: 'string',
        default: 'First Frame',
        description: 'Which frame to extract from the video.',
        connectable: false,
      },
      timestamp: {
        title: 'Timestamp',
        name: 'timestamp',
        type: 'string',
        format: 'text',
        default: '0',
        description: 'Required for Custom Frame. Use seconds or HH:MM:SS.',
        placeholder: '0 or 00:00:01.500',
        visibleWhen: { field: 'frame_mode', equals: 'Custom Frame' },
        connectable: false,
      },
    },
    output: { type: 'image_url', label: 'Image' },
    execute: async ({ params }) => {
      const frame = await extractVideoFrame(params);
      return {
        id: newId(),
        outputs: [{ type: 'image_url', value: frame, id: newId() }],
      };
    },
  },
};

function workflowMeta(def) {
  return {
    node_type: def.nodeType || 'utilityNode',
    output_type: def.output?.type || 'text',
    output_label: def.output?.label || 'Output',
  };
}

export function buildUtilityModelEntries() {
  const entries = {};
  for (const [id, def] of Object.entries(UTILITY_NODE_DEFINITIONS)) {
    const input_schema = def.nodeType === 'concatNode'
      ? def.inputSchema
      : { schemas: { input_data: { properties: def.inputSchema } } };
    entries[id] = {
      name: def.name,
      input_schema,
      workflow: workflowMeta(def),
    };
  }
  return entries;
}

export function getUtilityNodeDefinition(model) {
  return UTILITY_NODE_DEFINITIONS[model] || null;
}

export function getUtilityNodeSchema(model) {
  return getUtilityNodeDefinition(model)?.inputSchema || {};
}

export function canExecuteUtilityNode(model) {
  return typeof getUtilityNodeDefinition(model)?.execute === 'function';
}

export async function executeUtilityNode({ model, params }) {
  const def = getUtilityNodeDefinition(model);
  if (!def) return null;
  if (typeof def.execute !== 'function') {
    throw new Error(`Node type not supported by the local engine yet (category="utility", model="${model}").`);
  }
  return def.execute({ params });
}
