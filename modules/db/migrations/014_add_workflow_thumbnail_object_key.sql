-- Keep the URL consumed by clients at workflow.thumbnail_key, while retaining
-- the backing object key needed to replace and delete thumbnails safely.
alter table workflows
  add column if not exists thumbnail_object_key text;

