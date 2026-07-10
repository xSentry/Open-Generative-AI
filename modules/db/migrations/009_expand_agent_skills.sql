-- Expand local Agent skills from name/description metadata into configurable
-- user/general skills. A null user_id means a general skill available to every
-- local-provider user. A non-null user_id means a private user skill.

alter table agent_skills
  add column if not exists user_id uuid references auth_users(id) on delete cascade,
  add column if not exists instructions text not null default '',
  add column if not exists config jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists agent_skills_user_idx
  on agent_skills (user_id, updated_at desc);

update agent_skills
set
  instructions = case id
    when 'text-chat' then 'Answer general user questions using the agent instructions and conversation context.'
    when 'creative-prompting' then 'Help improve prompts for image, video, audio, and design generation. Return structured prompt guidance when useful.'
    when 'media-analysis' then 'Discuss uploaded media references and describe useful observations when media context is available.'
    else instructions
  end,
  config = case id
    when 'text-chat' then '{"type":"instruction","toolcall":false}'::jsonb
    when 'creative-prompting' then '{"type":"instruction","toolcall":false}'::jsonb
    when 'media-analysis' then '{"type":"instruction","toolcall":false}'::jsonb
    else config
  end,
  updated_at = now()
where id in ('text-chat', 'creative-prompting', 'media-analysis');

insert into agent_skills (id, name, description, instructions, config)
values (
  'image-generation',
  'Image Generation',
  'Generate an image when the user asks for a visual output.',
  'Use this skill when the user explicitly asks to create, draw, render, or generate an image. Summarize the result and include the generated image URL.',
  '{"type":"replicate_model","mode":"t2i","toolcall":true,"intent":"generate_media","requires_explicit_user_intent":true,"allowed_intents":["generate_media"],"blocked_intents":["prompt_optimize","prompt_critique","chat"],"auto_call_policy":"explicit"}'::jsonb
)
on conflict (id) do update
set name = excluded.name,
    description = excluded.description,
    instructions = excluded.instructions,
    config = excluded.config,
    updated_at = now();
