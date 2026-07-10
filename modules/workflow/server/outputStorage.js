// Persist workflow node media outputs into our own S3 bucket and keep URLs
// fresh. Node executors return provider URLs (e.g. replicate.delivery links);
// we download each media output and re-upload it under a workflow-scoped key so
// the asset lives in our bucket, is bound to the workflow/run/node-run, and can
// be cleaned up on delete. Text outputs pass through untouched.
//
// Dependencies (fetch/S3) are injected so this stays unit-testable without the
// network or real S3.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contentTypeForExt, inferExtension } from '../../studio/server/generationMedia.js';

const MEDIA_TYPES = new Set(['image_url', 'video_url', 'audio_url']);

function mediaTypeForOutputType(type) {
  if (type === 'image_url') return 'image';
  if (type === 'video_url') return 'video';
  if (type === 'audio_url') return 'audio';
  return null;
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

function isFileUrl(value) {
  return typeof value === 'string' && /^file:\/\//.test(value);
}

function extFromPath(value) {
  const match = String(value || '').split(/[?#]/)[0].match(/\.([a-zA-Z0-9]{1,12})$/);
  return match ? match[1].toLowerCase() : null;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  return null;
}

function normalizeFilePath(value) {
  if (isFileUrl(value)) return fileURLToPath(value);
  return value;
}

function contentTypeFromName(value) {
  const ext = extFromPath(value);
  return ext ? contentTypeForExt(ext) : null;
}

async function readLocalMedia(value, output) {
  const filePath = normalizeFilePath(value);
  const body = await readFile(filePath);
  const ext = extFromPath(filePath);
  return {
    body,
    sourceUrl: pathToFileURL(filePath).toString(),
    contentType: output.contentType || output.mimeType || (ext ? contentTypeForExt(ext) : null),
  };
}

async function resolveMediaPayload(output, deps) {
  const value = output?.value;

  if (isHttpUrl(value)) {
    const response = await deps.fetchFn(value);
    if (!response.ok) throw new Error(`Failed to download output (${response.status}).`);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      sourceUrl: value,
      contentType: response.headers.get('content-type') || output.contentType || output.mimeType || null,
    };
  }

  if (typeof value === 'string' && value) {
    return readLocalMedia(value, output);
  }

  const directBuffer = toBuffer(value);
  if (directBuffer) {
    const name = output.filename || output.name || null;
    return {
      body: directBuffer,
      sourceUrl: name,
      contentType: output.contentType || output.mimeType || contentTypeFromName(name),
    };
  }

  if (value && typeof value === 'object') {
    if (value.path || value.filePath) {
      return readLocalMedia(value.path || value.filePath, { ...output, ...value });
    }
    const nestedBuffer = toBuffer(value.buffer ?? value.body ?? value.data);
    if (nestedBuffer) {
      const name = value.filename || value.name || output.filename || output.name || null;
      return {
        body: nestedBuffer,
        sourceUrl: name,
        contentType: value.contentType || value.mimeType || output.contentType || output.mimeType || contentTypeFromName(name),
      };
    }
  }

  return null;
}

// Store a single result's media outputs. Returns { result, keys } where result
// carries the S3 key alongside each media output and `keys` lists every stored
// object key (for later cleanup).
export async function storeNodeOutputs({
  result,
  userId,
  workflowId,
  runId,
  nodeRunId,
  config,
  deps,
}) {
  const outputs = Array.isArray(result?.outputs) ? result.outputs : [];
  const storedOutputs = [];
  const keys = [];
  let index = 0;

  for (const output of outputs) {
    if (!MEDIA_TYPES.has(output?.type)) {
      storedOutputs.push(output);
      continue;
    }

    try {
      const payload = await resolveMediaPayload(output, deps);
      if (!payload) {
        storedOutputs.push(output);
        continue;
      }
      const ext = inferExtension({
        url: payload.sourceUrl,
        contentType: payload.contentType,
        mediaType: mediaTypeForOutputType(output.type),
      });
      const key = deps.createWorkflowOutputObjectKey({
        userId,
        workflowId,
        runId,
        nodeRunId,
        index,
        ext,
      });
      const contentType = payload.contentType || contentTypeForExt(ext);
      const url = await deps.uploadObject({ config, key, body: payload.body, contentType });
      keys.push(key);
      storedOutputs.push({ ...output, value: url, key });
      index += 1;
    } catch (error) {
      // If mirroring fails, keep the provider URL so the user still sees a
      // result; it just won't be persisted in our bucket.
      storedOutputs.push(output);
      // eslint-disable-next-line no-console
      console.error('[workflow] failed to store node output:', error?.message || error);
    }
  }

  return { result: { ...result, outputs: storedOutputs }, keys };
}

// Re-sign stored media URLs from their persisted S3 key so the status/outputs
// endpoints always return a fresh, non-expired presigned URL. Outputs without a
// key (text, or provider fallbacks) are returned unchanged.
//
// The signing timestamp is floored to a fixed window (default 1h) so repeated
// signs of the SAME key produce a byte-identical URL string within that window.
// Without this, every stream tick / status read minted a brand-new signature,
// which changed the <img src> and made the browser reload the image (and re-run
// its metadata fetch) over and over. A stable URL lets React skip the reload
// while the long TTL keeps the link valid.
const SIGN_WINDOW_MS = 60 * 60 * 1000;

function stableSignDate(windowMs = SIGN_WINDOW_MS) {
  return new Date(Math.floor(Date.now() / windowMs) * windowMs);
}

export function signResultOutputs(result, { config, createPresignedGetUrl, date } = {}) {
  if (!result?.outputs || !config || !createPresignedGetUrl) return result;
  const signDate = date || stableSignDate();
  const outputs = result.outputs.map((output) => {
    if (output?.key) {
      try {
        return { ...output, value: createPresignedGetUrl({ config, key: output.key, date: signDate }) };
      } catch {
        return output;
      }
    }
    return output;
  });
  return { ...result, outputs };
}

// Collect every S3 object key referenced by a node result (for cleanup paths
// that only have the result JSON, not the output_keys column).
export function collectResultKeys(result) {
  const keys = [];
  for (const output of result?.outputs || []) {
    if (output?.key) keys.push(output.key);
  }
  return keys;
}

// Re-sign the persisted `output_params` of a saved workflow node so that when a
// workflow is reopened its media points at a fresh presigned S3 URL derived from
// the stored key — instead of the stale/expired URL (or legacy provider "proxy"
// URL) that was serialized at save time. `sign` is the result signer built by
// the router (already scoped to S3 config). Nodes without stored keys are
// returned untouched.
export function signNodeOutputs(node, sign) {
  const op = node?.output_params;
  if (!sign || !op || !Array.isArray(op.outputs) || op.outputs.length === 0) return node;
  const hasKeys = op.outputs.some((o) => o?.key);
  if (!hasKeys) return node;
  const signed = sign({ outputs: op.outputs });
  const outputs = Array.isArray(signed?.outputs) ? signed.outputs : op.outputs;
  const resultUrl = outputs[0]?.key ? outputs[0].value : (op.resultUrl ?? null);
  return { ...node, output_params: { ...op, outputs, resultUrl } };
}

export { MEDIA_TYPES };
