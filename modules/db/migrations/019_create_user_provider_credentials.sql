create table if not exists user_provider_credentials (
  user_id uuid not null references auth_users(id) on delete cascade,
  provider text not null,
  secret_encrypted text not null,
  secret_iv text not null,
  secret_tag text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

insert into user_provider_credentials (user_id, provider, secret_encrypted, secret_iv, secret_tag)
select id, 'replicate', replicate_api_key_encrypted, replicate_api_key_iv, replicate_api_key_tag
from auth_users
where replicate_api_key_encrypted is not null
  and replicate_api_key_iv is not null
  and replicate_api_key_tag is not null
on conflict (user_id, provider) do nothing;

insert into user_provider_credentials (user_id, provider, secret_encrypted, secret_iv, secret_tag)
select id, 'muapi', muapi_api_key_encrypted, muapi_api_key_iv, muapi_api_key_tag
from auth_users
where muapi_api_key_encrypted is not null
  and muapi_api_key_iv is not null
  and muapi_api_key_tag is not null
on conflict (user_id, provider) do nothing;

alter table auth_users drop constraint if exists auth_users_preferred_provider_check;

