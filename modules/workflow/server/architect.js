// Phase 5 — AI "architect": turn a natural-language prompt into a workflow graph.
//
// The heavy lifting is delegated to an LLM via an injectable `llm(messages)`
// function, so this module is unit-testable without any network. The default
// client targets an OpenAI-compatible /chat/completions endpoint, configured
// entirely through env vars (no new provider plumbing required):
//   WORKFLOW_LLM_BASE_URL (default https://api.openai.com/v1)
//   WORKFLOW_LLM_API_KEY  (required for the default client)
//   WORKFLOW_LLM_MODEL    (default gpt-4o-mini)
//
// Output contract (consumed by NodeFlow.jsx pollArchitectStatus):
//   { message, suggestions, workflow: { nodes, edges } }
// where each node is { id, category, model, position:{x,y}, input_params }
// and each edge is { source, target, sourceHandle, targetHandle }.
import { buildNodeSchemas } from './schemas.js';

const VALID_CATEGORIES = new Set(['text', 'image', 'video', 'audio', 'utility']);

// Compact per-category catalog (a handful of model ids) so the LLM picks valid
// models without being flooded with the full list.
export function buildCatalogSummary(provider, perCategory = 8) {
  const schemas = buildNodeSchemas(provider);
  const categories = schemas.categories || {};
  const summary = {};
  for (const [category, entry] of Object.entries(categories)) {
    const ids = Object.keys(entry.models || {});
    const compact = ids.slice(0, perCategory);
    const passthrough = `${category}-passthrough`;
    if (compact.length > 0 && ids.includes(passthrough) && !compact.includes(passthrough)) {
      compact[compact.length - 1] = passthrough;
    }
    summary[category] = compact;
  }
  return summary;
}

export function buildArchitectMessages({ prompt, history = [], catalog }) {
  const system = [
    'You are a workflow architect for a node-based generative-AI builder.',
    'Design a directed graph of nodes that fulfils the user request.',
    'Node categories: text, image, video, audio, utility.',
    'A "text" node emits a prompt; image/video/audio nodes run a model; a',
    'utility node with model "prompt-concatenator" joins text, "video-combiner"',
    'combines clips. Use "<category>-passthrough" as the model to pass an input',
    'through unchanged.',
    'Connect nodes with edges (source -> target). Downstream nodes automatically',
    'receive the upstream output.',
    'Only use model ids from this catalog (per category):',
    JSON.stringify(catalog),
    'Respond with STRICT JSON only, no markdown, matching:',
    '{"message": string, "suggestions": string[],',
    ' "workflow": {"nodes": [{"id": string, "category": string, "model": string,',
    '   "position": {"x": number, "y": number},',
    '   "input_params": {"prompt"?: string}}],',
    '  "edges": [{"source": string, "target": string}]}}',
  ].join('\n');

  const messages = [{ role: 'system', content: system }];
  for (const item of history || []) {
    if (item?.role && item?.content) {
      messages.push({ role: item.role === 'agent' ? 'assistant' : item.role, content: item.content });
    }
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

// Extract a JSON object from an LLM response, tolerating ```json fences or
// surrounding prose.
export function parseWorkflowJson(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Empty architect response.');
  }
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  if (candidate[0] !== '{') {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Architect response is not JSON.');
    candidate = candidate.slice(start, end + 1);
  }
  return JSON.parse(candidate);
}

// Validate + fill defaults so the client always receives a well-formed graph.
export function normalizeWorkflowDef(parsed) {
  const workflow = parsed?.workflow || {};
  const rawNodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const nodeIds = new Set();

  const nodes = rawNodes
    .filter((n) => n && n.id)
    .map((n, index) => {
      const category = VALID_CATEGORIES.has(n.category) ? n.category : 'text';
      nodeIds.add(n.id);
      return {
        id: String(n.id),
        category,
        model: n.model || `${category}-passthrough`,
        position: {
          x: Number(n.position?.x ?? 350),
          y: Number(n.position?.y ?? index * 200),
        },
        input_params: n.input_params || n.params || {},
        output_params: { outputs: [], resultUrl: null },
      };
    });

  const rawEdges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const edges = rawEdges
    .filter((e) => e && nodeIds.has(e.source) && nodeIds.has(e.target))
    .map((e) => ({
      source: String(e.source),
      target: String(e.target),
      sourceHandle: e.sourceHandle || null,
      targetHandle: e.targetHandle || null,
    }));

  return {
    message: typeof parsed?.message === 'string' ? parsed.message : 'Your workflow has been updated.',
    suggestions: Array.isArray(parsed?.suggestions) ? parsed.suggestions.filter((s) => typeof s === 'string') : [],
    workflow: { nodes, edges },
  };
}

// Default OpenAI-compatible chat client. Injectable for tests.
async function defaultLlm(messages, env = process.env) {
  const apiKey = env.WORKFLOW_LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      'The workflow architect needs an LLM key. Set WORKFLOW_LLM_API_KEY (and optionally WORKFLOW_LLM_BASE_URL / WORKFLOW_LLM_MODEL).'
    );
  }
  const baseUrl = (env.WORKFLOW_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = env.WORKFLOW_LLM_MODEL || 'gpt-4o-mini';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, response_format: { type: 'json_object' } }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`LLM request failed: ${data?.error?.message || response.statusText}`);
  }
  return data?.choices?.[0]?.message?.content || '';
}

// Generate a normalized workflow definition from a prompt. `llm` is injectable.
export async function generateWorkflowDef({ prompt, history = [], provider, llm = defaultLlm }) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('A prompt is required to generate a workflow.');
  }
  const catalog = buildCatalogSummary(provider);
  const messages = buildArchitectMessages({ prompt, history, catalog });
  const content = await llm(messages);
  const parsed = parseWorkflowJson(content);
  return normalizeWorkflowDef(parsed);
}
