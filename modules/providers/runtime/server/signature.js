import { createHash } from 'node:crypto';

export const DEFAULT_RUNTIME_SIGNATURE_VERSION = 1;

const CONCEPT = /(?:^|[_\s-])(width|height|resolution|target_resolution|image_size|output_size|size|aspect_ratio|duration|seconds|length|num_frames|max_frames|frames|fps|frame_rate|steps|inference_steps|num_inference_steps|denoising_steps|quality|speed|mode|tier|preset|performance|num_outputs|output_count|batch_size|num_images|samples)(?:$|[_\s-])/i;
const USER_CONTENT = /^(?:prompt|instruction|caption|description|negative_prompt|text|query|content|message|script)(?:_|$)/i;
const FILE_IDENTIFIER = /^(?:url|uri|file|asset)(?:_|$)|(?:_url|_uri|_file|_id)$/i;
export const HIGH_IMPACT_FIELD_PATTERN = 'width|height|resolution|size|aspect_ratio|duration|seconds|length|frames|fps|steps|quality|speed|mode|tier|preset|performance';
const HIGH_IMPACT = new RegExp(HIGH_IMPACT_FIELD_PATTERN, 'i');

function bucket(value, step) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number / step) * step : value;
}

function normalizeValue(key, value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return normalizeValue(key, Number(trimmed));
    return trimmed.toLowerCase();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (/duration|seconds|length/i.test(key)) return bucket(value, 1);
    if (/width|height|resolution|size/i.test(key)) return bucket(value, 64);
    if (/fps|frame_rate/i.test(key)) return bucket(value, 1);
    if (/frames|steps/i.test(key)) return bucket(value, 1);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(key, item)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') return canonicalize(value);
  if (typeof value === 'boolean') return value;
  return undefined;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    const normalized = normalizeValue(key, value[key]);
    return normalized === undefined ? [] : [[key, normalized]];
  }));
}

function isRuntimeField(key, schema, overrides) {
  // Overrides replace generic discovery, but can never opt user content or raw
  // media identifiers into telemetry. Seed is intentionally allowed only via
  // an explicit override.
  if (USER_CONTENT.test(key) || FILE_IDENTIFIER.test(key) || schema?.format === 'uri' || schema?.mediaKind) {
    return false;
  }
  if (Array.isArray(overrides)) return overrides.includes(key);
  if (key === 'seed') return false;
  const words = `${key} ${schema?.title || ''} ${schema?.description || ''}`;
  return CONCEPT.test(words);
}

function mediaSignature(media = {}) {
  const output = {};
  for (const [name, metadata] of Object.entries(media)) {
    if (!metadata || typeof metadata !== 'object') continue;
    const type = metadata.type || name;
    if (/image/i.test(type)) output[name] = canonicalize({ width: metadata.width, height: metadata.height, pixels: bucket((Number(metadata.width) || 0) * (Number(metadata.height) || 0), 250000) });
    else if (/video/i.test(type)) output[name] = canonicalize({ duration: metadata.duration, width: metadata.width, height: metadata.height, fps: metadata.fps, frames: bucket((Number(metadata.duration) || 0) * (Number(metadata.fps) || 0), 30) });
    else if (/audio/i.test(type)) output[name] = canonicalize({ duration: metadata.duration, sampleRate: bucket(metadata.sampleRate, 1000) });
  }
  return output;
}

export function createRuntimeSignature({ model, params = {}, mediaMetadata } = {}) {
  const fields = {};
  for (const [key, schema] of Object.entries(model?.inputs || {})) {
    if (params[key] !== undefined && isRuntimeField(key, schema, model?.runtimeFields)) fields[key] = params[key];
  }
  const signature = canonicalize({ fields, media: mediaSignature(mediaMetadata || params.runtimeMediaMetadata) });
  const canonicalJson = JSON.stringify(signature);
  return {
    version: Number(model?.runtimeSignatureVersion) || DEFAULT_RUNTIME_SIGNATURE_VERSION,
    signature,
    canonicalJson,
    signatureHash: createHash('sha256').update(canonicalJson).digest('hex'),
  };
}

export function createRelaxedRuntimeSignature(signature) {
  const fields = Object.fromEntries(Object.entries(signature?.fields || {}).filter(([key]) => HIGH_IMPACT.test(key)));
  const relaxed = canonicalize({ fields, media: signature?.media || {} });
  return { signature: relaxed, signatureHash: createHash('sha256').update(JSON.stringify(relaxed)).digest('hex') };
}
