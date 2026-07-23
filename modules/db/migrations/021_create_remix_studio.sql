create table if not exists remix_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth_users(id) on delete cascade,
  name text not null,
  source_asset_id uuid,
  active_video_version_id uuid,
  status text not null default 'uploading'
    check (status in ('uploading', 'preparing', 'ready', 'deleting', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists remix_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references remix_projects(id) on delete cascade,
  user_id uuid not null references auth_users(id) on delete cascade,
  kind text not null check (kind in (
    'source_video', 'playback_proxy', 'frame', 'reference_image',
    'edited_frame', 'video_output', 'thumbnail'
  )),
  object_key text not null unique,
  content_type text,
  size_bytes bigint,
  width integer,
  height integer,
  duration_seconds numeric,
  fps numeric,
  sha256 text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists remix_video_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references remix_projects(id) on delete cascade,
  parent_version_id uuid references remix_video_versions(id) on delete set null,
  video_asset_id uuid references remix_assets(id) on delete set null,
  playback_asset_id uuid references remix_assets(id) on delete set null,
  thumbnail_asset_id uuid references remix_assets(id) on delete set null,
  frame_edit_id uuid,
  scope text not null check (scope in ('original', 'whole', 'from-frame', 'range')),
  selected_timestamp_seconds numeric,
  range_start_seconds numeric,
  range_end_seconds numeric,
  provider text,
  model text,
  prompt text,
  params jsonb not null default '{}'::jsonb,
  frame_edit_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'succeeded', 'failed', 'canceled')),
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists remix_frame_edits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references remix_projects(id) on delete cascade,
  source_video_version_id uuid not null references remix_video_versions(id),
  source_frame_asset_id uuid not null references remix_assets(id),
  requested_timestamp_seconds numeric not null,
  actual_timestamp_seconds numeric not null,
  provider text not null,
  model text not null,
  mode text not null,
  prompt text,
  params jsonb not null default '{}'::jsonb,
  reference_asset_ids jsonb not null default '[]'::jsonb,
  provider_ref text,
  output_asset_id uuid references remix_assets(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'succeeded', 'failed', 'canceled')),
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table remix_video_versions
  add constraint remix_video_versions_frame_edit_fk
  foreign key (frame_edit_id) references remix_frame_edits(id) on delete set null;

alter table remix_projects
  add constraint remix_projects_source_asset_fk
  foreign key (source_asset_id) references remix_assets(id) on delete set null;

alter table remix_projects
  add constraint remix_projects_active_version_fk
  foreign key (active_video_version_id) references remix_video_versions(id) on delete set null;

create table if not exists remix_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references remix_projects(id) on delete cascade,
  user_id uuid not null references auth_users(id) on delete cascade,
  type text not null check (type in ('prepare-video', 'extract-frame', 'edit-frame', 'edit-video')),
  subject_id uuid,
  idempotency_key text,
  status text not null default 'queued'
    check (status in ('queued', 'active', 'succeeded', 'failed', 'canceled')),
  progress numeric not null default 0,
  stage text,
  attempt_count integer not null default 0,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (user_id, type, idempotency_key)
);

create index if not exists remix_projects_user_created_idx
  on remix_projects (user_id, created_at desc);
create index if not exists remix_assets_project_idx
  on remix_assets (project_id, created_at);
create index if not exists remix_frame_edits_project_idx
  on remix_frame_edits (project_id, created_at desc);
create index if not exists remix_video_versions_project_idx
  on remix_video_versions (project_id, created_at);
create index if not exists remix_jobs_project_idx
  on remix_jobs (project_id, created_at desc);
