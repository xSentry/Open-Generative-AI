-- Worker-based, S3-persisted workflow execution.
--
-- Phase 6 makes workflow runs behave like studio generations: an async worker
-- claims pending runs (so a graph finishes even if the user leaves/refreshes),
-- media node outputs are copied into our own S3 bucket, and the stored object
-- keys are tracked so they can be cleaned up when a workflow / run / node-run is
-- deleted.

-- workflow_runs: which provider the run executes against (needed by the worker
-- to resolve the user's key + pick a model runner) and, for single-node runs,
-- which node to execute (null => execute the whole graph).
alter table workflow_runs add column if not exists provider text;
alter table workflow_runs add column if not exists target_node_id text;

-- Claimable pending-run lookup for the worker loop.
create index if not exists workflow_runs_pending_idx
  on workflow_runs (created_at asc)
  where status = 'processing';

-- workflow_node_runs: the S3 object keys of the outputs stored in our bucket, so
-- deleting a node-run (or its parent workflow) can also delete the media.
alter table workflow_node_runs add column if not exists output_keys jsonb not null default '[]'::jsonb;
alter table workflow_node_runs add column if not exists completed_at timestamptz;

