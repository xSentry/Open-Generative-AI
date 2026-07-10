import { getUserReplicateApiKey } from '@/modules/auth/server/users';
import {
  getReplicateModelById,
  getReplicateModelByRef,
  getReplicateStudioModel,
  getReplicateModelsForMode,
} from '@/modules/providers/replicate/server/catalog';
import { runReplicatePrediction } from '@/modules/providers/replicate/server/run';
import * as repo from './repo.js';

const REPLICATE_API = 'https://api.replicate.com/v1';

const SKILLS = [
  {
    name: 'Image',
    description: 'Generate a new image from a prompt.',
    inputs: ['prompt'],
  },
  {
    name: 'Image Edit',
    description: 'Edit an existing image asset with a prompt.',
    inputs: ['prompt'],
  },
  {
    name: 'Video',
    description: 'Generate a video, optionally from an image asset.',
    inputs: ['prompt'],
  },
  {
    name: 'Audio',
    description: 'Generate speech or audio from text.',
    inputs: ['text'],
  },
];

const TOOL_TO_MODE = {
  generate_image: { mode: 't2i', kind: 'image' },
  edit_image: { mode: 'i2i', kind: 'image' },
  generate_video: { mode: 't2v', kind: 'video' },
  image_to_video: { mode: 'i2v', kind: 'video' },
  edit_video: { mode: 'v2v', kind: 'video' },
  generate_audio: { mode: 'audio', kind: 'audio' },
};

function pickModel(mode, requestedModelId = null) {
  if (requestedModelId) {
    const model = getReplicateStudioModel(mode, requestedModelId);
    if (model) return model;
  }
  const models = getReplicateModelsForMode(mode);
  return models.find((model) => model.hasPrompt) || models[0] || null;
}

function inferKindFromUrl(url, fallback = 'image') {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (/\.(mp4|webm|mov|m4v)$/.test(clean)) return 'video';
  if (/\.(mp3|wav|m4a|ogg|aac)$/.test(clean)) return 'audio';
  return fallback;
}

function firstOutput(result) {
  return result?.url || result?.outputs?.[0] || null;
}

function assetMention(text) {
  const match = String(text || '').match(/@?(asset_\d+)/i);
  return match?.[1] || null;
}

function classifyRequest({ message, skillName, hasImageAsset, hasVideoAsset }) {
  const text = `${skillName || ''} ${message || ''}`.toLowerCase();
  if (/audio|music|voice|sound|speech|tts/.test(text)) return 'generate_audio';
  if (/video|animate|motion/.test(text)) return hasImageAsset ? 'image_to_video' : 'generate_video';
  if (/edit|change|modify|enhance|upscale|improve|replace/.test(text) && (hasImageAsset || hasVideoAsset)) {
    return hasVideoAsset ? 'edit_video' : 'edit_image';
  }
  return 'generate_image';
}

function normalizeToolName(value) {
  const name = String(value || '').trim();
  return TOOL_TO_MODE[name] ? name : null;
}

function extractJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPlannerPrompt({ payload, message, assets }) {
  const assetSummary = assets.map((asset) => ({
    label: asset.asset_label,
    kind: asset.kind,
    source_tool: asset.source_tool || null,
  }));

  return [
    'You are the planner for a creative design canvas.',
    'Return only JSON with keys: tool, prompt, source_asset_label, replicate_model.',
    `Valid tools: ${Object.keys(TOOL_TO_MODE).join(', ')}.`,
    'Choose source_asset_label only from the provided assets, or null.',
    'replicate_model is optional and must be an exact local Replicate catalog model id when you are confident.',
    '',
    JSON.stringify({
      user_message: message,
      pinned_skill: payload.skill_name || null,
      skill_inputs: payload.inputs || null,
      recent_messages: Array.isArray(payload.messages_snapshot) ? payload.messages_snapshot.slice(-8) : [],
      assets: assetSummary,
      canvas_state: payload.canvas_state || null,
    }),
  ].join('\n');
}

function plannerTextFromOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((item) => (typeof item === 'string' ? item : item?.text || item?.content || '')).join('');
  }
  if (output && typeof output === 'object') {
    if (typeof output.text === 'string') return output.text;
    if (typeof output.content === 'string') return output.content;
    if (typeof output.output === 'string') return output.output;
  }
  return '';
}

async function replicateJson(url, apiKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.detail || data?.title || `Replicate planner request failed with ${response.status}`);
  }
  return data;
}

function resolveReplicatePlannerModel(modelId) {
  if (!modelId) return null;
  const catalogModel = getReplicateModelById(modelId) || getReplicateModelByRef(modelId);
  if (catalogModel?.replicate?.version) {
    return {
      ref: catalogModel.replicate?.ref || modelId,
      version: catalogModel.replicate.version,
    };
  }

  return {
    ref: modelId,
    version: null,
  };
}

async function callReplicatePlanner({ apiKey, payload, message, assets }) {
  const plannerModel = resolveReplicatePlannerModel(payload.planner_model);
  if (!apiKey || (!plannerModel?.ref && !plannerModel?.version)) return null;

  const prompt = buildPlannerPrompt({ payload, message, assets });
  const input = { prompt };
  const body = plannerModel.version
    ? { version: plannerModel.version, input }
    : { input };
  const submitUrl = plannerModel.version
    ? `${REPLICATE_API}/predictions`
    : `${REPLICATE_API}/models/${plannerModel.ref}/predictions`;

  let prediction = await replicateJson(submitUrl, apiKey, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const pollUrl = prediction?.urls?.get || `${REPLICATE_API}/predictions/${prediction.id}`;
  const maxAttempts = 120;
  const interval = 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (prediction?.status === 'succeeded') {
      return extractJsonObject(plannerTextFromOutput(prediction.output));
    }
    if (prediction?.status === 'failed' || prediction?.status === 'canceled') {
      throw new Error(`Replicate planner ${prediction.status}: ${prediction.error || 'Unknown error'}`);
    }
    await sleep(interval);
    prediction = await replicateJson(pollUrl, apiKey);
  }

  throw new Error('Replicate planner timed out.');
}

async function planTool({ payload, message, assets, provider, apiKey }) {
  if (provider === 'replicate' && payload.planner_model) {
    try {
      const plan = await callReplicatePlanner({ apiKey, payload, message, assets });
      const tool = normalizeToolName(plan?.tool);
      if (tool) {
        return {
          tool,
          prompt: typeof plan.prompt === 'string' && plan.prompt.trim() ? plan.prompt.trim() : message,
          sourceAssetLabel: typeof plan.source_asset_label === 'string' ? plan.source_asset_label : null,
          requestedModelId: typeof plan.replicate_model === 'string' ? plan.replicate_model : null,
          planner: provider,
        };
      }
    } catch (error) {
      console.warn('[design-agent] planner fallback:', error.message || error);
    }
  }

  const sourceAsset = assets.find((asset) => asset.asset_label === assetMention(message)) || assets[assets.length - 1] || null;
  return {
    tool: classifyRequest({
      message,
      skillName: payload.skill_name,
      hasImageAsset: sourceAsset?.kind === 'image',
      hasVideoAsset: sourceAsset?.kind === 'video',
    }),
    prompt: message,
    sourceAssetLabel: sourceAsset?.asset_label || null,
    requestedModelId: null,
    planner: 'heuristic',
  };
}

function sourceKindForTool(toolName) {
  if (toolName === 'edit_image' || toolName === 'image_to_video') return 'image';
  if (toolName === 'edit_video') return 'video';
  return null;
}

function chooseSourceAsset({ assets, sourceKind, requestedLabel, message }) {
  if (!sourceKind) return null;

  const requested = requestedLabel
    ? assets.find((asset) => asset.asset_label === requestedLabel)
    : null;
  if (requested?.kind === sourceKind) return requested;

  const mentioned = assets.find((asset) => asset.asset_label === assetMention(message));
  if (mentioned?.kind === sourceKind) return mentioned;

  return [...assets].reverse().find((asset) => asset.kind === sourceKind) || null;
}

async function buildTool(job, scope, apiKey) {
  const payload = job.payload || {};
  const message =
    payload.message ||
    Object.values(payload.inputs || {}).find((value) => typeof value === 'string') ||
    '';
  const assets = await repo.listAssets(job.session_id, scope);
  const plan = await planTool({ payload, message, assets, provider: scope.provider, apiKey });
  let name = plan.tool;
  const sourceKind = sourceKindForTool(name);
  const sourceAsset = chooseSourceAsset({
    assets,
    sourceKind,
    requestedLabel: plan.sourceAssetLabel,
    message,
  });
  if (sourceKind && !sourceAsset) {
    name = sourceKind === 'video' ? 'generate_video' : 'generate_image';
  }
  const config = TOOL_TO_MODE[name] || TOOL_TO_MODE.generate_image;
  const selectedModels = payload.selected_models || {};
  const requestedModelId =
    selectedModels[name] ||
    selectedModels[config.mode] ||
    plan.requestedModelId ||
    null;
  const prompt = plan.prompt || message;
  const params = { prompt, instruction: prompt, text: prompt };

  if (name === 'edit_image') {
    params.image_url = sourceAsset?.url;
    params.images_list = sourceAsset?.url ? [sourceAsset.url] : undefined;
  } else if (name === 'image_to_video') {
    params.image_url = sourceAsset?.url;
    params.images_list = sourceAsset?.url ? [sourceAsset.url] : undefined;
  } else if (name === 'edit_video') {
    params.video_url = sourceAsset?.url;
    params.videos_list = sourceAsset?.url ? [sourceAsset.url] : undefined;
  }

  return {
    name,
    mode: config.mode,
    model: pickModel(config.mode, requestedModelId),
    params,
    kind: config.kind,
    sourceAsset,
    prompt,
    planner: plan.planner,
    requestedModelId: plan.requestedModelId,
  };
}

async function processJob(jobId) {
  const job = await repo.getJobForProcessing(jobId);
  if (!job || job.status !== 'pending') return;

  const scope = { userId: job.user_id, provider: job.provider };
  await repo.updateJob(jobId, { status: 'processing' });

  try {
    const apiKey = await getUserReplicateApiKey(job.user_id) || process.env.REPLICATE_API_TOKEN;
    const tool = await buildTool(job, scope, apiKey);
    await repo.addEvent({
      jobId,
      sessionId: job.session_id,
      userId: job.user_id,
      type: 'text',
      payload: { content: 'I will run this with your selected provider.\n' },
    });

    if (!tool.model) {
      throw new Error(`No Replicate model is configured for ${tool.mode}.`);
    }

    await repo.addEvent({
      jobId,
      sessionId: job.session_id,
      userId: job.user_id,
      type: 'tool_call',
      payload: {
        name: tool.name,
        args: {
          prompt: tool.prompt,
          image: tool.sourceAsset?.kind === 'image' ? tool.sourceAsset.asset_label : undefined,
          video: tool.sourceAsset?.kind === 'video' ? tool.sourceAsset.asset_label : undefined,
          model: tool.model.id,
          planner: tool.planner,
        },
      },
    });

    if (!apiKey) {
      throw new Error('A Replicate API key is required for the selected provider.');
    }

    const result = await runReplicatePrediction({
      apiKey,
      model: tool.model,
      params: tool.params,
      mode: tool.mode,
    });
    const url = firstOutput(result);
    if (!url) {
      throw new Error('The provider completed without returning a media URL.');
    }

    const asset = await repo.createAsset({
      sessionId: job.session_id,
      userId: job.user_id,
      provider: job.provider,
      url,
      kind: inferKindFromUrl(url, tool.kind),
      sourceTool: tool.name,
      model: tool.model.id,
      prompt: tool.prompt,
      metadata: {
        providerResult: result,
        sourceAssetId: tool.sourceAsset?.asset_label || null,
      },
    });

    await repo.addEvent({
      jobId,
      sessionId: job.session_id,
      userId: job.user_id,
      type: 'tool_result',
      payload: {
        name: tool.name,
        result: {
          ok: true,
          model: tool.model.id,
          url,
          source_asset_id: tool.sourceAsset?.asset_label || null,
        },
        asset,
      },
    });
    await repo.addEvent({
      jobId,
      sessionId: job.session_id,
      userId: job.user_id,
      type: 'text',
      payload: { content: `Done. I added ${asset.asset_label} to the canvas.` },
    });
    await repo.updateJob(jobId, { status: 'succeeded' });
  } catch (error) {
    await repo.addEvent({
      jobId,
      sessionId: job.session_id,
      userId: job.user_id,
      type: 'error',
      payload: { message: error.message || 'Design Agent job failed.' },
    });
    await repo.updateJob(jobId, { status: 'failed', error: error.message || 'Design Agent job failed.' });
  }
}

export function listSkills() {
  return SKILLS;
}

export function enqueueJob(jobId) {
  Promise.resolve()
    .then(() => processJob(jobId))
    .catch((error) => console.error('[design-agent] job failed:', error));
}
