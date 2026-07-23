import { requireProviderOperation } from '../../providers/server/registry.js';
import { RemixError } from '../contracts.js';

export const REMIX_VIDEO_MODELS = Object.freeze([
  Object.freeze({
    key: 'aleph-2',
    label: 'Aleph 2.0',
    provider: 'replicate',
    catalogModelId: 'aleph-2',
    mode: 'v2v',
    role: 'video-edit',
    inputMap: Object.freeze({
      prompt: 'prompt',
      video: 'video',
      keyframes: 'keyframe_images',
      positions: 'keyframe_positions',
    }),
  }),
]);

export async function resolveRemixVideoModel(key) {
  const entry = REMIX_VIDEO_MODELS.find((candidate) => candidate.key === key);
  if (!entry) {
    throw new RemixError('remix_video_model_unavailable', 'That Remix video model is not available.', 409);
  }
  const adapter = requireProviderOperation(entry.provider, 'studio');
  let model;
  try {
    model = await adapter.catalog.getModel(entry.mode, entry.catalogModelId);
  } catch {
    model = null;
  }
  const inputs = model?.inputs || {};
  const valid = model?.outputKind === 'video'
    && inputs[entry.inputMap.prompt]?.type === 'string'
    && inputs[entry.inputMap.video]?.mediaKind === 'video'
    && inputs[entry.inputMap.keyframes]?.mediaKind === 'image'
    && inputs[entry.inputMap.positions]?.type === 'array';
  if (!valid) {
    throw new RemixError(
      'remix_video_model_unavailable',
      `${entry.label} is temporarily unavailable because its provider contract changed.`,
      409,
    );
  }
  const optionalInputs = Object.fromEntries(
    Object.entries(inputs).filter(([name]) =>
      !Object.values(entry.inputMap).includes(name) && !model.required?.includes(name),
    ),
  );
  return { ...entry, model, optionalInputs };
}

export async function listRemixVideoModels() {
  const resolved = await Promise.all(REMIX_VIDEO_MODELS.map(async (entry) => {
    try {
      const item = await resolveRemixVideoModel(entry.key);
      return {
        key: item.key, label: item.label, provider: item.provider, mode: item.mode,
        model: item.catalogModelId, inputs: item.optionalInputs,
      };
    } catch {
      return null;
    }
  }));
  return resolved.filter(Boolean);
}
