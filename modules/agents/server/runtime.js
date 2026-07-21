import { requireProviderOperation } from '../../providers/server/registry.js';
import * as repo from './repo.js';

function modelsForMode(adapter, mode) {
  return adapter.catalog.getModelListsSync?.()[mode] || [];
}

function pickTextModel(adapter) {
  const models = modelsForMode(adapter, 't2t');
  return models.find((model) => model.hasPrompt) || models[0] || null;
}
function resolveTextModel(adapter, modelId) {
  const models = modelsForMode(adapter, 't2t');
  const requested = modelId ? models.find((model) => model.id === modelId) : null;
  if (requested) {
    return requested;
  }
  return pickTextModel(adapter);
}

function resolveModeModel(adapter, { mode, requestedId, defaultId }) {
  const models = modelsForMode(adapter, mode);
  const requested = requestedId ? models.find((model) => model.id === requestedId) : null;
  if (requested) return requested;
  const fallback = defaultId ? models.find((model) => model.id === defaultId) : null;
  if (fallback) return fallback;
  return models.find((model) => model.hasPrompt) || models[0] || null;
}

function serializeHistory(messages = []) {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content || ''}`)
    .join('\n');
}

export const TOOL_INTENTS = {
  CHAT: 'chat',
  PROMPT_OPTIMIZE: 'prompt_optimize',
  PROMPT_CRITIQUE: 'prompt_critique',
  GENERATE_MEDIA: 'generate_media',
  EDIT_MEDIA: 'edit_media',
  ANALYZE_MEDIA: 'analyze_media',
  AMBIGUOUS: 'ambiguous',
};

const DEFAULT_BLOCKED_TOOL_INTENTS = [
  TOOL_INTENTS.PROMPT_OPTIMIZE,
  TOOL_INTENTS.PROMPT_CRITIQUE,
  TOOL_INTENTS.CHAT,
];

function normalizeIntent(intent) {
  const clean = String(intent || '').trim();
  return Object.values(TOOL_INTENTS).includes(clean) ? clean : TOOL_INTENTS.AMBIGUOUS;
}

function latestOptimizedPrompt(messages = []) {
  for (const message of [...messages].reverse()) {
    const prompt = message.optimized_prompt || message.metadata?.optimized_prompt;
    if (typeof prompt === 'string' && prompt.trim()) return prompt.trim();
  }
  return null;
}

export function extractOptimizedPrompt(content) {
  const text = String(content || '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  if (fenced?.[1]?.trim()) return fenced[1].trim();

  const heading = text.match(/(?:optimized|improved|refined)\s+prompt\s*:?\s*([\s\S]*)/i);
  if (!heading?.[1]?.trim()) return null;

  let prompt = heading[1].trim();
  if (prompt.startsWith('"')) prompt = prompt.slice(1).trimStart();
  if (prompt.endsWith('"')) prompt = prompt.slice(0, -1).trimEnd();
  return prompt.trim();
}

export function applyToolExecutionPolicy({ decision, skill }) {
  if (!decision || decision.action !== 'tool_call') return decision || { action: 'answer' };

  const config = skill?.config || {};
  const intent = normalizeIntent(decision.intent);
  const allowedIntents = Array.isArray(config.allowed_intents) ? config.allowed_intents : null;
  const blockedIntents = Array.isArray(config.blocked_intents)
    ? config.blocked_intents
    : DEFAULT_BLOCKED_TOOL_INTENTS;

  if (config.disabled_auto_call || config.auto_call_policy === 'never') {
    return {
      action: 'answer',
      intent,
      blocked_tool_call: true,
      blocked_skill_id: skill?.id || decision.skill_id || null,
      block_reason: 'Automatic tool calls are disabled for this skill.',
    };
  }

  if (allowedIntents && !allowedIntents.includes(intent)) {
    return {
      action: 'answer',
      intent,
      blocked_tool_call: true,
      blocked_skill_id: skill?.id || decision.skill_id || null,
      block_reason: `Tool intent "${intent}" is not allowed for this skill.`,
    };
  }

  if (blockedIntents.includes(intent)) {
    return {
      action: 'answer',
      intent,
      blocked_tool_call: true,
      blocked_skill_id: skill?.id || decision.skill_id || null,
      block_reason: `Tool intent "${intent}" is blocked for this skill.`,
    };
  }

  if ((config.requires_confirmation || config.auto_call_policy === 'confirm') && !decision.confirmed) {
    return {
      action: 'answer',
      intent,
      content: `I can call ${skill?.name || 'the selected tool'} for this. Should I proceed?`,
      pending_tool_call: true,
      pending_skill_id: skill?.id || decision.skill_id || null,
      reason: 'Tool call requires user confirmation.',
    };
  }

  return {
    ...decision,
    intent,
  };
}

function buildPrompt({ agent, messages, userMessage }) {
  const instructions = agent.system_prompt || agent.description || 'You are a helpful assistant.';
  const history = serializeHistory(messages);
  const optimizedPrompt = latestOptimizedPrompt(messages);
  return [
    `System instructions:\n${instructions}`,
    agent.skills?.length
      ? `Available skills:\n${agent.skills.map((skill) => {
        const detail = skill.instructions || skill.description || '';
        return `- ${skill.name}: ${detail}`;
      }).join('\n')}`
      : '',
    [
      'Tool-use policy:',
      '- Do not claim to have used a tool unless a tool result is provided in this prompt.',
      '- When the user asks to optimize, rewrite, improve, critique, or prepare a prompt, answer with the improved prompt and do not generate media.',
      '- Use the most recent optimized prompt when the user explicitly asks to generate from it.',
      '- Ask one concise clarification question when intent is ambiguous.',
    ].join('\n'),
    history ? `Conversation so far:\n${history}` : '',
    optimizedPrompt ? `Most recent optimized prompt:\n${optimizedPrompt}` : '',
    `User: ${userMessage}`,
    'Assistant:',
  ].filter(Boolean).join('\n\n');
}

function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
function toolSkills(skills = []) {
  return skills.filter((skill) => {
    const config = skill.config || {};
    return config.toolcall && (config.type === 'provider_model' || config.type === 'replicate_model');
  });
}

function toolEligibleIntent(intent) {
  return [
    TOOL_INTENTS.GENERATE_MEDIA,
    TOOL_INTENTS.EDIT_MEDIA,
    TOOL_INTENTS.ANALYZE_MEDIA,
  ].includes(normalizeIntent(intent));
}

function buildIntentClassificationPrompt({ agent, messages, userMessage }) {
  const history = serializeHistory(messages);
  const optimizedPrompt = latestOptimizedPrompt(messages);
  return [
    'Classify the user request by execution mode before any tool selection.',
    'Return only valid JSON. Do not wrap the JSON in markdown.',
    '',
    'These labels are not topic categories. They only decide whether this turn should answer in chat or produce an external tool result.',
    '',
    'Execution modes:',
    '- chat: answer in text. Use this for questions, advice, explanations, planning, writing, coding, reasoning, and any request that does not need an external tool result.',
    '- prompt_optimize: answer in text by rewriting or improving a prompt for a model, tool, workflow, or creative generation system.',
    '- prompt_critique: answer in text by evaluating a prompt or suggesting improvements without producing the rewritten final prompt.',
    '- generate_media: call a media-generation tool because the user explicitly asks to produce a new image, video, audio, or other media output now.',
    '- edit_media: call a media-editing tool because the user explicitly asks to modify an existing media asset now.',
    '- analyze_media: call or use media-analysis capability because the user explicitly asks to inspect an attached or referenced media asset.',
    '- ambiguous: the request could reasonably be either text-only help or tool execution.',
    '',
    'Critical distinctions:',
    '- Tool availability must not change the classification.',
    '- If the user asks to optimize, improve, rewrite, refine, critique, or prepare a prompt, classify as prompt_optimize or prompt_critique even when the prompt describes something a tool could create.',
    '- If the user asks for text that can later be pasted into another tool, classify as chat or prompt_optimize, not tool execution.',
    '- Classify as generate_media/edit_media/analyze_media only when the user clearly asks for that external result or operation in this turn.',
    '- If the user asks to run, execute, generate, create, render, draw, or produce using the last optimized prompt, classify as the relevant tool execution mode.',
    '',
    'Examples:',
    '{"request":"Optimize:\\n\\n<draft prompt text>","intent":"prompt_optimize","reason":"The user asks for a better prompt, not tool execution."}',
    '{"request":"Improve this prompt for a video model: <draft prompt text>","intent":"prompt_optimize","reason":"The requested output is rewritten prompt text."}',
    '{"request":"What would make this prompt better? <draft prompt text>","intent":"prompt_critique","reason":"The user asks for critique, not a tool result."}',
    '{"request":"Generate an image from this prompt: <prompt text>","intent":"generate_media","reason":"The user explicitly requests generated media now."}',
    '{"request":"Use the last optimized prompt to generate it","intent":"generate_media","reason":"The user explicitly asks to execute a prior prompt."}',
    '{"request":"Explain how this API works","intent":"chat","reason":"The user asks for a text explanation."}',
    '',
    `Agent instructions: ${agent.system_prompt || agent.description || 'You are a helpful assistant.'}`,
    history ? `Conversation:\n${history}` : '',
    optimizedPrompt ? `Most recent optimized prompt:\n${optimizedPrompt}` : '',
    `User request: ${userMessage}`,
    '',
    'Response shape:',
    '{"intent":"chat|prompt_optimize|prompt_critique|generate_media|edit_media|analyze_media|ambiguous","reason":"brief reason"}',
  ].filter(Boolean).join('\n');
}

function buildToolDecisionPrompt({ agent, messages, userMessage, tools }) {
  const history = serializeHistory(messages);
  const optimizedPrompt = latestOptimizedPrompt(messages);
  return [
    'You are deciding the user intent and whether an assistant should answer directly or call one available tool.',
    'Return only valid JSON. Do not wrap the JSON in markdown.',
    '',
    'Allowed response shapes:',
    '{"action":"answer","intent":"chat|prompt_optimize|prompt_critique|generate_media|edit_media|analyze_media|ambiguous","content":"short answer or empty string","reason":"brief reason"}',
    '{"action":"tool_call","intent":"generate_media|edit_media|analyze_media","skill_id":"exact-skill-id","arguments":{"prompt":"tool prompt"},"confirmed":false,"reason":"brief reason"}',
    '',
    'Skill availability does not imply permission to call the tool.',
    'Call a tool only when the user explicitly asks for the final external result produced by that tool.',
    'If the user asks to optimize, improve, rewrite, refine, critique, or prepare a prompt, choose action "answer" with intent "prompt_optimize" or "prompt_critique".',
    'If the user gives visual content inside an optimization request, treat it as prompt content, not as permission to generate media.',
    'If the user asks to generate from the most recent optimized prompt, call the relevant tool and use that optimized prompt as the tool prompt.',
    'If intent is mixed or ambiguous, choose action "answer" and ask one concise clarification question.',
    'If no tool is clearly needed, choose action "answer".',
    '',
    `Agent instructions: ${agent.system_prompt || agent.description || 'You are a helpful assistant.'}`,
    history ? `Conversation:\n${history}` : '',
    optimizedPrompt ? `Most recent optimized prompt:\n${optimizedPrompt}` : '',
    `User request: ${userMessage}`,
    '',
    `Available tools:\n${tools.map((skill) => JSON.stringify({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      mode: skill.config?.mode || 't2i',
      allowed_intents: skill.config?.allowed_intents || null,
      blocked_intents: skill.config?.blocked_intents || null,
      requires_explicit_user_intent: skill.config?.requires_explicit_user_intent !== false,
    })).join('\n')}`,
  ].filter(Boolean).join('\n');
}

function buildToolResultPrompt({ agent, messages, userMessage, toolRun, outputText }) {
  const history = serializeHistory(messages);
  return [
    `System instructions:\n${agent.system_prompt || agent.description || 'You are a helpful assistant.'}`,
    history ? `Conversation so far:\n${history}` : '',
    `User: ${userMessage}`,
    '',
    `Tool called: ${toolRun.skill.name}`,
    `Tool model: ${toolRun.model.name || toolRun.model.id}`,
    `Tool mode: ${toolRun.mode}`,
    `Tool result:\n${outputText || '(no textual output)'}`,
    '',
    'Assistant:',
    'Respond to the user using the tool result. Include returned URLs when they are the useful output.',
  ].filter(Boolean).join('\n\n');
}

async function classifyUserIntent({ adapter, agent, messages, userMessage, apiKey, model }) {
  const providerResult = await adapter.predictions.run({
    apiKey,
    model,
    params: { prompt: buildIntentClassificationPrompt({ agent, messages, userMessage }) },
    mode: 't2t',
    maxAttempts: 180,
    interval: 1000,
  });

  const raw = providerResult.text || providerResult.outputs?.join('\n') || '';
  const parsed = extractJsonObject(raw);
  return {
    intent: normalizeIntent(parsed?.intent),
    reason: parsed?.reason || null,
    raw,
  };
}

async function decideToolCall({ adapter, agent, messages, userMessage, apiKey, model, classifiedIntent }) {
  const tools = toolSkills(agent.skills);
  if (tools.length === 0) return { action: 'answer' };
  if (!toolEligibleIntent(classifiedIntent?.intent)) {
    return {
      action: 'answer',
      intent: normalizeIntent(classifiedIntent?.intent),
      reason: classifiedIntent?.reason || 'Classified intent does not require a tool.',
      classifier_raw: classifiedIntent?.raw || null,
    };
  }

  const providerResult = await adapter.predictions.run({
    apiKey,
    model,
    params: { prompt: buildToolDecisionPrompt({ agent, messages, userMessage, tools }) },
    mode: 't2t',
    maxAttempts: 180,
    interval: 1000,
  });

  const raw = providerResult.text || providerResult.outputs?.join('\n') || '';
  const parsed = extractJsonObject(raw);
  if (!parsed || parsed.action !== 'tool_call') {
    return {
      action: 'answer',
      intent: normalizeIntent(parsed?.intent),
      content: parsed?.content || null,
      reason: parsed?.reason || null,
      raw,
      classifier_raw: classifiedIntent?.raw || null,
    };
  }

  const skill = tools.find((item) => item.id === parsed.skill_id);
  if (!skill) {
    return {
      action: 'answer',
      intent: normalizeIntent(parsed.intent),
      reason: `Unknown skill id "${parsed.skill_id}".`,
      raw,
      classifier_raw: classifiedIntent?.raw || null,
    };
  }

  return applyToolExecutionPolicy({
    decision: {
      action: 'tool_call',
      intent: normalizeIntent(parsed.intent || classifiedIntent?.intent),
      reason: parsed.reason || null,
      raw,
      classifier_raw: classifiedIntent?.raw || null,
      skill,
      confirmed: parsed.confirmed === true,
      arguments: parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {},
    },
    skill,
  });
}

function toolDecisionMetadata(toolDecision) {
  return {
    tool_decision: {
      action: toolDecision?.action || 'answer',
      intent: normalizeIntent(toolDecision?.intent),
      reason: toolDecision?.reason || null,
      classifier_raw: toolDecision?.classifier_raw || null,
      blocked_tool_call: Boolean(toolDecision?.blocked_tool_call),
      blocked_skill_id: toolDecision?.blocked_skill_id || null,
      block_reason: toolDecision?.block_reason || null,
      pending_tool_call: Boolean(toolDecision?.pending_tool_call),
      pending_skill_id: toolDecision?.pending_skill_id || null,
    },
  };
}

function toolCallMetadata(toolRun, toolDecision, provider) {
  const status = [`Calling ${toolRun.skill.name}`];
  return {
    provider,
    skill_id: toolRun.skill.id,
    skill_name: toolRun.skill.name,
    model: toolRun.model.id,
    mode: toolRun.mode,
    toolcall: true,
    status,
    providerResult: toolRun.result,
    tool_decision: {
      action: 'tool_call',
      intent: normalizeIntent(toolDecision?.intent),
      reason: toolDecision?.reason || null,
      skill_id: toolRun.skill.id,
    },
  };
}

async function runToolSkill({ adapter, provider, skill, userMessage, apiKey, selectedToolModelId, args = {} }) {
  const config = skill.config || {};
  const mode = config.mode || 't2i';
  const model = resolveModeModel(adapter, {
    mode,
    requestedId: selectedToolModelId,
    defaultId: config.default_model,
  });
  if (!model) throw new Error(`No ${provider} model is available for skill "${skill.name}".`);

  const prompt = args.prompt || [
    skill.instructions || skill.description || `Run ${skill.name}.`,
    `User request: ${userMessage}`,
  ].filter(Boolean).join('\n\n');

  const result = await adapter.predictions.run({
    apiKey,
    model,
    params: { prompt },
    mode,
    maxAttempts: 900,
    interval: 2000,
  });

  return {
    skill,
    model,
    mode,
    result,
  };
}

function fallbackSuggestions() {
  return [
    { label: 'Refine this', prompt: 'Can you make that more specific?' },
    { label: 'Give examples', prompt: 'Can you give me a few examples?' },
  ];
}

export async function suggestAgent({ prompt }) {
  const clean = String(prompt || '').trim();
  const topic = clean.slice(0, 80) || 'Custom Assistant';
  return {
    name: topic.replace(/[.?!]+$/g, '') || 'Custom Assistant',
    description: clean || 'A helpful custom assistant.',
    system_prompt: [
      'You are a focused, practical AI assistant.',
      clean ? `Your purpose: ${clean}` : '',
      'Ask concise clarifying questions when needed, and provide actionable answers.',
    ].filter(Boolean).join('\n'),
    recommended_skill_ids: ['text-chat', 'creative-prompting'],
    welcome_message: 'How can I help?',
    initial_suggestions: [
      { label: 'Start here', prompt: clean || 'What can you help me with?' },
      { label: 'Plan a task', prompt: 'Help me break this into steps.' },
    ],
  };
}

export function realignPrompt({ currentPrompt, skills }) {
  const skillText = skills.length
    ? `\n\nConfigured skills:\n${skills.map((skill) => {
      const config = skill.config || {};
      const type = config.toolcall ? 'callable tool' : 'instruction';
      return `- ${skill.name} (${type}): ${skill.description}`;
    }).join('\n')}`
    : '';
  return [
    String(currentPrompt || '').trim() || 'You are a helpful assistant.',
    skillText.trim(),
    'Tool-use policy:',
    '- Do not call generation tools when the user asks to optimize, rewrite, improve, critique, or prepare a prompt.',
    '- For prompt optimization requests, return only the optimized prompt unless the user explicitly asks to generate.',
    '- Call media-generation tools only when the user explicitly asks for a generated media result.',
    '- If the user asks to generate from the last optimized prompt, use that optimized prompt as the tool input.',
    '- If intent is ambiguous, ask one concise clarification question.',
    'Use these capabilities only when they are relevant to the user request.',
  ].filter(Boolean).join('\n\n');
}

export async function runLocalChat({ job, agent, userMessage, apiKey, modelId, toolModelId, provider = job.provider }) {
  try {
    const adapter = requireProviderOperation(provider, 'agents');
    if (!apiKey) {
      throw new Error(`A provider credential is required for ${provider}.`);
    }

    const messages = await repo.listMessages(job.conversation_id, { userId: job.user_id });
    const model = resolveTextModel(adapter, modelId);
    if (!model) throw new Error(`No ${provider} text model is available in the local catalog.`);

    const classifiedIntent = await classifyUserIntent({ adapter, agent, messages, userMessage, apiKey, model });
    const toolDecision = await decideToolCall({
      agent,
      messages,
      userMessage,
      apiKey,
      model,
      classifiedIntent,
      adapter,
    });
    if (toolDecision.action === 'tool_call') {
      const toolRun = await runToolSkill({
        skill: toolDecision.skill,
        adapter,
        provider,
        userMessage,
        apiKey,
        selectedToolModelId: toolModelId,
        args: toolDecision.arguments,
      });
      const outputs = toolRun.result.outputs?.length
        ? toolRun.result.outputs
        : (toolRun.result.url ? [toolRun.result.url] : []);
      const outputText = outputs.join('\n');
      const finalProviderResult = await adapter.predictions.run({
        apiKey,
        model,
        params: { prompt: buildToolResultPrompt({ agent, messages, userMessage, toolRun, outputText }) },
        mode: 't2t',
        maxAttempts: 180,
        interval: 1000,
      });
      const content = finalProviderResult.text || finalProviderResult.outputs?.join('\n') || outputText
        || `Used ${toolRun.skill.name} with ${toolRun.model.name || toolRun.model.id}.`;

      await repo.addMessage({
        conversationId: job.conversation_id,
        role: 'assistant',
        content,
        metadata: {
          ...toolCallMetadata(toolRun, toolDecision, provider),
          finalModel: model.id,
          finalProviderResult,
        },
      });

      const result = {
        status: 'completed',
        is_complete: true,
        conversation_id: job.conversation_id,
        messages: [
          { type: 'pulse', content: `Calling ${toolRun.skill.name}` },
          { role: 'assistant', content },
        ],
        suggestions: fallbackSuggestions(),
      };
      await repo.completeChatJob(job.id, { result });
      return result;
    }

    if (toolDecision.content && (toolDecision.pending_tool_call || toolDecision.blocked_tool_call)) {
      const content = toolDecision.content;
      await repo.addMessage({
        conversationId: job.conversation_id,
        role: 'assistant',
        content,
        metadata: {
          model: model.id,
          tool_model: toolModelId || null,
          provider,
          ...toolDecisionMetadata(toolDecision),
        },
      });

      const result = {
        status: 'completed',
        is_complete: true,
        conversation_id: job.conversation_id,
        messages: [{ role: 'assistant', content }],
        suggestions: fallbackSuggestions(),
      };
      await repo.completeChatJob(job.id, { result });
      return result;
    }

    const prompt = buildPrompt({ agent, messages, userMessage });
    const providerResult = await adapter.predictions.run({
      apiKey,
      model,
      params: { prompt },
      mode: 't2t',
      maxAttempts: 180,
      interval: 1000,
    });

    const content = providerResult.text || providerResult.url || providerResult.outputs?.join('\n') || '';
    if (!content) throw new Error('The provider completed without returning text.');
    const optimizedPrompt = extractOptimizedPrompt(content);

    await repo.addMessage({
      conversationId: job.conversation_id,
      role: 'assistant',
      content,
      metadata: {
        model: model.id,
        tool_model: toolModelId || null,
        provider,
        ...toolDecisionMetadata(toolDecision),
        ...(optimizedPrompt ? { optimized_prompt: optimizedPrompt } : {}),
      },
    });

    const result = {
      status: 'completed',
      is_complete: true,
      conversation_id: job.conversation_id,
      messages: [{ role: 'assistant', content }],
      suggestions: fallbackSuggestions(),
    };
    await repo.completeChatJob(job.id, { result });
    return result;
  } catch (error) {
    const result = {
      status: 'failed',
      is_complete: true,
      conversation_id: job.conversation_id,
      error: error.message || 'Agent chat failed.',
      messages: [{ role: 'assistant', content: error.message || 'Agent chat failed.' }],
      suggestions: [],
    };
    await repo.completeChatJob(job.id, { result, error: result.error });
    return result;
  }
}
