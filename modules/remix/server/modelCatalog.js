import { requireProviderOperation } from '../../providers/server/registry.js';
import { RemixError } from '../contracts.js';

function isImageField([name, schema]) {
  return schema?.mediaKind === 'image'
    || schema?.field === 'image'
    || schema?.field === 'images_list';
}

export function imageInputFields(model) {
  return Object.entries(model?.inputs || {})
    .filter(isImageField)
    .map(([name, schema]) => ({
      name,
      multiple: schema.type === 'array',
      maxImages: schema.type === 'array' ? Math.max(1, Number(schema.maxItems || 5)) : 1,
      required: (model.required || []).includes(name),
      schema,
    }));
}

function promptFieldFor(model) {
  if (model.inputs?.prompt?.type === 'string') return 'prompt';
  if (model.inputs?.instruction?.type === 'string') return 'instruction';
  return Object.entries(model.inputs || {}).find(([name, schema]) =>
    schema?.type === 'string' && /prompt|instruction/i.test(`${name} ${schema?.title || ''}`),
  )?.[0] || null;
}

function mediaMapping(model) {
  const fields = imageInputFields(model);
  const field = fields.some((candidate) => candidate.name === model.imageField)
    ? model.imageField
    : fields[0]?.name;
  if (!field) return null;
  const schema = model.inputs[field] || {};
  return {
    field,
    multiple: schema.type === 'array',
    maxImages: schema.type === 'array' ? Number(schema.maxItems || 5) : 1,
  };
}

function publicModel(model, mode) {
  const mapping = mediaMapping(model);
  const promptField = promptFieldFor(model);
  if (!mapping || !promptField || model.outputKind !== 'image') return null;
  return {
    ...model,
    mode,
    provider: 'replicate',
    acceptsInputImages: true,
    promptField,
    mediaField: mapping.field,
    maxImages: mapping.maxImages,
    mediaMapping: mapping,
  };
}

export async function getEligibleImageModels(provider = 'replicate') {
  if (provider !== 'replicate') return [];
  const adapter = requireProviderOperation(provider, 'studio');
  const lists = await adapter.catalog.getModelLists();
  const candidates = [
    ...(lists.i2i || []).map((model) => publicModel(model, 'i2i')),
    ...(lists.t2i || []).map((model) => publicModel(model, 't2i')),
  ].filter(Boolean);
  const seen = new Set();
  return candidates.filter((model) => {
    const identity = model.replicate?.ref || model.metadata?.nativeId || model.id;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export async function requireEligibleImageModel({ provider, mode, modelId }) {
  const models = await getEligibleImageModels(provider);
  const model = models.find((candidate) => candidate.id === modelId && candidate.mode === mode)
    || models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new RemixError('remix_image_model_unavailable', 'That image-editing model is no longer available.', 409);
  }
  return model;
}

export function buildImageEditParams({ model, prompt, imageInputs, imageUrls, params = {} }) {
  if (!String(prompt || '').trim()) {
    throw new RemixError('remix_prompt_required', 'Enter a frame edit prompt.');
  }
  const fields = imageInputFields(model);
  const assigned = imageInputs || (
    Array.isArray(imageUrls)
      ? { [model.mediaField]: imageUrls }
      : {}
  );
  const result = { ...params, [model.promptField]: prompt.trim() };
  for (const field of fields) delete result[field.name];

  let totalImages = 0;
  for (const field of fields) {
    const urls = Array.isArray(assigned[field.name]) ? assigned[field.name].filter(Boolean) : [];
    if (urls.length > field.maxImages) {
      throw new RemixError(
        'remix_image_capacity_exceeded',
        `${field.schema.title || field.name} accepts at most ${field.maxImages} image${field.maxImages === 1 ? '' : 's'}.`,
      );
    }
    if (field.required && urls.length === 0) {
      throw new RemixError('remix_image_input_required', `${field.schema.title || field.name} requires an image.`);
    }
    if (urls.length > 0) result[field.name] = field.multiple ? urls : urls[0];
    totalImages += urls.length;
  }
  if (totalImages === 0) {
    throw new RemixError('remix_image_input_required', 'Assign the selected frame to an image input.');
  }
  return result;
}
