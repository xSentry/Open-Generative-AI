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
- `packages/Vibe-Workflow/packages/workflow-builder/src/components/UtilityNode.jsx` - generic frontend utility node.
- `packages/Vibe-Workflow/packages/workflow-builder/src/components/NodeFlow.jsx` - save/restore/edge handling.
- `packages/Vibe-Workflow/packages/workflow-builder/src/components/NodesNavbar.jsx` - node menu routing.

In most cases, add a node by editing only `utilityNodes.js` and tests. Frontend code should not need changes unless the node needs a bespoke visual component.

## Add A New Utility Node

1. Add an entry to `UTILITY_NODE_DEFINITIONS` in `modules/workflow/server/utilityNodes.js`.
2. Use `nodeType: "utilityNode"` unless reusing an existing specialized component.
3. Declare every accepted input in `inputSchema`.
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

The frontend derives generic utility input handles from `inputSchema` property names. The executor receives resolved `params` with upstream `{{ node.outputs[0].value }}` templates already substituted by the engine.

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

Handle colors are inferred from field names and `field` metadata:

- text/prompt fields -> blue
- image/frame/swap fields -> green
- video fields -> orange
- audio fields -> yellow

## Output Storage Rules

For media outputs, return `type: "image_url"`, `"video_url"`, or `"audio_url"`. `storeNodeOutputs()` uploads the output and rewrites `value` to a signed S3 URL with a persisted `key`.

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
    video_url: { type: 'string', title: 'Video', field: 'video', name: 'video_url' },
    timestamp: { type: 'number', title: 'Timestamp Seconds', default: 0 },
    format: { type: 'string', title: 'Format', enum: ['png', 'jpg'], default: 'png' },
  },
  output: { type: 'image_url', label: 'Frame' },
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

## Validation

Add or update focused tests:

- `tests/workflowSchemas.test.js` when schema metadata or menu routing expectations change.
- `tests/workflowRunProcessor.test.js` for executor behavior and output storage.
- `tests/workflowEngine.test.js` only when graph resolution/order behavior changes.

Run at minimum:

```bash
node --test tests/workflowSchemas.test.js tests/workflowRunProcessor.test.js tests/workflowEngine.test.js
npm run build:workflow
```

## Guardrails

- Keep utility nodes provider-independent when possible.
- Do not add database migrations for static utility node registration.
- Do not edit MuAPI proxy behavior for local utility nodes.
- Preserve existing specialized nodes: `prompt-concatenator` uses `concatNode`; `video-combiner` uses `vidConcatNode`.
- Use `utilityNode` for new generic programmatic nodes.
- Keep the public output contract as `{ outputs: [{ type, value, id }] }`.
- If a pure local workflow fails before execution because no provider API key exists, inspect `runProcessor.js`; provider-key gating is separate from utility node execution.
