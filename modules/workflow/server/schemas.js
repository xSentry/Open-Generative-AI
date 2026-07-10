// Phase 2 — Schemas.
//
// Instead of fetching node schemas from MuAPI, we generate the exact
// MuAPI-compatible schema envelope locally from our own model catalog so the
// workflow builder renders node forms without MuAPI. The response shapes here
// are the contract the UI consumes (see docs/workflow-self-hosting-plan.md §8
// and the access paths in NodeFlow.jsx `buildWorkflowPayload`).
//
// Contract recap (node-schemas):
//   { categories: { <category>: { models: { <modelId>: { input_schema } } } } }
// where for media/utility(video-combiner) categories the fields live under
//   input_schema.schemas.input_data.properties
// and for `api` / utility `prompt-concatenator` `input_schema` is the plain
// properties map (matches how the UI reads `wavespeedSchema`/`concatSchema`).

import { STUDIO_MODEL_LISTS } from '../../studio/server/studioCatalog.js';
import { getSerializableReplicateModelLists } from '../../providers/replicate/server/catalog.js';
import { buildUtilityModelEntries } from './utilityNodes.js';

// ---------------------------------------------------------------------------
// Static catalogs mirrored from the workflow-builder client (utility.jsx) so we
// stay server-only (no importing client .jsx). Keep field shapes identical.
// ---------------------------------------------------------------------------

// API-provider node models. Only the keys present here are shown by the UI
// (NodeFlow.jsx filters `apiNodeModels` by `categories.api.models` keys).
const API_NODE_MODELS = {
  wavespeed: {
    name: 'Wavespeed API',
    properties: {
      model_url: { default: '', description: 'https://wavespeed.ai/models/wavespeed-ai/flux-schnell', type: 'string', format: 'text', required: true },
      api_key: { examples: '', description: 'API Key of the wavespeed ai.', type: 'string', format: 'text', required: true },
    },
  },
  straico: {
    name: 'Straico API',
    properties: {
      model_name: { enum: [], description: 'Name of the model (e.g. sd-xl)', type: 'string', default: '', required: true },
      model_type: { enum: ['chat', 'image', 'video', 'audio'], default: 'chat', description: 'Type of the model (e.g. chat, image, video, audio)', type: 'string', required: true },
      api_key: { examples: '', description: 'API Key for Straico.', type: 'string', format: 'text', required: true },
    },
  },
  runware: {
    name: 'Runware API',
    properties: {
      api_key: { description: 'Runware API Key', type: 'string', format: 'text', required: true },
      task_type: { enum: ['imageInference', 'textToVideo', 'imageToVideo', 'upscale', 'removeBackground'], description: 'Task type (e.g. imageInference, textToVideo, imageToVideo, upscale)', type: 'string', default: 'imageInference', required: true },
      model_name: { enum: [], description: 'AIR identifier of the model', type: 'string', default: '', required: false },
    },
  },
  genvr: {
    name: 'GenVR API',
    properties: {
      uid: { description: 'Your GenVR User ID', type: 'string', format: 'text', required: true },
      api_key: { description: 'GenVR API Key', type: 'string', format: 'text', required: true },
      category: { description: 'Model category (e.g. imagegen)', type: 'string', format: 'text', required: true },
      subcategory: { description: 'Model identifier (e.g. flux_dev)', type: 'string', format: 'text', required: true },
    },
  },
};

// Passthrough "input" nodes (no model) — the builder maps these to
// `${category}-passthrough`. Provide a single primary field per media type.
const PASSTHROUGH_PROPERTIES = {
  'text-passthrough': {
    prompt: { examples: [''], description: 'Text value passed to downstream nodes.', type: 'string', title: 'Text', name: 'prompt' },
  },
  'image-passthrough': {
    image_url: { examples: [], description: 'URL of the input image.', field: 'image', type: 'string', title: 'Image URL', name: 'image_url' },
  },
  'video-passthrough': {
    video_url: { examples: [], description: 'URL of the input video.', field: 'video', type: 'string', title: 'Video URL', name: 'video_url' },
  },
  'audio-passthrough': {
    audio_url: { examples: [], description: 'URL of the input audio.', field: 'audio', type: 'string', title: 'Audio URL', name: 'audio_url' },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModelLists(provider) {
  if (provider === 'replicate') return getSerializableReplicateModelLists();
  return STUDIO_MODEL_LISTS;
}

function dedupeById(models) {
  const seen = new Set();
  const out = [];
  for (const model of models) {
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

// The generic media input keys the workflow builder nodes recognise for showing
// connection handles (ImageNode/VideoNode/AudioNode all key off exactly these).
// See packages/.../{Image,Video,Audio}Node.jsx `has*` checks.
const GENERIC_MEDIA_KEYS = new Set([
  'prompt', 'image_url', 'images_list', 'video_url', 'videos_list', 'video_files',
  'last_image', 'audio_url', 'audios_list', 'audio_files', 'swap_url', 'swaps_list',
]);

// Map one raw model input to the generic key the builder expects, or null when
// it is not a media field. Replicate models name media inputs natively (e.g.
// "image_input") but carry a `field` hint ("images_list") plus `mediaKind` and
// model-level {image,video,audio,swap}Field metadata, which we use to translate.
function genericMediaKey(model, key, input) {
  const field = typeof input?.field === 'string' ? input.field : null;
  // The catalog's own `field` hint is authoritative when it is already generic.
  if (field && GENERIC_MEDIA_KEYS.has(field)) return field;

  const isArray = input?.type === 'array';
  let kind = input?.mediaKind || null;
  if (!kind && field) {
    if (/image/i.test(field)) kind = 'image';
    else if (/video/i.test(field)) kind = 'video';
    else if (/audio/i.test(field)) kind = 'audio';
  }
  if (!kind) {
    if (model?.imageField === key || model?.swapField === key) kind = 'image';
    else if (model?.videoField === key) kind = 'video';
    else if (model?.audioField === key) kind = 'audio';
  }

  if (kind === 'image') return isArray ? 'images_list' : 'image_url';
  if (kind === 'video') return isArray ? 'videos_list' : 'video_url';
  if (kind === 'audio') return isArray ? 'audios_list' : 'audio_url';
  return null;
}

// Re-key a model's inputs so media fields use the generic names the builder and
// the Replicate runner's buildInput() both rely on. Non-media fields and inputs
// that are already generically named pass through unchanged. Without this, an
// image-capable model such as nano-banana-2 (input key "image_input") would only
// expose a text/prompt handle, so images could not be funnelled into it.
export function normalizeMediaProperties(model) {
  const inputs = model?.inputs || {};
  const out = {};
  const used = new Set();
  for (const [key, input] of Object.entries(inputs)) {
    if (GENERIC_MEDIA_KEYS.has(key)) {
      out[key] = input;
      used.add(key);
      continue;
    }
    const generic = genericMediaKey(model, key, input);
    // Only remap when the target generic key isn't already provided by the model
    // and hasn't been claimed by an earlier input, to avoid clobbering.
    if (generic && !used.has(generic) && !(generic in inputs)) {
      out[generic] = input;
      used.add(generic);
    } else {
      out[key] = input;
    }
  }
  return out;
}

// Media models expose their fields under input_schema.schemas.input_data.properties
function mediaModelEntry(model) {
  return {
    name: model.name,
    endpoint: model.endpoint || model.id,
    input_schema: { schemas: { input_data: { properties: normalizeMediaProperties(model) } } },
  };
}

function buildMediaCategory(models, passthroughId) {
  const entries = {};
  for (const model of dedupeById(models)) {
    entries[model.id] = mediaModelEntry(model);
  }
  entries[passthroughId] = {
    name: passthroughId,
    input_schema: { schemas: { input_data: { properties: PASSTHROUGH_PROPERTIES[passthroughId] || {} } } },
  };
  return { models: entries };
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

// GET /api/workflow/{id}/node-schemas — the global model/schema catalog. The
// workflow id is ignored (schemas are provider-scoped, not workflow-scoped).
export function buildNodeSchemas(provider) {
  const lists = getModelLists(provider);

  const image = [...(lists.t2i || []), ...(lists.i2i || [])];
  const video = [...(lists.t2v || []), ...(lists.i2v || []), ...(lists.v2v || [])];
  const audio = [...(lists.audio || []), ...(lists.lipsync || [])];
  const text = [...(lists.t2t || [])];

  const apiModels = {};
  for (const [id, model] of Object.entries(API_NODE_MODELS)) {
    apiModels[id] = { name: model.name, input_schema: model.properties };
  }

  return {
    categories: {
      text: {
        models: {
          ...Object.fromEntries(dedupeById(text).map((model) => [model.id, mediaModelEntry(model)])),
          'text-passthrough': {
            name: 'text-passthrough',
            input_schema: { schemas: { input_data: { properties: PASSTHROUGH_PROPERTIES['text-passthrough'] } } },
          },
        },
      },
      image: buildMediaCategory(image, 'image-passthrough'),
      video: buildMediaCategory(video, 'video-passthrough'),
      audio: buildMediaCategory(audio, 'audio-passthrough'),
      api: { models: apiModels },
      utility: {
        models: buildUtilityModelEntries(),
      },
    },
  };
}

// GET /api/workflow/{id}/api-node-schemas — per-apiNode schema envelope. Without
// a live provider lookup we return the node's own model properties (empty
// input_schema so the UI falls back to the model's hard-coded input_params).
export function buildApiNodeSchemas(workflow) {
  const api_node_schemas = {};
  const nodes = workflow?.nodes || [];
  for (const node of nodes) {
    if (node.category === 'api' || node.type === 'apiNode') {
      api_node_schemas[node.id] = { schema: { input_schema: {}, dynamic_schemas: {} } };
    }
  }
  return { api_node_schemas };
}

// GET /api/workflow/{id}/api-inputs — workflow-level exposed inputs used by the
// playground. Collects nodes flagged with `make_input`.
export function buildApiInputs(workflow) {
  const properties = {};
  const nodes = workflow?.nodes || [];
  for (const node of nodes) {
    const inputParams = node.input_params || {};
    if (inputParams.make_input === true) {
      const value =
        inputParams.prompt ??
        inputParams.image_url ??
        inputParams.video_url ??
        inputParams.audio_url ??
        '';
      properties[node.id] = {
        default: value,
        examples: [],
        type: 'string',
      };
    }
  }
  return { input_data: { properties } };
}

