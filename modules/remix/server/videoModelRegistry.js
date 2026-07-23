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
    segment: Object.freeze({ minSeconds: 2, maxSeconds: 30 }),
  }),
  Object.freeze({
    key: 'kling-v3-omni-video',
    label: 'Kling 3.0 Omni',
    provider: 'replicate',
    catalogModelId: 'kling-v3-omni-video',
    mode: 'v2v',
    role: 'video-edit',
    inputMap: Object.freeze({
      prompt: 'prompt',
      video: 'reference_video',
      keyframes: 'reference_images',
    }),
    fixedInputs: Object.freeze({
      video_reference_type: 'base',
      generate_audio: false,
    }),
    optionalInputNames: Object.freeze(['keep_original_sound', 'mode']),
    inputOverrides: Object.freeze({
      mode: Object.freeze({ enum: Object.freeze(['standard', 'pro']) }),
    }),
    promptReferenceToken: '<<<image_1>>>',
    segment: Object.freeze({ minSeconds: 3, maxSeconds: 10 }),
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
  const positionField = entry.inputMap.positions;
  const valid = model?.outputKind === 'video'
    && inputs[entry.inputMap.prompt]?.type === 'string'
    && inputs[entry.inputMap.video]?.mediaKind === 'video'
    && inputs[entry.inputMap.keyframes]?.mediaKind === 'image'
    && (!positionField || inputs[positionField]?.type === 'array');
  if (!valid) {
    throw new RemixError(
      'remix_video_model_unavailable',
      `${entry.label} is temporarily unavailable because its provider contract changed.`,
      409,
    );
  }
  const optionalInputs = Object.fromEntries(
    Object.entries(inputs)
      .filter(([name]) =>
        !Object.values(entry.inputMap).includes(name)
        && !Object.hasOwn(entry.fixedInputs || {}, name)
        && !model.required?.includes(name)
        && (!entry.optionalInputNames || entry.optionalInputNames.includes(name)),
      )
      .map(([name, schema]) => [
        name,
        entry.inputOverrides?.[name] ? { ...schema, ...entry.inputOverrides[name] } : schema,
      ]),
  );
  return { ...entry, model, optionalInputs };
}

export function buildRemixVideoParams({
  resolved,
  prompt,
  videoUrl,
  keyframeUrl,
  keyframePosition,
  params = {},
}) {
  const map = resolved.inputMap;
  const safeParams = Object.fromEntries(
    Object.entries(params).filter(([name, value]) => {
      const schema = resolved.optionalInputs?.[name];
      return schema && (!schema.enum || schema.enum.includes(value));
    }),
  );
  let mappedPrompt = String(prompt || '').trim();
  if (resolved.promptReferenceToken && !mappedPrompt.includes(resolved.promptReferenceToken)) {
    mappedPrompt = `${mappedPrompt} Use ${resolved.promptReferenceToken} as the visual reference for the edit.`.trim();
  }
  return {
    ...safeParams,
    ...(resolved.fixedInputs || {}),
    [map.prompt]: mappedPrompt,
    [map.video]: videoUrl,
    [map.keyframes]: [keyframeUrl],
    ...(map.positions ? { [map.positions]: [keyframePosition] } : {}),
  };
}

export async function listRemixVideoModels() {
  const resolved = await Promise.all(REMIX_VIDEO_MODELS.map(async (entry) => {
    try {
      const item = await resolveRemixVideoModel(entry.key);
      return {
        key: item.key, label: item.label, provider: item.provider, mode: item.mode,
        model: item.catalogModelId, inputs: item.optionalInputs, segment: item.segment,
      };
    } catch {
      return null;
    }
  }));
  return resolved.filter(Boolean);
}
