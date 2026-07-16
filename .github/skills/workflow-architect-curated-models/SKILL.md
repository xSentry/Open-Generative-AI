---
name: workflow-architect-curated-models
description: Update Workflow Architect curated Replicate model profiles. Use when adding, replacing, validating, or re-ranking entries in CURATED_MODEL_PROFILES for the AI Workflow Architect capability catalog.
---

# Workflow Architect Curated Models

## Goal

Safely update `CURATED_MODEL_PROFILES` in:

- `modules/workflow-architect/domain/capabilityCatalog.js`

The curated profile list controls which provider models the Workflow Architect may select deterministically. Do not treat it as a broad provider catalog. The LLM may request capabilities and preferences, but server code chooses concrete curated models.

## Required User Input

Before editing, identify:

- model IDs or Replicate model names to add
- target category for each model: `image`, `video`, `audio`, or `text`
- whether each category should be replaced or appended

If the user gives no model IDs or names, ask for the models to add.

If the user does not say whether the models should replace the category or be added alongside existing entries, ask:

- Replace the existing category entries
- Add these models to the existing category entries

Do not guess destructive replacement intent.

## Source Of Truth

Use the local Replicate catalog first:

- `modules/providers/replicate/data/replicate-models.json`
- `modules/providers/replicate/replicateModels.js`
- `modules/workflow/server/schemas.js`

The workflow schema IDs may differ from public model names. For example dotted public names may be normalized to hyphenated workflow IDs. Use the ID present in `buildNodeSchemas("replicate")` / `replicate-models.json` for `modelId`.

Useful local checks:

```bash
node --input-type=module -e "import models from './modules/providers/replicate/data/replicate-models.json' with { type: 'json' }; console.log(models.filter(m => m.id === 'MODEL_ID' || m.name === 'MODEL_NAME' || m.replicate?.model === 'MODEL_NAME'))"
```

```bash
node --input-type=module -e "import { buildNodeSchemas } from './modules/workflow/server/schemas.js'; const s = buildNodeSchemas('replicate'); console.log(Boolean(s.categories.CATEGORY?.models?.MODEL_ID))"
```

## Profile Fields

Each curated entry must be derived as follows.

### `modelId`

Use the workflow schema ID, not necessarily the public Replicate display name.

Example:

- public name: `gpt-5.6-luna`
- workflow ID: `gpt-5-6-luna`

### `label`

Use a concise human-readable label based on the model name/description in the local catalog or public Replicate page.

### `promptPort`

Must be an input key that exists in the local model schema.

Common values:

- image/video/text: `prompt`
- text-to-speech: often `text`

Never guess. Verify against the model's `inputs`.

### `defaultParameters`

Use only safe defaults from `replicate-models.json`.

Include a default only when:

- the input exists in the model schema
- the schema has a concrete `default`
- the key is not secret-bearing
- the key is not user identity / abuse-monitoring metadata
- the key is not a media input that should usually come from graph connections

Do not include guessed values. Do not include:

- API keys
- bearer tokens
- provider credentials
- `user_id`
- signed URLs
- media input URLs/lists
- fields with no schema default unless the user explicitly requests a safe curated value

### `qualityTier` and `speedTier`

These are curated product metadata, not fields from `replicate-models.json`.

Look up the model on Replicate or official provider documentation to classify them. Prefer official Replicate/provider pages over blogs or third-party rankings. Use browsing when local catalog descriptions are not enough.

Currently allowed tiers:

```js
speedTier: 'fast' | 'balanced'
qualityTier: 'standard' | 'high'
```

If the current tier vocabulary does not describe a model accurately, add a new tier only when there is clear source-backed reason. When adding a tier:

- update `modules/workflow-architect/domain/architectIrSchema.js` so model preferences can request it
- update `tests/workflowArchitectRoutes.test.js` tier expectations
- document the source language that justifies the new tier in the final response
- keep the tier vocabulary small and reusable across models

Base the tier on source language such as:

- fast, low-latency, high-volume, mini, flash -> usually `speedTier: 'fast'`
- higher quality, flagship, best quality, high fidelity -> usually `qualityTier: 'high'`
- lower-cost/mini variants without quality claims -> usually `qualityTier: 'standard'`
- medium speed, highest performance but slower, or general purpose -> usually `speedTier: 'balanced'`

In the final response, state that these tiers are curated labels and list the sources or local descriptions used.

## Implementation Workflow

1. Read current profile list:

```bash
Get-Content -Path modules/workflow-architect/domain/capabilityCatalog.js
```

2. Resolve each requested model in the local catalog:

- match by `id`
- match by `name`
- match by `replicate.model`
- confirm it is exposed by `buildNodeSchemas("replicate")`

3. Inspect the model `inputs` and choose:

- category
- `promptPort`
- safe `defaultParameters`

4. Browse Replicate / official provider pages when needed for speed and quality context.

5. Edit `CURATED_MODEL_PROFILES`.

6. If new `qualityTier` values are introduced, update the IR schema in:

- `modules/workflow-architect/domain/architectIrSchema.js`

7. Update tests in:

- `tests/workflowArchitectRoutes.test.js`

Required coverage:

- curated defaults exist in `replicate-models.json`
- prompt ports exist in the local schema
- speed/quality tiers match the chosen curated mapping
- active compact catalog includes the expected entries

8. Run targeted tests:

```bash
node --test tests/workflowArchitectRoutes.test.js
node --test tests/workflowSchemas.test.js
```

Run `tests/workflowDomain.test.js` too when compiler, validator, or patch behavior changes.

## Validation Snippets

Print active Architect entries:

```bash
node --input-type=module -e "import { buildArchitectCapabilityCatalog } from './modules/workflow-architect/domain/capabilityCatalog.js'; import { buildNodeSchemas } from './modules/workflow/server/schemas.js'; console.log(buildArchitectCapabilityCatalog('replicate', buildNodeSchemas('replicate')).compact.map(i => `${i.category}:${i.model_id}`))"
```

Check profile defaults against local schema:

```bash
node --input-type=module -e "import { CURATED_MODEL_PROFILES } from './modules/workflow-architect/domain/capabilityCatalog.js'; import models from './modules/providers/replicate/data/replicate-models.json' with { type: 'json' }; const byId = new Map(models.map(m => [m.id, m])); for (const p of Object.values(CURATED_MODEL_PROFILES).flat()) { const m = byId.get(p.modelId); if (!m) throw new Error(`${p.modelId} missing`); if (!m.inputs?.[p.promptPort]) throw new Error(`${p.modelId} promptPort missing`); for (const [k, v] of Object.entries(p.defaultParameters || {})) { if (!m.inputs?.[k]) throw new Error(`${p.modelId}.${k} missing`); if (Object.hasOwn(m.inputs[k], 'default') && JSON.stringify(m.inputs[k].default) !== JSON.stringify(v)) throw new Error(`${p.modelId}.${k} default mismatch`); } } console.log('ok')"
```

## Safety Rules

- Do not expose the whole Replicate catalog through `CURATED_MODEL_PROFILES`.
- Do not add API nodes here.
- Do not add secret-bearing defaults.
- Do not allow the LLM to select unchecked provider model IDs.
- Do not silently replace a category if the user only asked to add models.
- If a requested model is not present in `buildNodeSchemas("replicate")`, report that it is not currently selectable by Workflow Architect unless the schema/catalog generation is updated.
