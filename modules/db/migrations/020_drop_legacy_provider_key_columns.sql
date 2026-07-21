-- Finalize the provider-neutral credential migration. Re-copy first so this is
-- safe for deployments where migration 019 ran before all application
-- instances had switched to user_provider_credentials.
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

-- Abort instead of discarding any legacy credential material that was not
-- copied. This also catches incomplete encrypted triples for manual repair.
do $$
begin
  if exists (
    select 1
    from auth_users u
    where (
      u.replicate_api_key_encrypted is not null
      or u.replicate_api_key_iv is not null
      or u.replicate_api_key_tag is not null
    )
    and not exists (
      select 1
      from user_provider_credentials c
      where c.user_id = u.id and c.provider = 'replicate'
    )
  ) then
    raise exception 'Cannot drop legacy Replicate credential columns: uncopied credentials remain';
  end if;

  if exists (
    select 1
    from auth_users u
    where (
      u.muapi_api_key_encrypted is not null
      or u.muapi_api_key_iv is not null
      or u.muapi_api_key_tag is not null
    )
    and not exists (
      select 1
      from user_provider_credentials c
      where c.user_id = u.id and c.provider = 'muapi'
    )
  ) then
    raise exception 'Cannot drop legacy MuAPI credential columns: uncopied credentials remain';
  end if;
end $$;

alter table auth_users
  drop column if exists replicate_api_key_encrypted,
  drop column if exists replicate_api_key_iv,
  drop column if exists replicate_api_key_tag,
  drop column if exists muapi_api_key_encrypted,
  drop column if exists muapi_api_key_iv,
  drop column if exists muapi_api_key_tag;
