alter table auth_users
  add column if not exists preferred_provider text not null default 'replicate',
  add column if not exists muapi_api_key_encrypted text,
  add column if not exists muapi_api_key_iv text,
  add column if not exists muapi_api_key_tag text;

alter table auth_users
  drop constraint if exists auth_users_preferred_provider_check;

alter table auth_users
  add constraint auth_users_preferred_provider_check
  check (preferred_provider in ('replicate', 'muapi'));
