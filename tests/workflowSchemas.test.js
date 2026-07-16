import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalWorkflow } from '../modules/workflow/server/router.js';
import {
  buildNodeSchemas,
  buildApiNodeSchemas,
  buildApiInputs,
  normalizeMediaProperties,
} from '../modules/workflow/server/schemas.js';

function ctxFor(userId = 'user-1', provider = 'replicate') {
  return { user: { id: userId }, provider, apiKey: 'r8_test' };
}

function routeCtx(path) {
  return { params: Promise.resolve({ path }) };
}

function request(url = 'http://test.local/api/workflow') {
  return new Request(url);
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

test('buildNodeSchemas exposes the required categories and passthrough models', () => {
  const schemas = buildNodeSchemas('replicate');
  assert.ok(schemas.categories);
  for (const cat of ['text', 'image', 'video', 'audio', 'api', 'utility']) {
    assert.ok(schemas.categories[cat], `missing category ${cat}`);
    assert.ok(schemas.categories[cat].models, `missing models for ${cat}`);
  }

  // Passthrough entries the builder falls back to when no model is selected.
  assert.ok(schemas.categories.text.models['text-passthrough']);
  assert.ok(schemas.categories.image.models['image-passthrough']);
  assert.ok(schemas.categories.video.models['video-passthrough']);
  assert.ok(schemas.categories.audio.models['audio-passthrough']);

  // Utility models drive concat / video-combiner nodes.
  assert.ok(schemas.categories.utility.models['prompt-concatenator']);
  assert.ok(schemas.categories.utility.models['video-combiner']);
  assert.ok(schemas.categories.utility.models['video-frame-extractor']);
  assert.equal(schemas.categories.utility.models['prompt-concatenator'].workflow.node_type, 'concatNode');
  assert.equal(schemas.categories.utility.models['video-combiner'].workflow.node_type, 'vidConcatNode');
  assert.equal(schemas.categories.utility.models['video-frame-extractor'].workflow.node_type, 'utilityNode');
  assert.equal(schemas.categories.utility.models['video-frame-extractor'].workflow.output_type, 'image_url');
  assert.equal(schemas.categories.utility.models['video-frame-extractor'].workflow.output_label, 'Image');

  // API models keys gate which apiNodeModels the UI shows.
  assert.deepEqual(
    Object.keys(schemas.categories.api.models).sort(),
    ['genvr', 'runware', 'straico', 'wavespeed']
  );
});

test('node-schemas nests media fields under schemas.input_data.properties', () => {
  const schemas = buildNodeSchemas('replicate');
  const passthrough = schemas.categories.image.models['image-passthrough'];
  const props = passthrough.input_schema?.schemas?.input_data?.properties;
  assert.ok(props && typeof props === 'object');
  assert.ok(props.image_url, 'image passthrough should expose image_url');
});

test('node-schemas keeps api/prompt-concatenator input_schema as a plain properties map', () => {
  const schemas = buildNodeSchemas('replicate');
  const wavespeed = schemas.categories.api.models.wavespeed;
  // UI iterates Object.entries(input_schema) directly for api models.
  assert.ok(wavespeed.input_schema.model_url);
  assert.equal(wavespeed.input_schema.schemas, undefined);

  const concat = schemas.categories.utility.models['prompt-concatenator'];
  assert.ok(concat.input_schema.prompt);
  assert.equal(concat.input_schema.schemas, undefined);

  // video-combiner however nests under schemas.input_data.properties.
  const combiner = schemas.categories.utility.models['video-combiner'];
  assert.ok(combiner.input_schema.schemas.input_data.properties.videos_list);

  const extractor = schemas.categories.utility.models['video-frame-extractor'];
  const extractorProps = extractor.input_schema.schemas.input_data.properties;
  assert.ok(extractorProps.video_url);
  assert.equal(extractorProps.video_url.required, true);
  assert.deepEqual(extractorProps.frame_mode.enum, ['First Frame', 'Last Frame', 'Custom Frame']);
  assert.equal(extractorProps.frame_mode.connectable, false);
  assert.equal(extractorProps.timestamp.format, 'text');
  assert.deepEqual(extractorProps.timestamp.visibleWhen, { field: 'frame_mode', equals: 'Custom Frame' });
  assert.equal(extractorProps.timestamp.connectable, false);
});

test('router serves node-schemas without a DB lookup', async () => {
  let called = false;
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['wf-1', 'node-schemas']),
    'GET',
    ctxFor('user-1', 'replicate'),
    { getWorkflow: async () => { called = true; return null; } }
  );
  assert.equal(response.status, 200);
  assert.equal(called, false, 'node-schemas should not hit the workflow repo');
  const body = await readJson(response);
  assert.ok(body.categories.image.models);
});

test('router api-node-schemas returns per-node envelope for apiNodes', async () => {
  const deps = {
    getWorkflow: async () => ({
      id: 'wf-1',
      nodes: [
        { id: 'api-1', category: 'api', model: 'wavespeed' },
        { id: 'img-1', category: 'image', model: 'flux-dev' },
      ],
    }),
  };
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['wf-1', 'api-node-schemas']),
    'GET',
    ctxFor('user-1'),
    deps
  );
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.ok(body.api_node_schemas['api-1']);
  assert.equal(body.api_node_schemas['img-1'], undefined);
});

test('router api-node-schemas returns 404 when workflow missing', async () => {
  const response = await handleLocalWorkflow(
    request(),
    routeCtx(['missing', 'api-node-schemas']),
    'GET',
    ctxFor('user-1'),
    { getWorkflow: async () => null }
  );
  assert.equal(response.status, 404);
});

test('api-inputs exposes only nodes flagged make_input', () => {
  const result = buildApiInputs({
    nodes: [
      { id: 'text-1', title: 'Custom Prompt', category: 'text', input_params: { make_input: true, prompt: 'hi' } },
      { id: 'img-1', category: 'image', input_params: { make_input: false } },
      { id: 'img-2', category: 'image', input_params: {} },
    ],
  });
  assert.deepEqual(Object.keys(result.input_data.properties), ['text-1']);
  assert.equal(result.input_data.properties['text-1'].default, 'hi');
  assert.equal(result.input_data.properties['text-1'].type, 'string');
  assert.equal(result.input_data.properties['text-1'].title, 'Custom Prompt');
});

test('buildApiNodeSchemas ignores non-api nodes', () => {
  const result = buildApiNodeSchemas({
    nodes: [{ id: 'x', category: 'video', model: 'foo' }],
  });
  assert.deepEqual(result.api_node_schemas, {});
});

test('normalizeMediaProperties re-keys native media inputs to generic handles', () => {
  // Shape mirrors the real nano-banana-2 Replicate entry: the image input is
  // keyed "image_input" with a `field: images_list` hint + mediaKind image.
  const model = {
    id: 'nano-banana-2',
    imageField: 'image_input',
    inputs: {
      prompt: { type: 'string' },
      image_input: { type: 'array', field: 'images_list', mediaKind: 'image' },
      aspect_ratio: { type: 'string', enum: ['1:1'] },
    },
  };
  const props = normalizeMediaProperties(model);
  // The builder shows the image handle because images_list is now present.
  assert.ok('images_list' in props, 'image input should be exposed as images_list');
  assert.ok(!('image_input' in props), 'native key should be replaced');
  assert.ok('prompt' in props && 'aspect_ratio' in props, 'other fields preserved');
});

test('normalizeMediaProperties maps single image/video/audio fields and keeps generic keys', () => {
  const model = {
    imageField: 'start_frame',
    videoField: 'src_video',
    inputs: {
      start_frame: { type: 'string', mediaKind: 'image' },   // single -> image_url
      src_video: { type: 'string' },                          // via videoField -> video_url
      audio_url: { type: 'string' },                          // already generic -> kept
    },
  };
  const props = normalizeMediaProperties(model);
  assert.ok('image_url' in props);
  assert.ok('video_url' in props);
  assert.ok('audio_url' in props);
  assert.ok(!('start_frame' in props));
  assert.ok(!('src_video' in props));
});

test('workflow schemas omit provider-managed output-token limit aliases', () => {
  const props = normalizeMediaProperties({
    inputs: {
      prompt: { type: 'string' },
      max_output_tokens: { type: 'int', default: 65535 },
      max_completion_tokens: { type: 'int' },
      max_tokens: { type: 'int' },
    },
  });

  assert.ok('prompt' in props);
  assert.equal(props.max_output_tokens, undefined);
  assert.equal(props.max_completion_tokens, undefined);
  assert.equal(props.max_tokens, undefined);
});

test('Architect text schemas do not expose completion token controls', () => {
  const schemas = buildNodeSchemas('replicate');
  const props = schemas.categories.text.models['gpt-5-6-luna']
    ?.input_schema?.schemas?.input_data?.properties;
  if (!props) return;

  assert.equal(props.max_completion_tokens, undefined);
  assert.equal(props.max_output_tokens, undefined);
  assert.equal(props.max_tokens, undefined);
});

test('replicate node-schemas expose an image handle key for image models with refs', () => {
  const schemas = buildNodeSchemas('replicate');
  const model = schemas.categories.image.models['nano-banana-2'];
  // Only assert when the catalog actually ships this model.
  if (model) {
    const props = model.input_schema.schemas.input_data.properties;
    assert.ok(
      'image_url' in props || 'images_list' in props,
      'nano-banana-2 must expose an image input handle key'
    );
  }
});

