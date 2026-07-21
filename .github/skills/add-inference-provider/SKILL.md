---
name: add-inference-provider
description: Add or update an inference provider in Open Generative AI through the shared provider manifest, normalized model catalog, server adapter, credential, registry, Workflow, Studio, Agents, and health infrastructure. Use when asked to integrate a provider API or SDK, expose a new provider or its models, change a provider catalog, or explain and implement the repository's provider onboarding process.
---

# Add Inference Provider

Implement providers through the shared adapter boundary. Do not add provider
branches to application routes, workers, account UI, Studio, Workflow, Agents,
or Design Agent.

Before editing, inspect the current shared contracts and reference
implementation:

- `modules/providers/core/contracts.js`;
- `modules/providers/core/publicManifest.js`;
- `modules/providers/server/createAdapter.js`;
- `modules/providers/publicRegistry.js`;
- `modules/providers/server/registry.js`;
- the Replicate manifest, catalog, and adapter.

Treat these source files and this skill as authoritative. Do not depend on
separate provider-onboarding or refactor-plan documentation.

## 1. Establish the provider contract

Determine from the request and official provider documentation:

- stable lowercase kebab-case provider ID;
- credential label, placeholder, and help URL;
- SDK or HTTP endpoint and authentication method;
- exact native model IDs;
- supported application modes;
- genuinely supported application features;
- native request, result, cancellation, and error shapes.

Use current official documentation for unstable API/SDK details. Do not claim a
feature merely because the provider has a model with a related name.

Map only repository-supported modes from
`modules/providers/core/contracts.js`. Common mappings are:

- text generation: `t2t`;
- text/image to image: `t2i`, `i2i`;
- text/image/video to video: `t2v`, `i2v`, `v2v`;
- speech/audio: `audio`, `lipsync`.

Feature implications:

- `studio`, `workflow`, and `agents` require catalog and prediction operations.
- `designAgent` is useful only when its generation modes exist; planning is
  optional and otherwise uses the existing heuristic fallback.
- `workflowArchitect` additionally requires
  `workflowArchitect.generateCreateWorkflowIr`; predictions alone are not
  sufficient.
- Specialized features such as `clipping`, `vibeMotion`, and `apps` require
  their actual transport/route implementation. Keep them false otherwise.

## 2. Add the public manifest

Create `modules/providers/<id>/manifest.js` with `publicManifest()`.

Include only public metadata:

- `id`, `label`, and `description`;
- credential UI metadata;
- complete boolean feature map;
- supported modes.

Never include credentials, authorization headers, SDK clients, server adapter
imports, or private endpoint configuration in the manifest.

## 3. Add the normalized catalog

Create `modules/providers/<id>/server/catalog.js`, or colocate a small static
catalog with the adapter when that is clearer.

Export `{ [mode]: Model[] }`. Each model must contain:

- stable application `id`;
- user-facing `name`;
- `inputs` object;
- native endpoint/model/version identifier in `endpoint` or `metadata`.

Add prompt, media, defaults, enums, ranges, and required-field metadata needed
by the generic UI. Use generic media fields such as `image_url`, `images_list`,
`video_url`, and `audio_url`; translate them to native names in the adapter.

Keep IDs unambiguous within a mode. If the same application ID exists in
multiple modes with different native endpoints, ensure saved Workflow nodes
retain `provider_mode` and always resolve with mode/category context.

## 4. Add the server adapter

Create `modules/providers/<id>/server/adapter.js`. Prefer
`createProviderAdapter()` from `modules/providers/server/createAdapter.js`.

Supply:

- `id`;
- `modelLists` or `loadModelLists`;
- `runPrediction({ apiKey, model, params, signal, onStarted })`;
- upload policy;
- optional credential validation, runtime estimation, planning, Architect, or
  transport operations only when implemented.

Translate generic catalog parameters into a fresh native request object. Do
not mutate `params`. Pass `signal` to the SDK/fetch call when supported. Call
`onStarted` once a native request ID exists.

Return either a native result recognized by `normalizePredictionResult()` or a
small shape such as:

```js
{
  id: native.id,
  text: extractedText,
  outputs: extractedUrls,
  metrics: safeUsageMetrics,
}
```

Do not return credentials, prompts, input URLs, response headers, or raw native
payloads. Convert provider failures to useful errors while preserving typed
provider errors raised by shared code.

Instantiate SDK clients with the authenticated user's `apiKey`. Never read a
provider credential from environment variables, cookies, request headers, or
another provider. The generic credential repository owns storage and lookup.

## 5. Register exactly twice

Add the manifest import and entry to
`modules/providers/publicRegistry.js`.

Add the adapter import and entry to
`modules/providers/server/registry.js`.

Do not add the provider anywhere else as a dispatch condition. Account forms,
feature visibility, Studio/Workflow execution, Agents, workers, logging, and
health reporting derive from these registries.

## 6. Handle optional capabilities

For Workflow Architect, make the provider's normalized catalog expose usable
prompt ports and model metadata. Catalog-derived Architect selection is the
default for providers without a curated profile table. Add provider-specific
curated profiles only when deterministic overrides are necessary.

For Design Agent, provide all modes declared by its tool mapping. Do not enable
it for a text-only provider merely because the provider can produce a plan.

For async APIs, poll or stream inside the adapter and honor cancellation. Keep
native job IDs as `providerRef`; application jobs remain provider-neutral.

## 7. Add runtime sampling and estimation

Implement runtime history for every new provider that backs generation. The
shared table and lookup are provider-aware, but `createProviderAdapter()` does
not record samples automatically.

Use:

- `createRuntimeSignature()` from
  `modules/providers/runtime/server/signature.js`;
- `saveRuntimeSample()` and `estimatePredictionRuntime()` from
  `modules/providers/runtime/server/samples.js`.

Build the signature from the resolved catalog model and translated/submitted
parameters. The shared signature policy excludes prompts, raw URLs, and other
user content. Save a sample after each successful prediction using native
timing metrics when available, otherwise measured wall-clock timing. Runtime
telemetry must be best-effort and must never fail a successful generation.

For every future provider, prefix the runtime sample's stored `predictionId`
with the provider ID:

```js
const runtimePredictionId = `${providerId}:${nativePredictionId}`;

await saveRuntimeSample({
  provider: providerId,
  modelId: model.id,
  signature: runtimeSignature,
  predictionId: runtimePredictionId,
  predictTimeSeconds,
  totalTimeSeconds,
  createdAt,
  startedAt,
  completedAt,
});
```

This prefix is mandatory because the current database constraint treats
`prediction_id` as globally unique. Keep `providerRef` and external API output
as the native provider ID; prefix only the ID stored in runtime history. Do not
change or migrate Replicate's existing unprefixed runtime sample IDs.

Expose provider-scoped estimation through the adapter and always pass the
provider explicitly:

```js
runtime: {
  estimate({ model, params }) {
    return estimatePredictionRuntime({
      provider: providerId,
      model,
      signature: createRuntimeSignature({ model, params }),
    });
  },
},
```

Do not prefix the runtime signature hash or model ID: runtime queries already
scope those by the separate `provider` column. If a provider returns no native
prediction ID, create one stable ID once per prediction call and store it with
the provider prefix.

## 8. Preserve boundaries

- Do not edit frozen MuAPI integration code.
- Do not add provider-specific credential columns or migrations.
- Do not add fallback to Replicate, MuAPI, or any other provider.
- Do not import server adapters from client/public modules.
- Do not add concrete provider imports under provider-neutral runtime paths.
- Do not broaden a manifest beyond the adapter operations that exist.

If application-layer edits appear necessary, first determine whether the
missing concept belongs in the shared contract, catalog metadata, adapter
factory, or registry. Extend the shared abstraction only when it benefits
future providers too.

## 9. Verify

Install an SDK dependency only when the adapter uses it, preserving the lock
file. Then run:

```bash
npm run check:providers
npm run check:provider-boundaries
npm run build
```

Run relevant existing tests for affected shared behavior. Add a new broad
provider test matrix only when the user requests tests; do not skip the
existing regression suite when risk warrants it.

Confirm before handoff:

- the provider appears in `/api/providers` and account settings via its
  manifest;
- an unknown provider is still rejected explicitly;
- the catalog loads and reports the expected model count;
- enabled features have the operations required by registry validation;
- normalized results contain no raw provider payload or secrets;
- successful predictions save provider-prefixed runtime sample IDs;
- `runtime.estimate()` passes the new provider ID explicitly;
- no central route, worker, or account component contains the new provider ID.

Report the provider's enabled feature/mode matrix, files added, verification
results, and any capabilities intentionally left disabled.
