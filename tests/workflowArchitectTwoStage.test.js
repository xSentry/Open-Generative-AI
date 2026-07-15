import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchitectCapabilityCatalog } from '../modules/workflow-architect/domain/capabilityCatalog.js';
import { buildArchitectNodeOptionCatalog, createWorkflowPlanJsonSchema, materializeWorkflowPlanInputValues, validateWorkflowPlan } from '../modules/workflow-architect/domain/createWorkflowPlan.js';
import { buildConfigurationOptions, buildModelSelectionOptions, createModelSelectionJsonSchema, hydrateCreateWorkflowIr, materializeNodeConfiguration, validateHydratedCreateWorkflowIr, validateModelSelection } from '../modules/workflow-architect/domain/nodeConfiguration.js';
import { buildCreateWorkflowPlannerPayload, buildNodeConfigurationPayload, generateCreateWorkflowIr } from '../modules/workflow-architect/infrastructure/models/replicateStructuredModel.js';
import { compileCreateWorkflowIrToPatch } from '../modules/workflow-architect/domain/compiler.js';
import { summarizeCreateWorkflowProposal } from '../modules/workflow-architect/domain/compiler.js';
import { applyWorkflowPatch } from '../modules/workflow-domain/applyPatch.js';
import { workflowGraphToSavedPayload } from '../modules/workflow-domain/workflowAdapters.js';
import { createWorkflowGraph } from '../modules/workflow-domain/graphSchema.js';

const catalog = buildArchitectCapabilityCatalog('replicate');
const nodeOptions = buildArchitectNodeOptionCatalog(catalog);
function plan(nodes, connections, target_output, inputValues = null) { return { version: 'workflow-architect-plan/v2', operation: 'create_workflow', workflow_name: 'Generated workflow', target_output, nodes, connections, input_values: inputValues || nodes.filter((item) => item.type === 'text-input').map((item) => ({ node_id: item.id, value: `${item.title} content` })), assumptions: [] }; }
function node(id, type) { return { id, type, title: id }; }
function edge(from_id, to_id, media, order = 0, to_input = null) { return { from_id, to_id, to_input: to_input || (media === 'text' ? 'instruction' : media === 'image' ? 'source_image' : media === 'video' ? 'source_video' : 'instruction'), media, order }; }
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

test('two generated references compose into a final image with distinct editable prompts', () => {
  const raw = plan([node('subject_prompt', 'text-input'), node('subject_image', 'image-generate'), node('scene_prompt', 'text-input'), node('scene_image', 'image-generate'), node('composition_prompt', 'text-input'), node('output', 'image-compose')], [edge('subject_prompt', 'subject_image', 'text'), edge('scene_prompt', 'scene_image', 'text'), edge('composition_prompt', 'output', 'text'), edge('subject_image', 'output', 'image', 0, 'reference_images'), edge('scene_image', 'output', 'image', 1, 'reference_images')], 'image', [
    { node_id: 'subject_prompt', value: 'Realistic full-body character sheet of the described person, consistent identity, multiple views.' },
    { node_id: 'scene_prompt', value: 'Realistic exterior and interior reference sheet of the described car.' },
    { node_id: 'composition_prompt', value: 'Place the same person naturally in the driver seat of the same car, hands on the steering wheel.' },
  ]);
  assert.equal(validateWorkflowPlan(raw, { nodeOptions }).valid, true);
  const value = materializeWorkflowPlanInputValues(raw);
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

test('text transformation uses a separate system instruction and feeds the transformed result downstream', () => {
  const value = plan(
    [node('source', 'text-input'), node('refinement_instruction', 'system-instruction'), node('refined', 'text-transform'), node('image', 'image-generate')],
    [
      edge('source', 'refined', 'text', 0, 'source_text'),
      edge('refinement_instruction', 'refined', 'text', 0, 'system_instruction'),
      edge('refined', 'image', 'text'),
    ],
    'image',
    [
      { node_id: 'source', value: 'A person driving a classic car at sunset.' },
      { node_id: 'refinement_instruction', value: 'Refine the source into a detailed photorealistic cinematic image prompt while preserving its subject.' },
    ],
  );
  const validation = validateWorkflowPlan(value, { nodeOptions });
  assert.equal(validation.valid, true, validation.errors.map((item) => item.message).join('; '));
  const { configuration } = configure(materializeWorkflowPlanInputValues(value));
  const ir = hydrateCreateWorkflowIr(materializeWorkflowPlanInputValues(value), configuration, { catalog });
  assert.equal(ir.connections.some((item) => item.from_ref === 'source' && item.to_ref === 'refined' && item.to_port === 'prompt'), true);
  assert.equal(ir.connections.some((item) => item.from_ref === 'refinement_instruction' && item.to_ref === 'refined' && item.to_port === 'system_prompt'), true);
  assert.equal(ir.connections.some((item) => item.from_ref === 'refined' && item.to_ref === 'image'), true);
  assert.equal(ir.connections.some((item) => item.from_ref === 'source' && item.to_ref === 'image'), false);
  const patch = compileCreateWorkflowIrToPatch(ir, { provider: 'replicate', baseRevision: 1, catalog });
  const graph = applyWorkflowPatch(createWorkflowGraph({ workflowId: 'test', revision: 1 }), patch, { catalog });
  assert.equal(graph.nodes.find((item) => item.id === 'architect-source').exposure.makeInput, true);
  assert.equal(graph.nodes.find((item) => item.id === 'architect-refinement-instruction').exposure.makeInput, false);
  const handles = workflowGraphToSavedPayload(graph).edges.filter((item) => item.target === 'architect-refined').map((item) => item.targetHandle).sort();
  assert.deepEqual(handles, ['textInput', 'textInput4']);
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
  const { selectionOptions } = configure(value); const planner = buildCreateWorkflowPlannerPayload({ userRequest: 'x', nodeOptions }); const config = buildNodeConfigurationPayload({ userRequest: 'x', plan: value, selectionOptions });
  assert.equal(JSON.stringify(planner).includes('model_id'), false);
  assert.equal(planner.node_options_trusted.version, 'workflow-node-options/v2');
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
  ['prompt merge -> image', plan([node('aa', 'text-input'), node('bb', 'text-input'), node('merge', 'prompt-merge'), node('out', 'image-generate')], [edge('aa', 'merge', 'text', 0, 'text_fragments'), edge('bb', 'merge', 'text', 1, 'text_fragments'), edge('merge', 'out', 'text')], 'image')],
  ['video combine', plan([node('aa', 'video-input'), node('bb', 'video-input'), node('out', 'video-combine')], [edge('aa', 'out', 'video', 0, 'video_clips'), edge('bb', 'out', 'video', 1, 'video_clips')], 'video')],
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
  assert.deepEqual(handles.sort((a, b) => a.join('|').localeCompare(b.join('|'))), [
    ['architect-idea', 'architect-script', 'textOutput', 'textInput'],
    ['architect-script', 'architect-image', 'textOutput', 'imageInput'],
    ['architect-script', 'architect-output', 'textOutput', 'videoInput'],
    ['architect-image', 'architect-output', 'imageOutput', 'videoInput2'],
  ].sort((a, b) => a.join('|').localeCompare(b.join('|'))));
});

test('invalid planner output prevents configuration call', async () => {
  let calls = 0;
  await assert.rejects(() => generateCreateWorkflowIr({ userRequest: 'x', catalog, apiKey: 'key', runPrediction: async () => { calls += 1; return { version: 'bad' }; } }), (error) => error.code === 'ARCHITECT_PLAN_INVALID');
  assert.equal(calls, 3);
});

test('planner repairs with validation errors before model selection', async () => {
  let calls = 0;
  const validPlan = plan([node('prompt', 'text-input'), node('output', 'image-generate')], [edge('prompt', 'output', 'text')], 'image');
  validPlan.workflow_name = 'Repaired image workflow';
  const invalidPlan = { ...validPlan, version: 'bad', workflow_name: 'First-round image workflow' };
  const ir = await generateCreateWorkflowIr({ userRequest: 'image', catalog, apiKey: 'key', runPrediction: async (request) => {
    calls += 1;
    assert.equal(request.input.store, true);
    if (calls === 1) return { text: JSON.stringify(invalidPlan), response_id: 'resp_planner_123' };
    if (calls === 2) {
      const payload = JSON.parse(request.input.prompt);
      assert.equal(request.input.previous_response_id, 'resp_planner_123');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'invalid_plan_untrusted'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'user_request_untrusted'), false);
      assert.equal(payload.validation_issues_trusted.length > 0, true);
      assert.equal(payload.node_contracts_trusted.options.some((option) => option.type === 'image-generate'), true);
      assert.equal(request.input.json_schema.format.name, 'workflow_architect_plan_repair');
      return validPlan;
    }
    return { version: 'workflow-model-selection/v1', nodes: [{ id: 'prompt', model_id: 'text-passthrough' }, { id: 'output', model_id: 'gpt-image-2' }] };
  } });
  assert.equal(calls, 3);
  assert.equal(ir.workflow_name, 'First-round image workflow');
  assert.equal(ir.nodes.find((item) => item.ref === 'output').model_id, 'gpt-image-2');
  const summary = summarizeCreateWorkflowProposal(ir);
  assert.equal(/repair|invalid|fixed/i.test(`${summary.title} ${summary.message}`), false);
  assert.equal(/Architect-planned node roles/i.test(summary.message), false);
  assert.match(summary.message, /workflow (draft|proposal)|drafted the workflow|mapped out a workflow/i);
});

test('planner allows two chained continuation repairs and uses the immediately previous response id', async () => {
  let calls = 0;
  const validPlan = plan([node('prompt', 'text-input'), node('output', 'image-generate')], [edge('prompt', 'output', 'text')], 'image');
  const invalidInitial = { ...validPlan, version: 'bad', workflow_name: 'Twice repaired workflow' };
  const invalidRepair = { ...validPlan, connections: [{ ...validPlan.connections[0], order: 1 }] };
  const ir = await generateCreateWorkflowIr({ userRequest: 'image', catalog, apiKey: 'key', runPrediction: async (request) => {
    calls += 1;
    assert.equal(request.input.store, true);
    if (calls === 1) return { text: JSON.stringify(invalidInitial), response_id: 'resp_initial' };
    if (calls === 2) {
      assert.equal(request.input.previous_response_id, 'resp_initial');
      return { text: JSON.stringify(invalidRepair), response_id: 'resp_repair_1' };
    }
    if (calls === 3) {
      assert.equal(request.input.previous_response_id, 'resp_repair_1');
      const payload = JSON.parse(request.input.prompt);
      assert.equal(payload.validation_issues_trusted.some((item) => item.code === 'PLAN_CONNECTION_ORDER'), true);
      return { text: JSON.stringify(validPlan), response_id: 'resp_repair_2' };
    }
    return { version: 'workflow-model-selection/v1', nodes: [{ id: 'prompt', model_id: 'text-passthrough' }, { id: 'output', model_id: 'gpt-image-2' }] };
  } });
  assert.equal(calls, 4);
  assert.equal(ir.workflow_name, 'Twice repaired workflow');
});

test('planner retries repair without previous response id when provider cannot find it', async () => {
  let calls = 0;
  const validPlan = plan([node('prompt', 'text-input'), node('output', 'image-generate')], [edge('prompt', 'output', 'text')], 'image');
  const invalidPlan = { ...validPlan, version: 'bad', workflow_name: 'Fallback repaired workflow' };
  const ir = await generateCreateWorkflowIr({ userRequest: 'image', catalog, apiKey: 'key', runPrediction: async (request) => {
    calls += 1;
    assert.equal(request.input.store, true);
    if (calls === 1) return { text: JSON.stringify(invalidPlan), response_id: 'resp_missing' };
    if (calls === 2) {
      assert.equal(request.input.previous_response_id, 'resp_missing');
      const error = new Error("Previous response with id 'resp_missing' not found.");
      error.response = { error: { code: 'previous_response_not_found', param: 'previous_response_id' } };
      throw error;
    }
    if (calls === 3) {
      assert.equal(Object.prototype.hasOwnProperty.call(request.input, 'previous_response_id'), false);
      const payload = JSON.parse(request.input.prompt);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'invalid_plan_untrusted'), true);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'user_request_untrusted'), true);
      return { text: JSON.stringify(validPlan), response_id: 'resp_repair_fallback' };
    }
    return { version: 'workflow-model-selection/v1', nodes: [{ id: 'prompt', model_id: 'text-passthrough' }, { id: 'output', model_id: 'gpt-image-2' }] };
  } });
  assert.equal(calls, 4);
  assert.equal(ir.workflow_name, 'Fallback repaired workflow');
});

test('invalid configuration output is rejected before hydration or compilation', async () => {
  let calls = 0;
  await assert.rejects(() => generateCreateWorkflowIr({ userRequest: 'image', catalog, apiKey: 'key', runPrediction: async () => {
    calls += 1;
    if (calls === 1) { const value = plan([node('prompt', 'text-input'), node('output', 'image-generate')], [edge('prompt', 'output', 'text')], 'image'); value.workflow_name = 'Image'; return value; }
    return { version: 'workflow-model-selection/v1', nodes: [{ id: 'prompt', model_id: 'text-passthrough' }] };
  } }), (error) => error.code === 'ARCHITECT_CONFIGURATION_INVALID');
  assert.equal(calls, 2);
});
