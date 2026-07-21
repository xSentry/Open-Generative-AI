import { NextResponse } from 'next/server';
import { errorResponse } from '@/modules/auth/server/errors';
import { getActiveProviderKey } from '@/modules/providers/server/providerKeys';
import { requireProviderOperation } from '@/modules/providers/server/registry';
import * as repo from '@/modules/agents/server/repo';
import { realignPrompt, runLocalChat, suggestAgent } from '@/modules/agents/server/runtime';

export const runtime = 'nodejs';

function json(body, status = 200) {
  return NextResponse.json(body, { status });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function withProvider(request, params, method) {
  let active;
  try {
    active = await getActiveProviderKey(request);
  } catch (error) {
    const { body, status } = errorResponse(error);
    return json(body, status);
  }

  const adapter = requireProviderOperation(active.provider, 'agents');
  if (adapter.transports?.agentsProxy) {
    return adapter.transports.agentsProxy(request, { params, apiKey: active.apiKey });
  }

  const slug = await params;
  const path = slug.path || [];
  const scope = { userId: active.user.id, provider: active.provider };

  try {
    return await handleLocal(request, path, method, scope, active.apiKey);
  } catch (error) {
    console.error('[agents] local route error:', error);
    return json({ error: error.message || 'Agents request failed.' }, error.status || 500);
  }
}

async function handleLocal(request, path, method, scope, apiKey) {
  if (method === 'GET' && path.join('/') === 'templates/agents') {
    return json(await repo.listTemplateAgents(scope));
  }

  if (method === 'GET' && path.join('/') === 'user/agents') {
    return json(await repo.listUserAgents(scope));
  }

  if (method === 'GET' && path.join('/') === 'user/conversations') {
    return json(await repo.listUserConversations(scope));
  }

  if (method === 'DELETE' && path.length === 3 && path[0] === 'user' && path[1] === 'conversations') {
    const deleted = await repo.deleteUserConversation(path[2], scope);
    if (!deleted) return json({ error: 'Conversation not found.' }, 404);
    return json({ deleted: true });
  }

  if (method === 'GET' && path.join('/') === 'user/skills') {
    return json(await repo.listUserSkills(scope));
  }

  if (method === 'GET' && path.length === 1 && path[0] === 'skills') {
    return json(await repo.listSkills(scope));
  }

  if (method === 'POST' && path.length === 1 && path[0] === 'skills') {
    const body = await readJson(request);
    return json(await repo.createUserSkill({ userId: scope.userId, input: body }), 201);
  }

  if (path[0] === 'skills' && path[1]) {
    if (method === 'PUT' && path.length === 2) {
      const body = await readJson(request);
      const skill = await repo.updateUserSkill(path[1], { userId: scope.userId, input: body });
      if (!skill) return json({ error: 'Skill not found or not owned.' }, 404);
      return json(skill);
    }
    if (method === 'DELETE' && path.length === 2) {
      const deleted = await repo.deleteUserSkill(path[1], { userId: scope.userId });
      if (!deleted) return json({ error: 'Skill not found or not owned.' }, 404);
      return json({ deleted: true });
    }
  }

  if (method === 'POST' && path.length === 1 && path[0] === 'suggest') {
    const body = await readJson(request);
    return json(await suggestAgent({ prompt: body?.prompt }));
  }

  if (method === 'POST' && path.length === 0) {
    const body = await readJson(request);
    return json(await repo.createAgent({ ...scope, input: body }), 201);
  }

  if (path[0] === 'by-slug' && path[1]) {
    return handleAgentRoute(request, path.slice(1), method, scope, apiKey);
  }

  if (method === 'GET' && path.length === 2 && path[1] === 'profile') {
    const profile = await repo.profile(path[0], scope);
    if (!profile) return json({ error: 'Agent not found.' }, 404);
    return json(profile);
  }

  if (method === 'GET' && path.length === 1) {
    const agent = await repo.getAgent(path[0], scope);
    if (!agent) return json({ error: 'Agent not found.' }, 404);
    return json(agent);
  }

  return json({ error: `Unknown Agents endpoint: ${method} ${path.join('/')}` }, 404);
}

async function handleAgentRoute(request, path, method, scope, apiKey) {
  const identifier = path[0];

  if (method === 'GET' && path.length === 1) {
    const agent = await repo.getAgent(identifier, scope);
    if (!agent) return json({ error: 'Agent not found.' }, 404);
    return json(agent);
  }

  if (method === 'PUT' && path.length === 1) {
    const body = await readJson(request);
    const agent = await repo.updateAgent(identifier, { ...scope, input: body });
    if (!agent) return json({ error: 'Agent not found or not owned.' }, 404);
    return json(agent);
  }

  if (method === 'DELETE' && path.length === 1) {
    const deleted = await repo.deleteAgent(identifier, scope);
    if (!deleted) return json({ error: 'Agent not found or not owned.' }, 404);
    return json({ deleted: true });
  }

  if (method === 'POST' && path[1] === 'like') {
    const url = new URL(request.url);
    const isLike = url.searchParams.get('is_like') !== 'false';
    const liked = await repo.setLike(identifier, { ...scope, isLike });
    if (!liked) return json({ error: 'Agent not found.' }, 404);
    return json(liked);
  }

  if (method === 'POST' && path[1] === 'preview-realign') {
    const body = await readJson(request);
    const skills = (await repo.listSkills(scope)).filter((skill) => (body?.new_skill_ids || []).includes(skill.id));
    return json({
      proposed_prompt: realignPrompt({ currentPrompt: body?.current_prompt, skills }),
    });
  }

  if (method === 'GET' && path.length === 2) {
    const conversation = await repo.getConversation(identifier, path[1], scope);
    if (!conversation) return json({ error: 'Conversation not found.' }, 404);
    return json(conversation);
  }

  if (method === 'POST' && path[1] === 'chat') {
    const body = await readJson(request);
    const agent = await repo.getAgent(identifier, scope);
    if (!agent) return json({ error: 'Agent not found.' }, 404);

    const userMessage = String(body?.message || '').trim();
    if (!userMessage) return json({ error: 'Message is required.' }, 400);

    const conversation = await repo.getOrCreateConversation({
      agentId: agent.id,
      conversationId: body?.conversation_id || null,
      ...scope,
      title: userMessage.slice(0, 80) || 'New Chat',
    });
    await repo.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: userMessage,
      attachments: body?.attachments || [],
    });

    const job = await repo.createChatJob({
      conversationId: conversation.id,
      ...scope,
    });
    await runLocalChat({
      job,
      agent,
      userMessage,
      apiKey,
      modelId: body?.conversation_model || body?.conversationModel || null,
      toolModelId: body?.tool_model || body?.toolModel || null,
      provider: scope.provider,
    });
    return json({ request_id: job.id, conversation_id: conversation.id });
  }

  return json({ error: `Unknown agent endpoint: ${method} by-slug/${path.join('/')}` }, 404);
}

export async function GET(request, { params }) {
  return withProvider(request, params, 'GET');
}

export async function POST(request, { params }) {
  return withProvider(request, params, 'POST');
}

export async function PUT(request, { params }) {
  return withProvider(request, params, 'PUT');
}

export async function DELETE(request, { params }) {
  return withProvider(request, params, 'DELETE');
}
