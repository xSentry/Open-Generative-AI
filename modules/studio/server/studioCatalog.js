import {
  audioModels,
  i2iModels,
  i2vModels,
  lipsyncModels,
  recastModels,
  t2iModels,
  t2vModels,
  v2vModels,
} from '../../../packages/studio/src/models.js';

const CINEMA_REQUIRED_INPUTS = ['prompt', 'aspect_ratio'];

function supportsCinema(model) {
  const inputs = model?.inputs || {};
  return CINEMA_REQUIRED_INPUTS.every((key) => Boolean(inputs[key]));
}

// Image models (t2i/i2i) that can back Cinema Studio, de-duplicated by id.
function buildCinemaModels() {
  const seen = new Set();
  const list = [];
  for (const model of [...t2iModels, ...i2iModels]) {
    if (!model || seen.has(model.id) || !supportsCinema(model)) continue;
    seen.add(model.id);
    list.push(model);
  }
  return list;
}

// Marketing Studio: video models with a prompt + multiple reference images
// (product/avatar/refs → video ad). MuAPI advertises multi-image via maxImages;
// Replicate uses array-typed inputs (handled in its own catalog).
function supportsMarketing(model) {
  const inputs = model?.inputs || {};
  const hasPrompt = Boolean(inputs.prompt) || Boolean(model?.hasPrompt);
  if (!hasPrompt) return false;
  if (Number(model?.maxImages) > 1) return true;
  // Scan every input for an array-typed image list (not just imageField).
  for (const input of Object.values(inputs)) {
    if (input && input.type === 'array' && (input.mediaKind === 'image' || input.field === 'images_list')) {
      return true;
    }
  }
  return false;
}

function buildMarketingModels() {
  const seen = new Set();
  const list = [];
  for (const model of [...t2vModels, ...i2vModels, ...v2vModels]) {
    if (!model || seen.has(model.id) || !supportsMarketing(model)) continue;
    seen.add(model.id);
    list.push(model);
  }
  return list;
}

export const STUDIO_MODEL_LISTS = {
  t2i: t2iModels,
  i2i: i2iModels,
  t2v: t2vModels,
  i2v: i2vModels,
  v2v: v2vModels,
  lipsync: lipsyncModels,
  recast: recastModels,
  audio: audioModels,
  // Derived "cinema" mode: image models (t2i/i2i) exposing prompt + aspect_ratio,
  // mirroring the Replicate catalog's derived cinema list. Lets Cinema Studio run
  // through the persisted /api/studio/generate path with its own history scope.
  cinema: buildCinemaModels(),
  // Derived "marketing" mode: video models with prompt + multiple reference
  // images (product/avatar/refs → video ad).
  marketing: buildMarketingModels(),
};

export const STUDIO_ENDPOINT_MODES = new Set([
  't2i',
  'i2i',
  't2v',
  'i2v',
  'v2v',
  'lipsync',
  'recast',
  'audio',
  'cinema',
  'marketing',
]);

export function getStudioModelLists() {
  return STUDIO_MODEL_LISTS;
}

export function getStudioModel(mode, id) {
  return STUDIO_MODEL_LISTS[mode]?.find((model) => model.id === id) || null;
}

export function findStudioModelByEndpoint(endpoint) {
  for (const [mode, models] of Object.entries(STUDIO_MODEL_LISTS)) {
    const match = models.find((model) => (model.endpoint || model.id) === endpoint || model.id === endpoint);
    if (match) {
      return { mode, model: match };
    }
  }

  return null;
}

export function normalizeStudioModel(mode, model) {
  const inputs = model.inputs || {};
  const requiredInputNames = new Set(model.required || []);
  const inputEntries = Object.entries(inputs);
  const inferredRequiredInputs = [];
  const inferredOptionalInputs = [];
  const inferredInputTypes = {};

  if ((mode === 'i2i' || mode === 'i2v' || mode === 'v2v' || mode === 'recast') && model.imageField && !inputs[model.imageField]) {
    inferredRequiredInputs.push(model.imageField);
    inferredInputTypes[model.imageField] = 'string';
  }

  if ((mode === 'i2i' || mode === 'i2v') && model.swapField && !inputs[model.swapField]) {
    inferredRequiredInputs.push(model.swapField);
    inferredInputTypes[model.swapField] = 'string';
  }

  if ((mode === 'v2v' || mode === 'lipsync' || mode === 'recast') && model.videoField && !inputs[model.videoField]) {
    inferredRequiredInputs.push(model.videoField);
    inferredInputTypes[model.videoField] = 'string';
  }

  if (mode === 'lipsync' && !inputs.audio_url) {
    inferredRequiredInputs.push('audio_url');
    inferredInputTypes.audio_url = 'string';
  }

  if (mode === 'lipsync' && model.category === 'video' && !model.videoField && !inputs.video_url) {
    inferredRequiredInputs.push('video_url');
    inferredInputTypes.video_url = 'string';
  }

  if (mode === 'lipsync' && model.category === 'image' && !model.imageField && !inputs.image_url) {
    inferredRequiredInputs.push('image_url');
    inferredInputTypes.image_url = 'string';
  }

  if (model.hasPrompt && !inputs.prompt) {
    if (model.promptRequired) inferredRequiredInputs.push('prompt');
    else inferredOptionalInputs.push('prompt');
    inferredInputTypes.prompt = 'string';
  }

  return {
    studioId: model.id,
    studioName: model.name,
    mode,
    muapiEndpoint: model.endpoint || model.id,
    requiredInputs: [
      ...inferredRequiredInputs,
      ...inputEntries
      .filter(([name, input]) => input?.required === true || requiredInputNames.has(name))
      .map(([name]) => name),
    ],
    optionalInputs: inputEntries
      .filter(([name, input]) => input?.required !== true && !requiredInputNames.has(name))
      .map(([name]) => name)
      .concat(inferredOptionalInputs),
    inputTypes: {
      ...inferredInputTypes,
      ...Object.fromEntries(inputEntries.map(([name, input]) => [name, input?.type || 'string'])),
    },
    capabilityHints: {
      image: Boolean(inputs.image_url || inputs.images_list || model.imageField),
      audio: Boolean(inputs.audio_url),
      video: Boolean(inputs.video_url || model.videoField),
      duration: Boolean(inputs.duration),
      aspectRatio: Boolean(inputs.aspect_ratio),
    },
  };
}

export function listNormalizedStudioModels(modeFilter) {
  const entries = Object.entries(STUDIO_MODEL_LISTS)
    .filter(([mode]) => !modeFilter || mode === modeFilter)
    .flatMap(([mode, models]) => models.map((model) => normalizeStudioModel(mode, model)));

  return entries;
}

export function getSerializableStudioModelLists() {
  return Object.fromEntries(
    Object.entries(STUDIO_MODEL_LISTS).map(([mode, models]) => [mode, models.map((model) => ({ ...model }))])
  );
}
