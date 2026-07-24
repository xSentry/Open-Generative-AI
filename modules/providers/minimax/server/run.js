import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, invalidCredential } from '../../core/errors.js';
import { createRuntimeSignature } from '../../runtime/server/signature.js';
import { saveRuntimeSample } from '../../runtime/server/samples.js';

const PROVIDER_ID = 'minimax';
const API_BASE = 'https://api.minimax.io';
const ANTHROPIC_BASE = `${API_BASE}/anthropic`;

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function requireHttpsUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new ProviderError('provider_request_failed', `${label} must be a valid public HTTPS URL.`, { provider: PROVIDER_ID }); }
  if (url.protocol !== 'https:') throw new ProviderError('provider_request_failed', `${label} must use HTTPS.`, { provider: PROVIDER_ID });
  return url.toString();
}

function mediaDataUrl(hex, mime = 'audio/mpeg') {
  if (!hex || typeof hex !== 'string') return null;
  return `data:${mime};base64,${Buffer.from(hex, 'hex').toString('base64')}`;
}

function imageDataUrl(base64) {
  if (!base64 || typeof base64 !== 'string') return null;
  if (/^data:image\//i.test(base64)) return base64;
  return `data:image/jpeg;base64,${base64}`;
}

function providerFailure(message, details = {}, cause) {
  return new ProviderError('provider_request_failed', message, { provider: PROVIDER_ID, ...details }, cause ? { cause } : {});
}

function assertMiniMaxSuccess(data, operation) {
  const statusCode = data?.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    throw providerFailure(`MiniMax ${operation} failed: ${data?.base_resp?.status_msg || `status ${statusCode}`}.`, { nativeStatusCode: statusCode });
  }
  return data;
}

async function minimaxJson(path, apiKey, options = {}, fetchFn = fetch) {
  const response = await fetchFn(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw invalidCredential(PROVIDER_ID, 'MiniMax rejected the stored API key.');
    throw providerFailure(`MiniMax request failed (${response.status}): ${data?.base_resp?.status_msg || data?.message || response.statusText}.`, { status: response.status });
  }
  if (!data) throw providerFailure('MiniMax returned an invalid JSON response.');
  return assertMiniMaxSuccess(data, path);
}

function anthropicContent(params) {
  const content = [{ type: 'text', text: String(params.prompt || '') }];
  if (params.image_url) content.push({ type: 'image', source: { type: 'url', url: requireHttpsUrl(params.image_url, 'image_url') } });
  if (params.video_url) content.push({ type: 'video', source: { type: 'url', url: requireHttpsUrl(params.video_url, 'video_url') } });
  return content;
}

export function buildMiniMaxRequest(model, params = {}) {
  const operation = model?.metadata?.operation;
  const nativeId = model?.metadata?.nativeId || model?.endpoint || model?.id;
  if (operation === 'anthropic-messages') {
    return compact({
      model: nativeId,
      max_tokens: params.max_tokens ?? 4096,
      system: params.system,
      temperature: params.temperature ?? 1,
      top_p: params.top_p ?? (nativeId === 'MiniMax-M3' ? 0.95 : 0.9),
      thinking: params.thinking ? { type: 'adaptive' } : undefined,
      messages: [{ role: 'user', content: anthropicContent(params) }],
    });
  }
  if (operation === 'image-generation') {
    return compact({
      model: nativeId,
      prompt: params.prompt,
      aspect_ratio: params.aspect_ratio,
      width: params.width,
      height: params.height,
      seed: params.seed,
      n: params.n ?? 1,
      prompt_optimizer: params.prompt_optimizer ?? false,
      // Returning the bytes avoids a second worker -> MiniMax CDN request.
      // Some production networks cannot reach MiniMax's temporary image host,
      // even though the API request itself succeeds.
      response_format: 'base64',
      ...(params.image_url ? { subject_reference: [{ type: 'character', image_file: requireHttpsUrl(params.image_url, 'image_url') }] } : {}),
    });
  }
  if (operation === 'video-generation') {
    const subjectReference = model.metadata?.subjectReference === true;
    return compact({
      model: nativeId,
      prompt: params.prompt,
      duration: params.duration ?? 6,
      resolution: params.resolution ?? '1080P',
      prompt_optimizer: params.prompt_optimizer,
      ...(params.image_url && subjectReference ? { subject_reference: [{ type: 'character', image: [requireHttpsUrl(params.image_url, 'image_url')] }] } : {}),
      ...(params.image_url && !subjectReference ? { first_frame_image: requireHttpsUrl(params.image_url, 'image_url') } : {}),
      ...(params.last_image ? { last_frame_image: requireHttpsUrl(params.last_image, 'last_image') } : {}),
    });
  }
  if (operation === 'text-to-speech') {
    return {
      model: nativeId,
      text: params.text,
      stream: false,
      language_boost: params.language_boost || 'auto',
      output_format: 'url',
      voice_setting: compact({ voice_id: params.voice_id, speed: params.speed ?? 1, vol: params.volume ?? 1, pitch: params.pitch ?? 0 }),
      audio_setting: compact({ sample_rate: params.sample_rate ?? 32000, bitrate: params.bitrate ?? 128000, format: params.format || 'mp3', channel: params.channel ?? 1 }),
    };
  }
  if (operation === 'voice-design') return { prompt: params.prompt, preview_text: params.preview_text };
  if (operation === 'voice-list') return { voice_type: params.voice_type || 'all' };
  if (operation === 'voice-delete') return { voice_type: params.voice_type, voice_id: params.voice_id };
  if (operation === 'music-generation') {
    return compact({
      model: nativeId,
      prompt: params.prompt,
      lyrics: params.lyrics,
      lyrics_optimizer: params.lyrics_optimizer,
      is_instrumental: params.is_instrumental,
      audio_url: params.audio_url ? requireHttpsUrl(params.audio_url, 'audio_url') : undefined,
      cover_feature_id: params.cover_feature_id,
      output_format: 'url',
      stream: false,
      audio_setting: compact({ sample_rate: params.sample_rate ?? 44100, bitrate: params.bitrate ?? 256000, format: params.format || 'mp3' }),
    });
  }
  if (operation === 'voice-clone') return null;
  throw providerFailure(`MiniMax operation "${operation || 'unknown'}" is not implemented.`, { modelId: model?.id });
}

async function uploadVoiceFile(url, purpose, apiKey, signal, fetchFn) {
  const source = await fetchFn(requireHttpsUrl(url, `${purpose} audio`), { signal });
  if (!source.ok) throw providerFailure(`Could not download ${purpose} audio (${source.status}).`);
  const form = new FormData();
  form.set('purpose', purpose);
  form.set('file', await source.blob(), `${purpose}.audio`);
  const uploaded = await minimaxJson('/v1/files/upload', apiKey, { method: 'POST', body: form, signal }, fetchFn);
  if (!uploaded?.file?.file_id) throw providerFailure(`MiniMax did not return a file ID for ${purpose} audio.`);
  return uploaded.file.file_id;
}

async function runVoiceClone({ apiKey, params, signal, fetchFn }) {
  const fileId = await uploadVoiceFile(params.audio_url, 'voice_clone', apiKey, signal, fetchFn);
  const promptAudio = params.prompt_audio_url
    ? await uploadVoiceFile(params.prompt_audio_url, 'prompt_audio', apiKey, signal, fetchFn)
    : null;
  const body = compact({
    file_id: fileId,
    voice_id: params.voice_id,
    model: params.model || 'speech-2.8-hd',
    text: params.text,
    need_noise_reduction: params.need_noise_reduction ?? false,
    need_volume_normalization: params.need_volume_normalization ?? false,
    ...(promptAudio ? { clone_prompt: compact({ prompt_audio: promptAudio, prompt_text: params.prompt_text }) } : {}),
  });
  const data = await minimaxJson('/v1/voice_clone', apiKey, { method: 'POST', body: JSON.stringify(body), signal }, fetchFn);
  return { data, submitted: body };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function pollVideo(taskId, apiKey, signal, fetchFn, sleepFn, pollInterval) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await sleepFn(pollInterval, signal);
    const status = await minimaxJson(`/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, apiKey, { signal }, fetchFn);
    if (status.status === 'Fail') throw providerFailure(`MiniMax video generation failed: ${status.error_message || 'unknown error'}.`, { providerRef: taskId });
    if (status.status === 'Success') {
      const file = await minimaxJson(`/v1/files/retrieve?file_id=${encodeURIComponent(status.file_id)}`, apiKey, { signal }, fetchFn);
      if (!file?.file?.download_url) throw providerFailure('MiniMax completed the video but returned no download URL.', { providerRef: taskId });
      return file.file.download_url;
    }
  }
  throw providerFailure('MiniMax video generation timed out.', { providerRef: taskId });
}

function safeVoiceList(data) {
  const result = {};
  for (const key of ['system_voice', 'voice_cloning', 'voice_generation', 'music_generation']) {
    if (Array.isArray(data?.[key])) result[key] = data[key].map(({ voice_id, description, created_time }) => ({ voice_id, description, created_time }));
  }
  return result;
}

function normalizedResult(providerRef, { outputs = [], text = null, metrics = null } = {}) {
  return {
    provider: PROVIDER_ID,
    providerRef,
    createdAt: new Date().toISOString(),
    status: 'succeeded',
    url: outputs[0] || null,
    outputs,
    text,
    metrics,
  };
}

async function publishStarted(onStarted, event) {
  if (typeof onStarted !== 'function') return;
  try { await onStarted(event); } catch (error) {
    console.warn('[minimax-runtime] could not publish prediction start:', error?.message || error);
  }
}

export async function runMiniMaxPrediction({
  apiKey,
  model,
  params = {},
  signal,
  onStarted,
  fetchFn = fetch,
  sleepFn = delay,
  pollInterval = 10_000,
  saveRuntimeSampleFn = saveRuntimeSample,
  anthropicFactory = (key) => new Anthropic({ apiKey: key, baseURL: ANTHROPIC_BASE }),
}) {
  const startedAt = new Date();
  const fallbackId = crypto.randomUUID();
  const operation = model?.metadata?.operation;
  let providerRef = fallbackId;
  let submitted = null;
  let result;

  try {
    if (operation === 'anthropic-messages') {
      submitted = buildMiniMaxRequest(model, params);
      const message = await anthropicFactory(apiKey).messages.create(submitted, { signal });
      providerRef = message.id || fallbackId;
      const text = (message.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
      result = normalizedResult(providerRef, { text, metrics: message.usage ? { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens } : null });
    } else if (operation === 'voice-clone') {
      const clone = await runVoiceClone({ apiKey, params, signal, fetchFn });
      submitted = clone.submitted;
      providerRef = clone.data.trace_id || fallbackId;
      const preview = /^https?:\/\//i.test(clone.data.demo_audio || '')
        ? clone.data.demo_audio
        : mediaDataUrl(clone.data.demo_audio);
      const outputs = preview ? [preview] : [];
      result = normalizedResult(providerRef, { outputs, text: JSON.stringify({ voice_id: params.voice_id, active_for_days: 7 }) });
    } else {
      submitted = buildMiniMaxRequest(model, params);
      const path = model.endpoint;
      const data = await minimaxJson(path, apiKey, { method: 'POST', body: JSON.stringify(submitted), signal }, fetchFn);
      providerRef = data.task_id || data.id || data.trace_id || data.voice_id || fallbackId;
      if (operation === 'video-generation') {
        await publishStarted(onStarted, { predictionId: providerRef, createdAt: startedAt.toISOString(), status: 'processing' });
        const url = await pollVideo(providerRef, apiKey, signal, fetchFn, sleepFn, pollInterval);
        result = normalizedResult(providerRef, { outputs: [url] });
      } else if (operation === 'image-generation') {
        const outputs = (data.data?.image_base64 || []).map(imageDataUrl).filter(Boolean);
        result = normalizedResult(providerRef, { outputs });
      } else if (operation === 'text-to-speech' || operation === 'music-generation') {
        const audio = data.data?.audio;
        const url = /^https?:\/\//i.test(audio || '') ? audio : mediaDataUrl(audio, `audio/${params.format || 'mpeg'}`);
        result = normalizedResult(providerRef, { outputs: url ? [url] : [], metrics: data.extra_info ? { durationMs: data.extra_info.audio_length ?? data.extra_info.music_duration ?? null } : null });
      } else if (operation === 'voice-design') {
        const preview = mediaDataUrl(data.trial_audio);
        result = normalizedResult(providerRef, { outputs: preview ? [preview] : [], text: JSON.stringify({ voice_id: data.voice_id }) });
      } else if (operation === 'voice-list') {
        result = normalizedResult(providerRef, { text: JSON.stringify(safeVoiceList(data)) });
      } else if (operation === 'voice-delete') {
        result = normalizedResult(providerRef, { text: JSON.stringify({ voice_id: data.voice_id, created_time: data.created_time }) });
      }
    }

    if (operation !== 'video-generation') await publishStarted(onStarted, { predictionId: providerRef, createdAt: startedAt.toISOString(), status: 'succeeded' });
    const completedAt = new Date();
    try {
      if (process.env.DATABASE_URL || saveRuntimeSampleFn !== saveRuntimeSample) {
        const seconds = (completedAt.getTime() - startedAt.getTime()) / 1000;
        await saveRuntimeSampleFn({
          provider: PROVIDER_ID,
          modelId: model.id,
          signature: createRuntimeSignature({ model, params: submitted || {} }),
          predictionId: `${PROVIDER_ID}:${providerRef}`,
          predictTimeSeconds: seconds,
          totalTimeSeconds: seconds,
          createdAt: startedAt,
          startedAt,
          completedAt,
        });
      }
    } catch (error) {
      console.warn('[minimax-runtime] could not save successful runtime sample:', error?.message || error);
    }
    return result;
  } catch (error) {
    if (error instanceof ProviderError || error?.name === 'AbortError') throw error;
    if (error?.status === 401 || error?.status === 403) throw invalidCredential(PROVIDER_ID, 'MiniMax rejected the stored API key.');
    throw providerFailure(`MiniMax ${operation || 'prediction'} failed: ${error?.message || 'unknown error'}.`, { modelId: model?.id }, error);
  }
}

export async function validateMiniMaxCredential(apiKey, { fetchFn = fetch } = {}) {
  const response = await fetchFn(`${ANTHROPIC_BASE}/v1/models?limit=1`, { headers: { 'X-Api-Key': apiKey } });
  if (response.status === 401 || response.status === 403) throw invalidCredential(PROVIDER_ID, 'MiniMax rejected the stored API key.');
  if (!response.ok) throw providerFailure(`MiniMax credential validation failed (${response.status}).`, { status: response.status });
  return true;
}
