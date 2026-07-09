---
name: upstream-merge-fork
description: Resolve upstream merge pulls for this fork. Use when running or recovering from `npm run upstream:pull`, fixing merge conflicts after upstream/main changes, or concluding an upstream merge while preserving fork-specific integrations such as Replicate provider support, custom auth/login, database migrations and persistence, S3 file storage, and background AI task workers.
---

# Upstream Merge Fork

## Goal

Merge upstream changes without regressing the fork's custom self-hosted behavior.

Prioritize preserving these fork features unless the user explicitly asks otherwise:

- Replicate provider integration, model catalog, runner, provider key selection, and provider-aware Studio/workflow routing.
- Custom auth/login/session handling and account/provider key management.
- Database integration, migrations, persisted generations, workflows, and user-scoped data.
- S3 upload/storage paths, presigned URLs, persisted generated assets, and provider file input compatibility.
- Background workers/task runners for async AI generation and workflow execution.
- Existing fork scripts such as upstream sync, database migration, Replicate import, and smoke tests.

## Workflow

1. Inspect merge state before editing:

```bash
git status
git diff --name-only --diff-filter=U
rg -n "<<<<<<<|=======|>>>>>>>" .
```

2. For each conflicted file, read both the conflicted worktree and relevant context around fork integrations:

```bash
git diff -- <file>
rg -n "replicate|Replicate|provider|auth|session|S3|workflow|generation|worker|processRun|migrate" .
```

Use `git show :2:<file>` for the fork side and `git show :3:<file>` for the upstream side when the conflict is non-trivial.

3. Resolve conflicts by combining behavior, not by blindly choosing one side:

- Keep upstream security fixes, new UI/components, new scripts, and dependency/build updates when compatible.
- Keep fork dispatch paths that choose MuAPI only for MuAPI users and local/Replicate execution otherwise.
- Keep provider-aware props such as `provider`, `modelsByMode`, and active provider API-key checks.
- Keep server-backed generation history and async/pending/failed states instead of replacing them with local-only UI behavior.
- Keep S3/public URL handling for upload flows; do not forward cookies or provider secrets to external APIs.
- Keep route-layer dependency injection where it exists so server modules remain testable.
- If upstream adds a MuAPI-only feature, gate it when Replicate cannot support it, or preserve the existing MuAPI-only tab behavior.

4. After edits, scan for remaining conflicts:

```bash
rg -n "<<<<<<<|=======|>>>>>>>" .
git diff --name-only --diff-filter=U
```

5. Validate before staging:

```bash
git diff --check
npm run build:studio
npm run build
```

Add targeted tests or smoke commands when the touched area has one, for example workflow tests or Replicate smoke checks. If a command cannot run because credentials or services are missing, report that clearly.

6. Stage only after validation passes:

```bash
git add -- <resolved-files>
git status
```

7. Conclude the merge with Git's default merge message unless the user asks for a custom message:

```bash
git commit --no-edit
git status
git rev-parse -q --verify MERGE_HEAD
```

`MERGE_HEAD` should not exist after the commit, and `git status` should no longer say "still merging".

## Review Notes

- Treat generated upstream additions as normal merge content unless they conflict with fork behavior.
- Do not revert unrelated upstream changes just because they were part of the pull.
- Do not remove the fork's provider/auth/db/S3/worker code to make conflicts easier.
- If a combined resolution breaks syntax, prefer restoring the fork side for provider-critical components and then selectively reapply compatible upstream additions.
