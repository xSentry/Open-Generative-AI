import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchitectCapabilityCatalog } from '../modules/workflow-architect/domain/capabilityCatalog.js';
import { assembleWorkflowPlan, buildArchitectNodeOptionCatalog, buildWorkflowPathCatalog, createWorkflowPlanJsonSchema, validateWorkflowPlan } from '../modules/workflow-architect/domain/createWorkflowPlan.js';
import { buildConfigurationOptions, buildModelSelectionOptions, createModelSelectionJsonSchema, hydrateCreateWorkflowIr, materializeNodeConfiguration, validateHydratedCreateWorkflowIr, validateModelSelection } from '../modules/workflow-architect/domain/nodeConfiguration.js';
import { buildCreateWorkflowPlannerPayload, buildNodeConfigurationPayload, generateCreateWorkflowIr } from '../modules/workflow-architect/infrastructure/models/replicateStructuredModel.js';
import { compileCreateWorkflowIrToPatch } from '../modules/workflow-architect/domain/compiler.js';
import { summarizeCreateWorkflowProposal } from '../modules/workflow-architect/domain/compiler.js';
import { applyWorkflowPatch } from '../modules/workflow-domain/applyPatch.js';
import { workflowGraphToSavedPayload } from '../modules/workflow-domain/workflowAdapters.js';
import { createWorkflowGraph } from '../modules/workflow-domain/graphSchema.js';

const catalog = buildArchitectCapabilityCatalog('replicate');
const nodeOptions = buildArchitectNodeOptionCatalog(catalog);
const pathCatalog = buildWorkflowPathCatalog(nodeOptions);

function plan(nodes, connections, target_output) { return { version: 'workflow-architect-plan/v1', operation: 'create_workflow', workflow_name: 'Generated workflow', target_output, nodes, connections, assumptions: [] }; }
function node(id, type) { return { id, type, title: id }; }
function edge(from_id, to_id, media) { return { from_id, to_id, media }; }
function assembly(path_id, workflow_name = 'Generated workflow', input_values = null) {
  const path = pathCatalog.paths.find((item) => item.id === path_id);
  return { version: 'workflow-architect-assembly/v1', operation: 'create_workflow', workflow_name, path_id, input_values: input_values || path.nodes.filter((item) => item.type === 'text-input').map((item) => ({ node_id: item.id, value: `${item.title} content` })), assumptions: [] };
}
function configure(value) {
  const selectionOptions = buildModelSelectionOptions(value, { catalog });
  const selection = { version: 'workflow-model-selection/v1', nodes: selectionOptions.nodes.map((option) => ({ id: option.node_id, model_id: option.models[0].model_id })) };
  const options = buildConfigurationOptions(value, selection, { catalog, userRequest: 'Create something' });
  const configuration = materializeNodeConfiguration(options);
  return { selectionOptions, selection, options, configuration };
}

test('node options come from executable catalog and preserve semantic requirements', () => {
  const types = new Map(nodeOptions.options.map((option) => [option.type, option]));
  assert.equal(types.has('image-edit'), true); assert.equal(types.get('image-edit').inputs.find((input) => input.media === 'image').required, true);
  assert.equal(types.get('image-to-video').inputs.find((input) => input.media === 'image').required, true);
  assert.equal(types.get('video-to-video').inputs.find((input) => input.media === 'video').required, true);
  assert.equal(types.get('video-combine').inputs.find((input) => input.media === 'video').min_connections, 2);
  assert.equal(types.get('video-combine').inputs.find((input) => input.media === 'video').max_connections, null);
  assert.equal(types.get('image-to-video').inputs.find((input) => input.media === 'text').max_connections, 1);
  assert.equal(typeof types.get('image-to-video').description, 'string');
  assert.equal(nodeOptions.options.some((option) => option.type === 'api'), false);
  assert.deepEqual(createWorkflowPlanJsonSchema(nodeOptions).properties.nodes.items.properties.type.enum.sort(), [...types.keys()].sort());
});

test('every backend-derived workflow path expands to a valid topology', () => {
  assert.equal(pathCatalog.paths.length > 0, true);
  for (const path of pathCatalog.paths) {
    const expanded = assembleWorkflowPlan(assembly(path.id, path.label), { pathCatalog });
    const validation = validateWorkflowPlan(expanded, { nodeOptions });
    assert.equal(validation.valid, true, `${path.id}: ${validation.errors.map((item) => item.message).join('; ')}`);
  }
});

test('two generated references compose into a final image with distinct editable prompts', () => {
  const value = assembleWorkflowPlan(assembly('generate-two-images-and-compose', 'Character in car', [
    { node_id: 'subject_prompt', value: 'Realistic full-body character sheet of the described person, consistent identity, multiple views.' },
    { node_id: 'scene_prompt', value: 'Realistic exterior and interior reference sheet of the described car.' },
    { node_id: 'composition_prompt', value: 'Place the same person naturally in the driver seat of the same car, hands on the steering wheel.' },
  ]), { pathCatalog });
  assert.equal(validateWorkflowPlan(value, { nodeOptions }).valid, true);
  assert.deepEqual(value.nodes.filter((item) => item.type === 'text-input').map((item) => item.input_value), [
    'Realistic full-body character sheet of the described person, consistent identity, multiple views.',
    'Realistic exterior and interior reference sheet of the described car.',
    'Place the same person naturally in the driver seat of the same car, hands on the steering wheel.',
  ]);
  const { configuration } = configure(value);
  const ir = hydrateCreateWorkflowIr(value, configuration, { catalog });
  const finalEdges = ir.connections.filter((item) => item.to_ref === 'output');
  assert.equal(finalEdges.filter((item) => item.to_port === 'images_list').length, 2);
  assert.equal(ir.nodes.find((item) => item.ref === 'subject_prompt').parameters.prompt.startsWith('Realistic full-body'), true);
  assert.equal(ir.nodes.find((item) => item.ref === 'scene_prompt').parameters.prompt.startsWith('Realistic exterior'), true);
  assert.equal(ir.nodes.find((item) => item.ref === 'composition_prompt').parameters.prompt.startsWith('Place the same person'), true);
});

test('planner validation rejects structural errors without repair', () => {
  const invalid = plan([node('prompt', 'text-input'), node('image', 'image-edit')], [edge('image', 'prompt', 'image'), edge('prompt', 'image', 'text')], 'image');
  const validation = validateWorkflowPlan(invalid, { nodeOptions });
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((item) => ['PLAN_CONNECTION_MEDIA', 'PLAN_REQUIRED_INPUT', 'PLAN_CYCLE'].includes(item.code)), true);
});

test('missing single inputs produce one actionable validation error', () => {
  const value = plan([node('prompt', 'text-input'), node('video', 'video-generate')], [], 'video');
  const errors = validateWorkflowPlan(value, { nodeOptions }).errors.filter((item) => item.path === 'nodes.video');
  assert.equal(errors.filter((item) => item.code === 'PLAN_REQUIRED_INPUT').length, 1);
  assert.equal(errors.some((item) => item.code === 'PLAN_INPUT_MULTIPLICITY'), false);
  assert.equal(errors[0].message.includes('(video-generate)'), true);
});

test('incompatible edges do not satisfy inputs or graph reachability', () => {
  const value = plan(
    [node('prompt', 'text-input'), node('speech', 'text-to-speech'), node('video', 'video-to-video')],
    [edge('prompt', 'speech', 'text'), edge('speech', 'video', 'audio')],
    'video',
  );
  const errors = validateWorkflowPlan(value, { nodeOptions }).errors;
  assert.equal(errors.some((item) => item.code === 'PLAN_CONNECTION_MEDIA'), true);
  assert.equal(errors.some((item) => item.code === 'PLAN_REQUIRED_INPUT' && item.path === 'nodes.video'), true);
  assert.equal(errors.some((item) => item.code === 'PLAN_NODE_DISCONNECTED' && item.path === 'nodes.video'), true);
  assert.equal(errors.some((item) => item.code === 'PLAN_NODE_DISCONNECTED' && item.path === 'nodes.speech'), true);
});

test('AI payloads expose only stage-specific safe context', () => {
  const value = plan([node('prompt', 'text-input'), node('image', 'image-generate')], [edge('prompt', 'image', 'text')], 'image');
  const { selectionOptions } = configure(value); const planner = buildCreateWorkflowPlannerPayload({ userRequest: 'x', pathCatalog }); const config = buildNodeConfigurationPayload({ userRequest: 'x', plan: value, selectionOptions });
  assert.equal(JSON.stringify(planner).includes('model_id'), false);
  assert.equal(planner.workflow_path_options_trusted.paths.every((path) => path.nodes.length > 0 && path.connections.length > 0), true);
  assert.equal(JSON.stringify(config).includes('configurable_inputs'), false);
  const imageIds = new Set(selectionOptions.nodes.find((item) => item.node_id === 'image').models.map((item) => item.model_id));
  assert.equal(imageIds.size < catalog.node_types.length, true);
});

test('curated call 2 context stays bounded without concrete configuration schemas', () => {
  const value = plan(Array.from({ length: 8 }, (_, index) => node(`video${index}`, 'video-generate')), [], 'video');
  const selectionOptions = buildModelSelectionOptions(value, { catalog });
  const payload = buildNodeConfigurationPayload({ userRequest: 'Create videos', plan: value, selectionOptions });
  const bytes = Buffer.byteLength(JSON.stringify(payload)) + Buffer.byteLength(JSON.stringify(createModelSelectionJsonSchema(value, selectionOptions)));
  assert.equal(selectionOptions.nodes.every((item) => item.models.length <= 8), true);
  assert.equal(JSON.stringify(payload).includes('configurable_inputs'), false);
  assert.equal(bytes < 10_000, true);
});

test('structured schemas use only the Replicate-supported JSON Schema subset', () => {
  const value = plan([node('prompt', 'text-input'), node('image', 'image-generate')], [edge('prompt', 'image', 'text')], 'image');
  const selectionOptions = buildModelSelectionOptions(value, { catalog });
  const schema = createModelSelectionJsonSchema(value, selectionOptions);
  const serialized = JSON.stringify(schema);
  assert.equal(/"(?:oneOf|anyOf|allOf|\$ref|uniqueItems)"/.test(serialized), false);
  function check(object) {
    if (!object || typeof object !== 'object') return;
    if (object.type === 'object') {
      assert.equal(object.additionalProperties, false);
      assert.deepEqual(new Set(object.required || []), new Set(Object.keys(object.properties || {})));
    }
    for (const child of Object.values(object)) check(child);
  }
  check(schema);
  assert.deepEqual(schema.required, ['version', 'models_by_node']);
  assert.deepEqual(schema.properties.models_by_node.required, ['prompt', 'image']);
  assert.deepEqual(schema.properties.models_by_node.properties.prompt.enum, ['text-passthrough']);
  assert.equal(schema.properties.models_by_node.properties.image.enum.includes('gpt-image-2'), true);
});

test('model selection validation enforces coverage and curated allowlists', () => {
  const value = plan([node('prompt', 'text-input'), node('image', 'image-generate')], [edge('prompt', 'image', 'text')], 'image'); const { selectionOptions, selection } = configure(value);
  assert.equal(validateModelSelection(value, selection, { selectionOptions }).valid, true);
  selection.nodes[1].model_id = 'unrelated-model';
  assert.equal(validateModelSelection(value, selection, { selectionOptions }).errors.some((item) => item.code === 'CONFIGURATION_MODEL'), true);
});

const cases = [
  ['text -> image', plan([node('text', 'text-input'), node('out', 'image-generate')], [edge('text', 'out', 'text')], 'image')],
  ['text -> video', plan([node('text', 'text-input'), node('out', 'video-generate')], [edge('text', 'out', 'text')], 'video')],
  ['text -> speech', plan([node('text', 'text-input'), node('out', 'text-to-speech')], [edge('text', 'out', 'text')], 'audio')],
  ['text + image -> edit', plan([node('text', 'text-input'), node('media', 'image-input'), node('out', 'image-edit')], [edge('text', 'out', 'text'), edge('media', 'out', 'image')], 'image')],
  ['text + image -> video', plan([node('text', 'text-input'), node('media', 'image-input'), node('out', 'image-to-video')], [edge('text', 'out', 'text'), edge('media', 'out', 'image')], 'video')],
  ['text + video -> video', plan([node('text', 'text-input'), node('media', 'video-input'), node('out', 'video-to-video')], [edge('text', 'out', 'text'), edge('media', 'out', 'video')], 'video')],
  ['prompt merge -> image', plan([node('aa', 'text-input'), node('bb', 'text-input'), node('merge', 'prompt-merge'), node('out', 'image-generate')], [edge('aa', 'merge', 'text'), edge('bb', 'merge', 'text'), edge('merge', 'out', 'text')], 'image')],
  ['video combine', plan([node('aa', 'video-input'), node('bb', 'video-input'), node('out', 'video-combine')], [edge('aa', 'out', 'video'), edge('bb', 'out', 'video')], 'video')],
  ['frame extraction', plan([node('media', 'video-input'), node('out', 'video-frame-extract')], [edge('media', 'out', 'video')], 'image')],
];

for (const [name, value] of cases) test(`hydrates, compiles, and applies ${name}`, () => {
  const planned = validateWorkflowPlan(value, { nodeOptions }); assert.equal(planned.valid, true, planned.errors.map((item) => item.message).join('; '));
  const { selectionOptions, selection, options, configuration } = configure(value); assert.equal(selectionOptions.nodes.every((item) => item.models.length > 0), true);
  assert.equal(validateModelSelection(value, selection, { selectionOptions }).valid, true);
  const ir = hydrateCreateWorkflowIr(value, configuration, { catalog }); const hydrated = validateHydratedCreateWorkflowIr(ir, { catalog }); assert.equal(hydrated.valid, true, hydrated.errors.map((item) => item.message).join('; '));
  const patch = compileCreateWorkflowIrToPatch(ir, { provider: 'replicate', baseRevision: 1, catalog });
  const graph = applyWorkflowPatch(createWorkflowGraph({ workflowId: 'test', revision: 1 }), patch, { catalog }); assert.equal(graph.nodes.length, value.nodes.length);
});

test('serializes Architect media chains with target handles used by each frontend node type', () => {
  const value = plan(
    [node('idea', 'text-input'), node('script', 'text-generate'), node('image', 'image-generate'), node('output', 'image-to-video')],
    [edge('idea', 'script', 'text'), edge('script', 'image', 'text'), edge('script', 'output', 'text'), edge('image', 'output', 'image')],
    'video'
  );
  const { configuration } = configure(value);
  const ir = hydrateCreateWorkflowIr(value, configuration, { catalog });
  const patch = compileCreateWorkflowIrToPatch(ir, { provider: 'replicate', baseRevision: 1, catalog });
  const graph = applyWorkflowPatch(createWorkflowGraph({ workflowId: 'test', revision: 1 }), patch, { catalog });
  const handles = workflowGraphToSavedPayload(graph).edges.map((item) => [item.source, item.target, item.sourceHandle, item.targetHandle]);
  assert.deepEqual(handles, [
    ['architect-idea', 'architect-script', 'textOutput', 'textInput'],
    ['architect-script', 'architect-image', 'textOutput', 'imageInput'],
    ['architect-script', 'architect-output', 'textOutput', 'videoInput'],
    ['architect-image', 'architect-output', 'imageOutput', 'videoInput2'],
  ]);
});

test('invalid planner output prevents configuration call', async () => {
  let calls = 0;
  await assert.rejects(() => generateCreateWorkflowIr({ userRequest: 'x', catalog, apiKey: 'key', runPrediction: async () => { calls += 1; return { version: 'bad' }; } }), (error) => error.code === 'ARCHITECT_PLAN_INVALID');
  assert.equal(calls, 2);
});

test('planner retries once with validation errors before model selection', async () => {
  let calls = 0;
  const validPlan = assembly('text-to-image', 'Repaired image workflow');
  const invalidPlan = { ...validPlan, version: 'bad', workflow_name: 'First-round image workflow' };
  const ir = await generateCreateWorkflowIr({ userRequest: 'image', catalog, apiKey: 'key', runPrediction: async (request) => {
    calls += 1;
    if (calls === 1) return invalidPlan;
    if (calls === 2) {
      const payload = JSON.parse(request.input.prompt);
      assert.deepEqual(payload.invalid_plan_untrusted, invalidPlan);
      assert.equal(payload.validation_errors_trusted.length > 0, true);
      assert.equal(payload.workflow_path_options_trusted.paths.some((path) => path.id === 'text-to-image'), true);
      assert.equal(request.input.json_schema.format.name, 'workflow_architect_assembly_repair');
      return validPlan;
    }
    return { version: 'workflow-model-selection/v1', nodes: [{ id: 'prompt', model_id: 'text-passthrough' }, { id: 'output', model_id: 'gpt-image-2' }] };
  } });
  assert.equal(calls, 3);
  assert.equal(ir.workflow_name, 'First-round image workflow');
  assert.equal(ir.nodes.find((item) => item.ref === 'output').model_id, 'gpt-image-2');
  const summary = summarizeCreateWorkflowProposal(ir);
  assert.equal(/repair|invalid|fixed/i.test(`${summary.title} ${summary.message}`), false);
});

test('invalid configuration output is rejected before hydration or compilation', async () => {
  let calls = 0;
  await assert.rejects(() => generateCreateWorkflowIr({ userRequest: 'image', catalog, apiKey: 'key', runPrediction: async () => {
    calls += 1;
    if (calls === 1) return assembly('text-to-image', 'Image');
    return { version: 'workflow-model-selection/v1', nodes: [{ id: 'prompt', model_id: 'text-passthrough' }] };
  } }), (error) => error.code === 'ARCHITECT_CONFIGURATION_INVALID');
  assert.equal(calls, 2);
});
