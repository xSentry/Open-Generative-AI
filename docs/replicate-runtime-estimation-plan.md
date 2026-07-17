# Replicate runtime estimation — implementation plan

## Goal

Estimate the user-visible duration of a new Replicate prediction from completed
predictions made by this application. Replicate does not expose an ETA for a
new request, so estimates will be calculated locally from historical data.

The estimate must be based only on inputs likely to affect execution time. It
must never use prompt text, asset URLs, or other user-specific content as part
of a matching key.

## Decisions

- Track predictions at the shared Replicate runner boundary so Studio,
  workflows, agents, and Design Agent use the same telemetry mechanism.
- Use the stable catalog `model_id` as the estimate grouping key. Do not add
  the Replicate model version to the signature or lookup key: estimates always
  use the newest successful samples, so they automatically adapt after a model
  version changes.
- Store both final Replicate metrics:
  - `predict_time_seconds`: measured compute time.
  - `total_time_seconds`: end-to-end completion time, including queue/startup.
- Use `total_time_seconds` to communicate an ETA to a user. Use
  `predict_time_seconds` for diagnostics and cost/runtime analysis.
- Persist runtime-history samples only for successful terminal predictions.
  Failed, canceled, aborted, and timed-out predictions are not saved in the
  runtime-sample table and never contribute to an estimate.
- Generate a canonical, hashable runtime signature from relevant settings and
  measured input-media characteristics.

## 1. Add a runtime-signature policy

Create a provider-neutral module, for example
`modules/providers/runtime/server/signature.js`, which receives the resolved
model, submitted parameters, and optional input-media metadata.

### 1.1 Select relevant fields

Select fields in this priority order:

1. `model.runtimeFields` — explicit catalog override for exceptional models.
2. Generic matching against schema input key, title, and description.
3. Measured metadata for input image/video/audio assets.

Start with this conservative allow-list of field concepts:

- Output dimensions: `width`, `height`, `resolution`, `target_resolution`, `image_size`,
  `output_size`, `size`, `aspect_ratio`.
- Time/frame dimensions: `duration`, `seconds`, `length`, `num_frames`,
  `max_frames`, `frames`, `fps`, `frame_rate`.
- Compute quality: `steps`, `inference_steps`, `num_inference_steps`,
  `denoising_steps`, `quality`, `speed`, `mode`, `tier`, `preset`,
  `performance`.
- Multiplicity: `num_outputs`, `output_count`, `batch_size`, `num_images`,
  `samples`.

Always exclude prompt/instruction/caption/description fields, URLs, file
identifiers, raw media values, and negative prompts. Exclude `seed` by default;
add it only as an explicit model override when it selects a distinct execution
path.

### 1.2 Include measured media metadata

When source media affects runtime, add measured properties rather than URLs:

- Image: width, height, and a pixel-count bucket.
- Video: duration, width, height, FPS, and derived frame-count bucket.
- Audio: duration and sample-rate bucket where available.

Use existing upload metadata when present. Add media probing during upload only
where that metadata is not already captured. Do not block a prediction if
probing fails; omit unavailable metadata from the signature.

### 1.3 Normalize and canonicalize

Create one deterministic canonicalization function:

- Normalize strings to trimmed lowercase where enum semantics allow it.
- Convert numeric strings to numbers.
- Round or bucket continuous values (duration, dimensions, FPS) so near-equal
  requests share history. Define and test the buckets explicitly.
- Sort object keys recursively.
- Sort arrays only if their order cannot affect runtime; otherwise preserve
  order.
- Serialize with stable JSON and calculate `SHA-256` as `signature_hash`.

Persist both the canonical JSON and hash. The JSON supports debugging; the hash
supports indexed lookup.

## 2. Extend the model catalog

Add optional metadata to curated/imported Replicate model entries:

```json
{
  "runtimeFields": ["resolution", "duration", "num_frames", "steps"],
  "runtimeSignatureVersion": 1
}
```

Use generic matching for models without overrides. Add overrides only after
observing ambiguous names or material estimation errors. Increment the
signature-version if signature semantics change; it prevents mixing unlike
historical measurements.

## 3. Add persistence

Create a migration for a `provider_prediction_runtime_samples` table:

```text
id UUID primary key
provider TEXT not null
model_id TEXT not null
runtime_signature_version INTEGER not null
runtime_signature JSONB not null
signature_hash TEXT not null
prediction_id TEXT not null unique
predict_time_seconds NUMERIC
total_time_seconds NUMERIC
created_at TIMESTAMPTZ not null
started_at TIMESTAMPTZ
completed_at TIMESTAMPTZ
```

Create indexes for:

- `(provider, model_id, signature_hash, completed_at desc)`

Store only sanitized canonical signature JSON; never store prompt content,
credentials, URLs, or raw input assets in this table.

## 4. Capture lifecycle data in the Replicate runner

Refactor the shared Replicate runner to expose lifecycle callbacks or a small
prediction-tracking service:

1. After `POST /predictions`, keep the prediction ID and canonical signature
   in process memory only; do not create a runtime-history row yet.
2. While polling, do not persist intermediate responses or status updates.
3. On a successful terminal response, insert one sample containing the model
   identity, signature, prediction ID, `predict_time`, `total_time`,
   `started_at`, and `completed_at`.
4. On failure, cancellation, abort, or timeout, do not insert a sample. Log
   the operational error through the existing application paths only.

Bring the Workflow Architect and Design Agent planner’s direct prediction
callers onto the same tracker, or deliberately exclude planner calls from user
generation estimates and document that boundary.

## 5. Implement estimation

Create `estimatePredictionRuntime()` which accepts a resolved model and a
canonical signature.

Lookup order:

1. Same provider + model ID + exact signature hash.
2. Same provider + model ID + a relaxed signature that keeps the highest
   impact dimensions (output size, duration/frames, steps, quality).
3. No estimate.

For each candidate group:

- Read the newest 10 successful samples. This intentionally lets estimates
  self-heal after a Replicate model version or implementation changes, because
  newer measurements replace older behavior in the estimate window.
- Use a median or trimmed mean of `total_time_seconds`, not a plain average.
- Return sample count and a range (for example p25–p75 or min/max after
  outlier trimming), not a falsely precise single-second ETA.
- Set a minimum sample threshold (initially three). Below it, return an
  explicitly low-confidence estimate or fall back to a broader group.

## 6. Surface the estimate

Before creating a generation, calculate the estimate and return it in the
application job/generation response, for example:

```json
{
  "runtimeEstimate": {
    "seconds": 55,
    "rangeSeconds": [42, 71],
    "sampleCount": 8,
    "confidence": "medium",
    "basis": "model_exact_signature"
  }
}
```

The UI should present this as approximate (for example, “Usually 45–70
seconds”), and separately show the real lifecycle state: queued, starting,
generating, completed, or failed.

## 7. Verify and roll out

- Unit-test field selection, exclusions, media metadata extraction,
  normalization, stable ordering, bucketing, and hashing.
- Test model-specific overrides and signature-version changes.
- Test that only successful completions insert samples; failure, cancellation,
  abort, and timeout must leave no runtime-history row. Also test duplicate
  prediction IDs.
- Test estimator fallback order, outlier resistance, insufficient history, and
  self-healing behavior as the newest ten samples replace older runtimes.
- Add structured logs/metrics that compare estimated versus actual
  `total_time_seconds` by model and signature version.
- Roll out behind a feature flag. Initially collect samples without displaying
  estimates; validate accuracy and tune buckets/overrides before enabling the
  UI.
