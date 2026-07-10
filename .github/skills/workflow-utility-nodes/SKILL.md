---
name: workflow-utility-nodes
description: Create, modify, or debug custom programmatic utility nodes for the Open Generative AI Workflow builder. Use when a request asks to add Workflow nodes that transform text, images, videos, audio, files, buffers, metadata, or other local/programmatic data, such as video frame extraction, image resizing, prompt templating, audio splitting, JSON transforms, or similar non-provider node logic.
---

# Workflow Utility Nodes

## Core Contract

Custom utility nodes live in the Workflow engine, not in Agent skills or database migrations.

Primary files:

- `modules/workflow/server/utilityNodes.js` - registry for custom utility metadata and execution.
- `modules/workflow/server/schemas.js` - exposes registered utilities through `/api/workflow/{id}/node-schemas`.
- `modules/workflow/server/nodeExecutors.js` - dispatches `category: "utility"` nodes to the registry.
- `modules/workflow/server/outputStorage.js` - uploads media outputs to S3 for all workflow nodes.
- `app/api/workflow/[[...path]]/route.js` - keeps local utility schemas visible even when a provider proxy is selected.
- `packages/Vibe-Workflow/packages/workflow-builder/src/components/UtilityNode.jsx` - generic frontend utility node.
- `packages/Vibe-Workflow/packages/workflow-builder/src/components/NodeFlow.jsx` - save/restore/edge handling.
- `packages/Vibe-Workflow/packages/workflow-builder/src/components/RenderField.jsx` - properties panel field rendering and visibility rules.
- `packages/Vibe-Workflow/packages/workflow-builder/src/components/NodesNavbar.jsx` - node menu routing.

In most cases, add a node by editing only `utilityNodes.js` and tests. Frontend code should not need changes when the generic utility UI already supports the needed schema metadata. If a node requires new generic behavior (conditional config fields, non-connectable config, auto-run, preview behavior, edge cleanup), update `UtilityNode.jsx` / `NodeFlow.jsx` once so future utility nodes inherit it.

## Add A New Utility Node

1. Add an entry to `UTILITY_NODE_DEFINITIONS` in `modules/workflow/server/utilityNodes.js`.
2. Use `nodeType: "utilityNode"` unless reusing an existing specialized component.
3. Declare every runtime parameter in `inputSchema`.
4. Declare the output media type with `output.type`.
5. Implement `execute: async ({ params }) => result`.
6. Return the standard node result shape:

```js
{
  id: newId(),
  outputs: [
    { type: 'image_url', value: someOutput, id: newId() }
  ]
}
```

Valid output types:

- `text`
- `image_url`
- `video_url`
- `audio_url`

The frontend derives generic utility input handles from connectable `inputSchema` property names. The executor receives resolved `params` with upstream `{{ node.outputs[0].value }}` templates already substituted by the engine.

## Input Schema Rules

Use schema property names that describe the runtime param the executor should receive.

Common single inputs:

```js
prompt: { type: 'string', title: 'Prompt', field: 'text' }
image_url: { type: 'string', title: 'Image', field: 'image' }
video_url: { type: 'string', title: 'Video', field: 'video' }
audio_url: { type: 'string', title: 'Audio', field: 'audio' }
```

Common list inputs:

```js
images_list: { type: 'array', items: { type: 'string' }, title: 'Images', field: 'images_list' }
videos_list: { type: 'array', items: { type: 'string' }, title: 'Videos', field: 'videos_list' }
audios_list: { type: 'array', items: { type: 'string' }, title: 'Audio Clips', field: 'audios_list' }
```

Other useful fields:

```js
timestamp: { type: 'number', title: 'Timestamp', default: 0 }
format: { type: 'string', title: 'Format', enum: ['png', 'jpg'], default: 'png' }
include_metadata: { type: 'boolean', title: 'Include Metadata', default: false }
```

Distinguish workflow inputs from local configuration:

```js
video_url: {
  type: 'string',
  title: 'Video',
  field: 'video',
  name: 'video_url',
  required: true,        // required for auto-run
},
frame_mode: {
  type: 'string',
  title: 'Frame',
  enum: ['First Frame', 'Last Frame', 'Custom Frame'],
  default: 'First Frame',
  connectable: false,   // config field, not a workflow handle
},
timestamp: {
  type: 'string',
  title: 'Timestamp',
  format: 'text',
  default: '0',
  connectable: false,
  visibleWhen: { field: 'frame_mode', equals: 'Custom Frame' },
}
```

Generic utility UI expectations:

- `connectable: false` fields appear in the properties panel but do not render graph handles.
- `visibleWhen` / `showWhen` hides fields until the referenced config value matches.
- Required connectable inputs (`required: true`) gate auto-run. If they are missing or disconnected, the node output resets to the placeholder.
- Generic utility nodes preview their output in the node body by output type (`text`, `image_url`, `video_url`, `audio_url`), not their config.
- Utility nodes should auto-run when connected input values or visible config values change.
- Utility nodes must not auto-run just because a workflow page was loaded/restored. If a node initializes with connected required inputs and an existing output, seed the auto-run signature from the restored state and keep the output. Wait until connection state is hydrated before deciding required inputs are missing, or restored outputs can be cleared during the initial render.
- Removing an edge must reset the corresponding utility input. Clearing a utility input in the config panel must remove the corresponding edge.
- The selected-node `Generate` / `Run` action must use the same schema-resolved payload path as `Run All` (`buildWorkflowPayload()` in `NodeFlow.jsx`), not raw local `formValues`. This keeps connected upstream inputs, image lists, and template refs consistent for single-node runs.

Handle colors are inferred from field names and `field` metadata:

- text/prompt fields -> blue
- image/frame/swap fields -> green
- video fields -> orange
- audio fields -> yellow

## Output Storage Rules

For media outputs, return `type: "image_url"`, `"video_url"`, or `"audio_url"`. `storeNodeOutputs()` uploads the output and rewrites `value` to a signed S3 URL with a persisted `key`.

Single-node utility runs often consume media produced by older runs. Before executing a targeted node, `runProcessor.js` must re-sign prior stored outputs from their persisted S3 `key`; do not pass stale saved presigned URLs to local tools like ffmpeg.

Supported media `value` shapes:

```js
'https://provider.example/out.png'
'C:/tmp/frame.png'
'file:///C:/tmp/frame.png'
Buffer.from(...)
new Uint8Array(...)
{ path: 'C:/tmp/frame.png' }
{ filePath: 'C:/tmp/frame.png' }
{ buffer: new Uint8Array(...), filename: 'frame.webp' }
{ body: Buffer.from(...), contentType: 'video/mp4' }
{ data: Buffer.from(...), filename: 'audio.mp3' }
```

Prefer including `filename`, `contentType`, or `mimeType` for buffer outputs so extension and content type are correct.

Text outputs are not uploaded:

```js
{ type: 'text', value: 'transformed text', id: newId() }
```

Utility media outputs are replacement-style in the generic UI. When a utility rerun succeeds, delete stale prior node-run rows via `DELETE /api/workflow/node-run/{nodeRunId}` so their S3 `output_keys` are purged. Dedupe these deletes because SSE/polling can deliver duplicate terminal events. Deleting a utility node or its current output should use the same node-run delete route, not just remove the React node.

## Example Node

Add this shape to `UTILITY_NODE_DEFINITIONS`:

```js
'uppercase-text': {
  id: 'uppercase-text',
  name: 'Uppercase Text',
  nodeType: 'utilityNode',
  inputSchema: {
    prompt: {
      type: 'string',
      title: 'Text',
      name: 'prompt',
      description: 'Text to uppercase.',
    },
  },
  output: { type: 'text', label: 'Text' },
  execute: async ({ params }) => {
    return textResult(String(params.prompt || '').toUpperCase());
  },
},
```

For media transforms, use a helper if needed and return a media output:

```js
'video-frame-extractor': {
  id: 'video-frame-extractor',
  name: 'Video Frame Extractor',
  nodeType: 'utilityNode',
  inputSchema: {
    video_url: { type: 'string', title: 'Video', field: 'video', name: 'video_url', required: true },
    frame_mode: {
      type: 'string',
      title: 'Frame',
      name: 'frame_mode',
      enum: ['First Frame', 'Last Frame', 'Custom Frame'],
      default: 'First Frame',
      connectable: false,
    },
    timestamp: {
      type: 'string',
      title: 'Timestamp',
      name: 'timestamp',
      format: 'text',
      default: '0',
      connectable: false,
      visibleWhen: { field: 'frame_mode', equals: 'Custom Frame' },
    },
  },
  output: { type: 'image_url', label: 'Image' },
  execute: async ({ params }) => {
    const framePath = await extractFrameSomehow(params.video_url, params);
    return {
      id: newId(),
      outputs: [{ type: 'image_url', value: framePath, id: newId() }],
    };
  },
},
```

Do not implement heavy binary logic inline when it becomes large. Put helper functions in a small module under `modules/workflow/server/` and import them into `utilityNodes.js`.

For binary-backed utilities:

- Prefer a small helper module under `modules/workflow/server/`.
- Fail clearly if required binaries are unavailable.
- Support explicit binary path env vars when useful (for example `FFMPEG_PATH`).
- Verify local media outputs exist and are non-empty before returning a file path.
- Strip query strings from remote URLs before deriving temp filenames.
- Document runtime package requirements. For the root Alpine Dockerfile, ffmpeg-based nodes need `RUN apk add --no-cache ffmpeg`.
- For exact last-frame extraction with ffmpeg, do not rely on `-sseof -0.001 -frames:v 1`. Seek from near the end and decode through the remaining frames with `-update 1 -f image2`, with a no-seek fallback, so the final decoded frame overwrites the image.

## Validation

Add or update focused tests:

- `tests/workflowSchemas.test.js` when schema metadata or menu routing expectations change.
- `tests/workflowRunProcessor.test.js` for executor behavior and output storage.
- `tests/workflowEngine.test.js` only when graph resolution/order behavior changes.
- `npm run build:workflow` after any workflow-builder UI/schema behavior change.

Run at minimum:

```bash
node --test tests/workflowSchemas.test.js tests/workflowRunProcessor.test.js tests/workflowEngine.test.js
npm run build:workflow
```

## Guardrails

- Keep utility nodes provider-independent when possible.
- Do not add database migrations for static utility node registration.
- Utility schemas should be exposed locally regardless of selected provider, because utility nodes are provider-independent. Be careful not to route `node-schemas` entirely through a provider proxy or local utilities disappear from the builder.
- Provider-independent schema visibility is separate from execution routing. Do not make remote provider/MuAPI execution responsible for local helper binaries or local-only utility code unless that provider runtime is explicitly designed for it.
- Preserve existing specialized nodes: `prompt-concatenator` uses `concatNode`; `video-combiner` uses `vidConcatNode`.
- Use `utilityNode` for new generic programmatic nodes.
- Keep the public output contract as `{ outputs: [{ type, value, id }] }`.
- If a pure local workflow fails before execution because no provider API key exists, inspect `runProcessor.js`; provider-key gating is separate from utility node execution.
