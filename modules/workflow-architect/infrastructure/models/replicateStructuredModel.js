import { createWorkflowIrJsonSchema } from '../../domain/architectIrSchema.js';

const REPLICATE_API = 'https://api.replicate.com/v1';

export const ARCHITECT_REPLICATE_MODEL_REF = 'openai/gpt-5-structured';
export const ARCHITECT_GPT_MODEL = 'gpt-5.6-luna';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyModelOutput(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((item) => (typeof item === 'string' ? item : item?.text || item?.content || JSON.stringify(item)))
      .join('');
  }
  if (typeof output === 'object') {
    if (typeof output.text === 'string') return output.text;
    if (typeof output.content === 'string') return output.content;
    if (typeof output.output === 'string') return output.output;
    return JSON.stringify(output);
  }
  return String(output);
}

function extractJsonObject(value) {
  if (!value) throw new Error('Structured model returned an empty response.');
  if (typeof value === 'object' && !Array.isArray(value)) return value;

  const trimmed = String(value).trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('Structured model response did not contain a JSON object.');
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
    const detail = data?.detail || data?.title || response.statusText;
    const error = new Error(`Replicate structured model request failed: ${detail}`);
    error.status = response.status;
    error.response = data;
    if (response.status === 401) {
      error.message = 'Replicate rejected the saved user API key.';
    }
    throw error;
  }

  return data;
}

export async function runStructuredReplicatePrediction({
  apiKey,
  input,
  modelRef = ARCHITECT_REPLICATE_MODEL_REF,
  maxAttempts = 120,
  interval = 1000,
} = {}) {
  if (!apiKey) {
    const error = new Error('Missing saved user Replicate API key for Architect model calls.');
    error.code = 'ARCHITECT_MODEL_KEY_MISSING';
    throw error;
  }

  let prediction = await replicateJson(`${REPLICATE_API}/models/${modelRef}/predictions`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });
  const pollUrl = prediction?.urls?.get || `${REPLICATE_API}/predictions/${prediction.id}`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (prediction?.status === 'succeeded') return prediction.output;
    if (prediction?.status === 'failed' || prediction?.status === 'canceled') {
      throw new Error(`Replicate structured model ${prediction.status}: ${prediction.error || 'Unknown error'}`);
    }
    await sleep(interval);
    prediction = await replicateJson(pollUrl, apiKey);
  }

  throw new Error('Replicate structured model timed out.');
}

export async function generateCreateWorkflowIr({
  userRequest,
  catalog,
  apiKey,
  env = process.env,
  runPrediction = runStructuredReplicatePrediction,
} = {}) {
  if (!apiKey) {
    const error = new Error('Missing saved user Replicate API key for Architect model calls.');
    error.code = 'ARCHITECT_MODEL_KEY_MISSING';
    throw error;
  }

  const schema = createWorkflowIrJsonSchema(catalog);
  const instructions = [
    'You are Workflow Architect. Return only JSON matching the provided schema.',
    'Plan one create_workflow proposal for an empty workflow canvas.',
    'Use only model_id values from the curated catalog.',
    'Do not include secrets, URLs with query strings, credentials, API nodes, or destructive edits.',
  ].join('\n');

  const prompt = JSON.stringify({
    request: userRequest,
    curated_catalog: catalog.compact,
  });

  const output = await runPrediction({
    apiKey,
    input: {
      model: ARCHITECT_GPT_MODEL,
      prompt,
      instructions,
      reasoning_effort: 'minimal',
      verbosity: 'low',
      enable_web_search: false,
      image_input: [],
      tools: [],
      input_item_list: [],
      simple_schema: [],
      json_schema: schema,
      max_output_tokens: Number(env.WORKFLOW_ARCHITECT_MODEL_MAX_TOKENS || 1200),
    },
    maxAttempts: Number(env.WORKFLOW_ARCHITECT_MODEL_MAX_ATTEMPTS || 120),
    interval: Number(env.WORKFLOW_ARCHITECT_MODEL_POLL_MS || 1000),
  });

  return extractJsonObject(stringifyModelOutput(output));
}
