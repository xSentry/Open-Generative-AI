import { getReplicateModelById } from '../../../providers/replicate/replicateModels.js';
import { runReplicatePrediction } from '../../../providers/replicate/server/run.js';
import { createWorkflowIrJsonSchema } from '../../domain/architectIrSchema.js';

export const DEFAULT_ARCHITECT_MODEL_ID = 'gpt-5-nano';

function extractJsonObject(text) {
  if (!text) throw new Error('Structured model returned an empty response.');
  const trimmed = String(text).trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('Structured model response did not contain a JSON object.');
}

function architectModelApiKey(env) {
  return env.WORKFLOW_ARCHITECT_REPLICATE_API_KEY || env.REPLICATE_API_TOKEN || env.REPLICATE_API_KEY || '';
}

export async function generateCreateWorkflowIr({
  userRequest,
  catalog,
  env = process.env,
  runPrediction = runReplicatePrediction,
} = {}) {
  const apiKey = architectModelApiKey(env);
  if (!apiKey) {
    const error = new Error('Missing WORKFLOW_ARCHITECT_REPLICATE_API_KEY or REPLICATE_API_KEY for Architect model calls.');
    error.code = 'ARCHITECT_MODEL_KEY_MISSING';
    throw error;
  }

  const modelId = env.WORKFLOW_ARCHITECT_MODEL_ID || DEFAULT_ARCHITECT_MODEL_ID;
  const model = getReplicateModelById(modelId);
  if (!model) {
    const error = new Error(`Architect model "${modelId}" is not in the Replicate catalog.`);
    error.code = 'ARCHITECT_MODEL_NOT_FOUND';
    throw error;
  }

  const schema = createWorkflowIrJsonSchema(catalog);
  const systemPrompt = [
    'You are Workflow Architect. Return only JSON matching the provided schema.',
    'Plan one create_workflow proposal for an empty workflow canvas.',
    'Use only model_id values from the curated catalog.',
    'Do not include secrets, URLs with query strings, credentials, API nodes, or destructive edits.',
  ].join('\n');

  const prompt = JSON.stringify({
    request: userRequest,
    curated_catalog: catalog.compact,
    output_schema: schema,
  });

  const result = await runPrediction({
    apiKey,
    model,
    mode: 't2t',
    maxAttempts: Number(env.WORKFLOW_ARCHITECT_MODEL_MAX_ATTEMPTS || 120),
    interval: Number(env.WORKFLOW_ARCHITECT_MODEL_POLL_MS || 1000),
    params: {
      prompt,
      system_prompt: systemPrompt,
      max_completion_tokens: Number(env.WORKFLOW_ARCHITECT_MODEL_MAX_TOKENS || 1200),
    },
  });

  return extractJsonObject(result?.text || result?.outputs?.[0] || result?.url);
}
