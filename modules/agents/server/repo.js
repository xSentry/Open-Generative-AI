import { query } from '../../db/server/db.js';

const AGENT_COLUMNS = `
  a.id, a.user_id, a.provider, a.slug, a.name, a.description, a.system_prompt,
  a.icon_url, a.theme, a.welcome_message, a.initial_suggestions,
  a.is_published, a.is_template, a.created_at, a.updated_at,
  coalesce(l.like_count, 0)::int as like_count,
  exists(select 1 from agent_likes al where al.agent_id = a.id and al.user_id = $USER_ID) as has_liked
`;

const DEFAULT_SKILLS = [
  [
    'text-chat',
    'Text Chat',
    'Answer questions and help with general text tasks.',
    'Answer general user questions using the agent instructions and conversation context.',
    { type: 'instruction', toolcall: false },
  ],
  [
    'creative-prompting',
    'Creative Prompting',
    'Improve prompts for image, video, audio, and design workflows.',
    'Help improve prompts for image, video, audio, and design generation. Return structured prompt guidance when useful.',
    { type: 'instruction', toolcall: false },
  ],
  [
    'media-analysis',
    'Media Analysis',
    'Discuss uploaded images and media references when the selected model supports them.',
    'Discuss uploaded media references and describe useful observations when media context is available.',
    { type: 'instruction', toolcall: false },
  ],
  [
    'image-generation',
    'Image Generation',
    'Generate an image when the user asks for a visual output.',
    'Use this skill when the user explicitly asks to create, draw, render, or generate an image. Summarize the result and include the generated image URL.',
    {
      type: 'replicate_model',
      mode: 't2i',
      toolcall: true,
      intent: 'generate_media',
      requires_explicit_user_intent: true,
      allowed_intents: ['generate_media'],
      blocked_intents: ['prompt_optimize', 'prompt_critique', 'chat'],
      auto_call_policy: 'explicit',
    },
  ],
];

function slugify(value) {
  const slug = String(value || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'agent';
}

function normalizeTheme(theme) {
  if (theme === undefined) return JSON.stringify('cosmic');
  return JSON.stringify(theme || 'cosmic');
}

function mapAgent(row, skills = []) {
  if (!row) return null;
  return {
    id: row.id,
    agent_id: row.slug,
    slug: row.slug,
    user_id: row.user_id,
    provider: row.provider,
    name: row.name,
    description: row.description,
    system_prompt: row.system_prompt,
    icon_url: row.icon_url,
    theme: row.theme ?? 'cosmic',
    welcome_message: row.welcome_message,
    initial_suggestions: row.initial_suggestions || [],
    is_published: row.is_published,
    is_template: row.is_template,
    is_owner: row.is_owner ?? false,
    has_liked: row.has_liked ?? false,
    like_count: row.like_count || 0,
    owner_username: row.owner_username || null,
    owner_email: row.owner_email || null,
    skills,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function agentSelect(userIdParamIndex) {
  return AGENT_COLUMNS.replace('$USER_ID', `$${userIdParamIndex}`);
}

async function skillsForAgentIds(agentIds) {
  if (!agentIds.length) return new Map();
  const result = await query(
    `select asl.agent_id, s.id, s.user_id, s.name, s.description, s.instructions, s.config, s.created_at, s.updated_at
     from agent_skill_links asl
     join agent_skills s on s.id = asl.skill_id
     where asl.agent_id = any($1::uuid[])
     order by s.name asc`,
    [agentIds]
  );
  const map = new Map();
  for (const row of result.rows) {
    if (!map.has(row.agent_id)) map.set(row.agent_id, []);
    map.get(row.agent_id).push(mapSkill(row));
  }
  return map;
}

async function ensureDefaultSkills() {
  for (const [id, name, description, instructions, config] of DEFAULT_SKILLS) {
    await query(
      `insert into agent_skills (id, name, description, instructions, config)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (id) do update
         set name = excluded.name,
             description = excluded.description,
             instructions = excluded.instructions,
             config = excluded.config,
             updated_at = now()`,
      [id, name, description, instructions, JSON.stringify(config || {})]
    );
  }
}

function mapSkill(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id || null,
    scope: row.user_id ? 'user' : 'general',
    name: row.name,
    description: row.description || '',
    instructions: row.instructions || '',
    config: row.config || {},
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function skillIdFromName(name) {
  const base = slugify(name).slice(0, 48) || 'skill';
  return `user-${base}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listSkills({ userId } = {}) {
  await ensureDefaultSkills();
  if (userId) {
    const result = await query(
      `select id, user_id, name, description, instructions, config, created_at, updated_at
       from agent_skills
       where user_id is null or user_id = $1
       order by user_id nulls first, name asc`,
      [userId]
    );
    return result.rows.map(mapSkill);
  }
  const result = await query(
    `select id, user_id, name, description, instructions, config, created_at, updated_at
     from agent_skills
     where user_id is null
     order by name asc`,
    []
  );
  return result.rows.map(mapSkill);
}

export async function listUserSkills({ userId }) {
  await ensureDefaultSkills();
  const result = await query(
    `select id, user_id, name, description, instructions, config, created_at, updated_at
     from agent_skills
     where user_id = $1
     order by updated_at desc, name asc`,
    [userId]
  );
  return result.rows.map(mapSkill);
}

export async function createUserSkill({ userId, input }) {
  const name = String(input?.name || '').trim();
  if (!name) throw new Error('Skill name is required.');
  const id = skillIdFromName(name);
  const result = await query(
    `insert into agent_skills (id, user_id, name, description, instructions, config)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     returning id, user_id, name, description, instructions, config, created_at, updated_at`,
    [
      id,
      userId,
      name,
      input?.description || '',
      input?.instructions || '',
      JSON.stringify(input?.config || { type: 'instruction', toolcall: false }),
    ]
  );
  return mapSkill(result.rows[0]);
}

export async function updateUserSkill(id, { userId, input }) {
  const result = await query(
    `update agent_skills
       set name = coalesce($3, name),
           description = coalesce($4, description),
           instructions = coalesce($5, instructions),
           config = coalesce($6::jsonb, config),
           updated_at = now()
     where id = $1 and user_id = $2
     returning id, user_id, name, description, instructions, config, created_at, updated_at`,
    [
      id,
      userId,
      input?.name ?? null,
      input?.description ?? null,
      input?.instructions ?? null,
      input?.config === undefined ? null : JSON.stringify(input.config || {}),
    ]
  );
  return mapSkill(result.rows[0]);
}

export async function deleteUserSkill(id, { userId }) {
  await query(
    `delete from agent_skill_links
     where skill_id = $1
       and exists (select 1 from agent_skills s where s.id = $1 and s.user_id = $2)`,
    [id, userId]
  );
  const result = await query(
    `delete from agent_skills
     where id = $1 and user_id = $2
     returning id`,
    [id, userId]
  );
  return Boolean(result.rows[0]);
}

export async function listTemplateAgents({ userId, provider }) {
  const result = await query(
    `select ${agentSelect(2)}, (a.user_id = $2) as is_owner, u.name as owner_username, u.email as owner_email
     from agents a
     join auth_users u on u.id = a.user_id
     left join (
       select agent_id, count(*) as like_count from agent_likes group by agent_id
     ) l on l.agent_id = a.id
     where a.provider = $1 and a.is_template = true
     order by a.updated_at desc`,
    [provider, userId]
  );
  const skillMap = await skillsForAgentIds(result.rows.map((row) => row.id));
  return result.rows.map((row) => mapAgent(row, skillMap.get(row.id) || []));
}

export async function listUserAgents({ userId, provider }) {
  const result = await query(
    `select ${agentSelect(1)}, true as is_owner
     from agents a
     left join (
       select agent_id, count(*) as like_count from agent_likes group by agent_id
     ) l on l.agent_id = a.id
     where a.user_id = $1 and a.provider = $2
     order by a.updated_at desc`,
    [userId, provider]
  );
  const skillMap = await skillsForAgentIds(result.rows.map((row) => row.id));
  return result.rows.map((row) => mapAgent(row, skillMap.get(row.id) || []));
}

export async function getAgent(identifier, { userId, provider }) {
  const result = await query(
    `select ${agentSelect(3)}, (a.user_id = $3) as is_owner, u.name as owner_username, u.email as owner_email
     from agents a
     join auth_users u on u.id = a.user_id
     left join (
       select agent_id, count(*) as like_count from agent_likes group by agent_id
     ) l on l.agent_id = a.id
     where a.provider = $1
       and (a.slug = lower($2) or a.id::text = $2)
       and (a.user_id = $3 or a.is_published = true or a.is_template = true)
     limit 1`,
    [provider, identifier, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const skillMap = await skillsForAgentIds([row.id]);
  return mapAgent(row, skillMap.get(row.id) || []);
}

async function uniqueSlug(provider, name) {
  const base = slugify(name);
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const result = await query(
      `select 1 from agents where provider = $1 and slug = $2 limit 1`,
      [provider, candidate]
    );
    if (!result.rows[0]) return candidate;
  }
  return `${base}-${Date.now()}`;
}

async function setAgentSkills(agentId, { userId, skillIds = [] }) {
  await ensureDefaultSkills();
  await query(`delete from agent_skill_links where agent_id = $1`, [agentId]);
  const cleanIds = [...new Set((skillIds || []).filter(Boolean))];
  for (const skillId of cleanIds) {
    await query(
      `insert into agent_skill_links (agent_id, skill_id)
       select $1, s.id
       from agent_skills s
       where s.id = $2 and (s.user_id is null or s.user_id = $3)
       on conflict do nothing`,
      [agentId, skillId, userId]
    );
  }
}

export async function createAgent({ userId, provider, input }) {
  const name = String(input?.name || 'Unnamed Agent').trim() || 'Unnamed Agent';
  const slug = await uniqueSlug(provider, name);
  const result = await query(
    `insert into agents (
       user_id, provider, slug, name, description, system_prompt, icon_url,
       theme, welcome_message, initial_suggestions, is_published, is_template
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12)
     returning *`,
    [
      userId,
      provider,
      slug,
      name,
      input?.description || null,
      input?.system_prompt || '',
      input?.icon_url || null,
      normalizeTheme(input?.theme),
      input?.welcome_message || null,
      JSON.stringify(input?.initial_suggestions || []),
      !!input?.is_published,
      !!input?.is_template,
    ]
  );
  await setAgentSkills(result.rows[0].id, { userId, skillIds: input?.skill_ids || [] });
  return getAgent(slug, { userId, provider });
}

export async function updateAgent(identifier, { userId, provider, input }) {
  const current = await getAgent(identifier, { userId, provider });
  if (!current || !current.is_owner) return null;
  const result = await query(
    `update agents
       set name = coalesce($4, name),
           description = coalesce($5, description),
           system_prompt = coalesce($6, system_prompt),
           icon_url = coalesce($7, icon_url),
           theme = coalesce($8::jsonb, theme),
           welcome_message = coalesce($9, welcome_message),
           initial_suggestions = coalesce($10::jsonb, initial_suggestions),
           is_published = coalesce($11, is_published),
           is_template = coalesce($12, is_template),
           updated_at = now()
     where provider = $1 and (slug = lower($2) or id::text = $2) and user_id = $3
     returning *`,
    [
      provider,
      identifier,
      userId,
      input?.name ?? null,
      input?.description ?? null,
      input?.system_prompt ?? null,
      input?.icon_url ?? null,
      input?.theme === undefined ? null : normalizeTheme(input.theme),
      input?.welcome_message ?? null,
      input?.initial_suggestions === undefined ? null : JSON.stringify(input.initial_suggestions || []),
      input?.is_published === undefined ? null : !!input.is_published,
      input?.is_template === undefined ? null : !!input.is_template,
    ]
  );
  if (!result.rows[0]) return null;
  if (input?.skill_ids) await setAgentSkills(result.rows[0].id, { userId, skillIds: input.skill_ids });
  return getAgent(result.rows[0].slug, { userId, provider });
}

export async function deleteAgent(identifier, { userId, provider }) {
  const result = await query(
    `delete from agents
     where provider = $1 and (slug = lower($2) or id::text = $2) and user_id = $3
     returning id`,
    [provider, identifier, userId]
  );
  return Boolean(result.rows[0]);
}

export async function setLike(identifier, { userId, provider, isLike }) {
  const agent = await getAgent(identifier, { userId, provider });
  if (!agent) return null;
  if (isLike) {
    await query(
      `insert into agent_likes (agent_id, user_id) values ($1, $2) on conflict do nothing`,
      [agent.id, userId]
    );
  } else {
    await query(`delete from agent_likes where agent_id = $1 and user_id = $2`, [agent.id, userId]);
  }
  const fresh = await getAgent(identifier, { userId, provider });
  return { has_liked: fresh.has_liked, like_count: fresh.like_count };
}

export async function getOrCreateConversation({ agentId, conversationId, userId, provider, title }) {
  if (conversationId) {
    const existing = await query(
      `select * from agent_conversations
       where id = $1 and agent_id = $2 and user_id = $3 and provider = $4`,
      [conversationId, agentId, userId, provider]
    );
    if (existing.rows[0]) return existing.rows[0];
  }
  const result = await query(
    `insert into agent_conversations (id, agent_id, user_id, provider, title)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
     returning *`,
    [conversationId || null, agentId, userId, provider, title || 'New Chat']
  );
  return result.rows[0];
}

export async function addMessage({ conversationId, role, content, attachments = [], metadata = {} }) {
  const result = await query(
    `insert into agent_messages (conversation_id, role, content, attachments, metadata)
     values ($1, $2, $3, $4::jsonb, $5::jsonb)
     returning *`,
    [conversationId, role, content || '', JSON.stringify(attachments || []), JSON.stringify(metadata || {})]
  );
  await query(`update agent_conversations set updated_at = now() where id = $1`, [conversationId]);
  return result.rows[0];
}

export async function listMessages(conversationId, { userId }) {
  const result = await query(
    `select m.*
     from agent_messages m
     join agent_conversations c on c.id = m.conversation_id
     where m.conversation_id = $1 and c.user_id = $2
     order by m.created_at asc`,
    [conversationId, userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    attachments: row.attachments || [],
    timestamp: row.created_at,
    ...(row.metadata || {}),
  }));
}

export async function getConversation(identifier, conversationId, { userId, provider }) {
  const agent = await getAgent(identifier, { userId, provider });
  if (!agent) return null;
  const result = await query(
    `select * from agent_conversations
     where id = $1 and agent_id = $2 and user_id = $3 and provider = $4`,
    [conversationId, agent.id, userId, provider]
  );
  if (!result.rows[0]) return null;
  return {
    id: result.rows[0].id,
    agent_id: agent.agent_id,
    created_at: result.rows[0].created_at,
    updated_at: result.rows[0].updated_at,
    history: await listMessages(conversationId, { userId }),
  };
}

export async function listUserConversations({ userId, provider }) {
  const result = await query(
    `select c.id, c.title, c.created_at, c.updated_at,
            a.slug as agent_slug, a.name as agent_name, a.icon_url as agent_icon_url,
            count(m.id)::int as message_count
     from agent_conversations c
     join agents a on a.id = c.agent_id
     left join agent_messages m on m.conversation_id = c.id
     where c.user_id = $1 and c.provider = $2
     group by c.id, a.slug, a.name, a.icon_url
     order by c.updated_at desc`,
    [userId, provider]
  );
  return result.rows;
}

export async function deleteUserConversation(conversationId, { userId, provider }) {
  const result = await query(
    `delete from agent_conversations
     where id = $1 and user_id = $2 and provider = $3
     returning id`,
    [conversationId, userId, provider]
  );
  return Boolean(result.rows[0]);
}

export async function createChatJob({ conversationId, userId, provider }) {
  const result = await query(
    `insert into agent_chat_jobs (conversation_id, user_id, provider)
     values ($1, $2, $3)
     returning *`,
    [conversationId, userId, provider]
  );
  return result.rows[0];
}

export async function completeChatJob(id, { result, error }) {
  const status = error ? 'failed' : 'completed';
  const updated = await query(
    `update agent_chat_jobs
       set status = $2, result = $3::jsonb, error = $4, updated_at = now()
     where id = $1
     returning *`,
    [id, status, result ? JSON.stringify(result) : null, error || null]
  );
  return updated.rows[0];
}

export async function getChatJob(id, { userId, provider }) {
  const result = await query(
    `select * from agent_chat_jobs where id = $1 and user_id = $2 and provider = $3`,
    [id, userId, provider]
  );
  return result.rows[0] || null;
}

export async function profile(identifier, scope) {
  const agent = await getAgent(identifier, scope);
  if (!agent) return null;
  const result = await query(
    `select count(distinct c.id)::int as total_chats,
            count(m.id)::int as total_messages
     from agent_conversations c
     left join agent_messages m on m.conversation_id = c.id
     where c.agent_id = $1`,
    [agent.id]
  );
  const recent = await query(
    `select c.id, c.title, c.updated_at
     from agent_conversations c
     where c.agent_id = $1 and c.user_id = $2
     order by c.updated_at desc limit 5`,
    [agent.id, scope.userId]
  );
  return {
    agent,
    total_chats: result.rows[0]?.total_chats || 0,
    total_messages: result.rows[0]?.total_messages || 0,
    recent_chats: recent.rows,
  };
}
