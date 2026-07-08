create extension if not exists pgcrypto;

create table if not exists auth_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  name text not null,
  replicate_api_key_encrypted text,
  replicate_api_key_iv text,
  replicate_api_key_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists auth_users_email_lower_idx
  on auth_users (lower(email));
