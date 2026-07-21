import { getUserProviderCredential } from '../../providers/server/credentials.js';
import { requireProviderOperation } from '../../providers/server/registry.js';
import * as repo from './repo.js';
import { enqueueDesignAgentJob } from './jobQueue.js';

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

function pickModel(adapter, mode, requestedModelId = null) {
  const models = adapter.catalog.getModelListsSync?.()[mode] || [];
  if (requestedModelId) {
    const model = models.find((entry) => entry.id === requestedModelId);
    if (model) return model;
  }
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

function buildPlannerPrompt({ payload, message, assets }) {
  const assetSummary = assets.map((asset) => ({
    label: asset.asset_label,
    kind: asset.kind,
    source_tool: asset.source_tool || null,
  }));

  return [
    'You are the planner for a creative design canvas.',
    'Return only JSON with keys: tool, prompt, source_asset_label, provider_model.',
    `Valid tools: ${Object.keys(TOOL_TO_MODE).join(', ')}.`,
    'Choose source_asset_label only from the provided assets, or null.',
    'provider_model is optional and must be an exact model id from the active provider catalog when you are confident.',
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

async function planTool({ adapter, payload, message, assets, provider, apiKey }) {
  if (adapter.planning?.createToolPlan && payload.planner_model) {
    try {
      const plan = await adapter.planning.createToolPlan({
        apiKey,
        modelId: payload.planner_model,
        prompt: buildPlannerPrompt({ payload, message, assets }),
      });
      const tool = normalizeToolName(plan?.tool);
      if (tool) {
        return {
          tool,
          prompt: typeof plan.prompt === 'string' && plan.prompt.trim() ? plan.prompt.trim() : message,
          sourceAssetLabel: typeof plan.source_asset_label === 'string' ? plan.source_asset_label : null,
          requestedModelId: typeof (plan.provider_model || plan.replicate_model) === 'string'
            ? (plan.provider_model || plan.replicate_model)
            : null,
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

async function buildTool(job, scope, apiKey, adapter) {
  const payload = job.payload || {};
  const message =
    payload.message ||
    Object.values(payload.inputs || {}).find((value) => typeof value === 'string') ||
    '';
  const assets = await repo.listAssets(job.session_id, scope);
  const plan = await planTool({ adapter, payload, message, assets, provider: scope.provider, apiKey });
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
    model: pickModel(adapter, config.mode, requestedModelId),
    params,
    kind: config.kind,
    sourceAsset,
    prompt,
    planner: plan.planner,
    requestedModelId: plan.requestedModelId,
  };
}

export async function processDesignAgentJob(jobId) {
  const job = await repo.getJobForProcessing(jobId);
  if (!job || job.status !== 'pending') return;

  const scope = { userId: job.user_id, provider: job.provider };
  await repo.updateJob(jobId, { status: 'processing' });

  try {
    const adapter = requireProviderOperation(job.provider, 'designAgent');
    const apiKey = await getUserProviderCredential(job.user_id, job.provider);
    const tool = await buildTool(job, scope, apiKey, adapter);
    await repo.addEvent({
      jobId,
      sessionId: job.session_id,
      userId: job.user_id,
      type: 'text',
      payload: { content: 'I will run this with your selected provider.\n' },
    });

    if (!tool.model) {
      throw new Error(`No ${job.provider} model is configured for ${tool.mode}.`);
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
      throw new Error(`A provider credential is required for ${job.provider}.`);
    }

    const result = await adapter.predictions.run({
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

export function enqueueJob(job, options = {}) {
  return enqueueDesignAgentJob(job, options);
}
