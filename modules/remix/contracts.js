export class RemixError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'RemixError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const REMIX_SCOPES = new Set(['whole', 'from-frame']);
export const MAX_SOURCE_BYTES = 250 * 1024 * 1024;
export const ALEPH_MIN_SECONDS = 2;
export const ALEPH_MAX_SECONDS = 30;

export function requireReplicateUser(user) {
  const provider = user?.preferredProvider || user?.provider || 'replicate';
  if (provider !== 'replicate') {
    throw new RemixError(
      'remix_provider_unsupported',
      'Remix Studio is currently available when Replicate is selected as your provider.',
      403,
    );
  }
  return provider;
}

export function numberInRange(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RemixError('remix_invalid_input', `${name} must be between ${min} and ${max}.`);
  }
  return number;
}

export function createRemixObjectKey({ userId, projectId, kind, filename = 'asset.bin' }) {
  const safeKind = String(kind).replace(/[^a-z0-9_-]/gi, '-');
  const safeName = String(filename).split(/[\\/]/).pop()
    .replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-').slice(0, 100) || 'asset.bin';
  return `remix/${userId}/${projectId}/${safeKind}/${randomUUID()}-${safeName}`;
}

export function planEditScope({ scope, durationSeconds, selectedTimeSeconds }) {
  if (!REMIX_SCOPES.has(scope)) {
    throw new RemixError('remix_invalid_scope', 'Scope must be "whole" or "from-frame".');
  }
  const duration = numberInRange(durationSeconds, 'Video duration', 0.001, Number.MAX_SAFE_INTEGER);
  const selected = numberInRange(selectedTimeSeconds, 'Selected timestamp', 0, duration);
  const segmentDuration = scope === 'whole' ? duration : duration - selected;
  if (segmentDuration < ALEPH_MIN_SECONDS || segmentDuration > ALEPH_MAX_SECONDS) {
    throw new RemixError(
      'remix_video_duration_unsupported',
      `The Aleph input segment must be ${ALEPH_MIN_SECONDS}–${ALEPH_MAX_SECONDS} seconds; this segment is ${segmentDuration.toFixed(2)} seconds.`,
    );
  }
  return {
    scope,
    segmentStartSeconds: scope === 'whole' ? 0 : selected,
    segmentDurationSeconds: segmentDuration,
    keyframePosition: scope === 'whole' ? String(selected) : 'first',
    rangeStartSeconds: scope === 'whole' ? 0 : selected,
    rangeEndSeconds: duration,
  };
}
import { randomUUID } from 'node:crypto';
