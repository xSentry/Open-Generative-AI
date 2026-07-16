const VERSION = 'workflow-architect-plan/v2';
const OPTIONS_VERSION = 'workflow-node-options/v2';
const MEDIA = new Set(['text', 'image', 'video', 'audio']);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;
const MAX_NODES = 16;
const MAX_CONNECTIONS = 48;

export const CREATE_WORKFLOW_TYPE_META = {
  'text-input': { capability: 'text', role: 'input', label: 'Text input', description: 'Provide editable text to downstream nodes.', usage_notes: ['Use this for a user-editable prompt, instruction, idea, or script.'] },
  'system-instruction': { capability: 'text', role: 'input', expose_as_input: false, label: 'System instruction', description: 'Provide backend-authored behavior instructions to a text transformation node.', usage_notes: ['Use this only for a text-transform system_instruction connection.', 'This is an internal helper value and must never be exposed or marked as a workflow input.', 'Write an explicit operation such as: Refine the source into a detailed photorealistic image prompt.'] },
  'image-input': { capability: 'image', role: 'input', label: 'Image input', description: 'Provide one user-supplied image.', usage_notes: ['Use this only when the workflow requires an image supplied by the user.'] },
  'video-input': { capability: 'video', role: 'input', label: 'Video input', description: 'Provide one user-supplied video.', usage_notes: ['Use this only when the workflow requires a video supplied by the user.'] },
  'audio-input': { capability: 'audio', role: 'input', label: 'Audio input', description: 'Provide one user-supplied audio asset.', usage_notes: ['Use this only when the workflow requires audio supplied by the user.'] },
  'text-generate': { capability: 'text_generation', role: 'generation', label: 'Generate text', description: 'Generate text from one instruction.', usage_notes: ['Use this to develop an idea into a script, prompt, or other generated text.'] },
  'text-transform': { capability: 'text_generation', role: 'generation', label: 'Transform or refine text', description: 'Transform source text according to a separate system instruction.', usage_notes: ['Use this when refining, expanding, rewriting, summarizing, translating, or otherwise modifying existing text.', 'Connect the text to modify as source_text and a separate system-instruction node as system_instruction.', 'Downstream nodes that need the modified result must consume this node output, not the original source text.'] },
  'image-generate': { capability: 'image_generation', role: 'generation', label: 'Generate an image from text', description: 'Generate an image from one text prompt.', usage_notes: ['Use this when no source image must be preserved.'] },
  'image-edit': { capability: 'image_editing', role: 'generation', label: 'Edit an image using text', description: 'Edit one image according to one instruction.', usage_notes: ['Use this when one source image must remain the visual basis.'] },
  'image-compose': { capability: 'image_editing', role: 'generation', label: 'Compose multiple reference images', description: 'Generate one image from two or more reference images and an instruction.', usage_notes: ['Use this to combine identities, objects, or scenes from several references.'] },
  'video-generate': { capability: 'video_generation', role: 'generation', label: 'Generate a video from text', description: 'Generate a video from one prompt without source media.', usage_notes: ['Use this for prompt-only video generation.'] },
  'image-to-video': { capability: 'image_to_video', role: 'generation', label: 'Generate video from an image', description: 'Animate one source image according to a motion instruction.', usage_notes: ['Use this when a source image must remain the visual basis.', 'Do not use video-generate when a specific source image must be preserved.'] },
  'video-to-video': { capability: 'video_to_video', role: 'generation', label: 'Transform a video using text', description: 'Transform one source video according to an instruction.', usage_notes: ['Use this when an existing video must remain the temporal basis.'] },
  'text-to-speech': { capability: 'text_to_speech', role: 'generation', label: 'Generate speech from text', description: 'Generate speech audio from one text input.', usage_notes: ['Use this for narration or spoken dialogue.'] },
  'prompt-merge': { capability: 'utility_text_merge', role: 'utility', label: 'Merge multiple text prompts', description: 'Merge two or more text inputs in connection order.', usage_notes: ['Use this when independently produced text branches must become one prompt.'] },
  'video-combine': { capability: 'utility_video_combine', role: 'utility', label: 'Combine multiple videos', description: 'Combine two or more videos in connection order.', usage_notes: ['Use this to concatenate independently produced clips.'] },
  'video-frame-extract': { capability: 'utility_frame_extraction', role: 'utility', label: 'Extract a frame from video', description: 'Extract one image frame from one video.', usage_notes: ['Use this when a later image operation needs a still from a video.'] },
};

function normalizedMedia(type) { return type === 'image_url' ? 'image' : type === 'video_url' ? 'video' : type === 'audio_url' ? 'audio' : type; }
function hasInput(node, type) { return Object.values(node.input_ports || {}).some((def) => def.type === type); }
function hasRequiredInput(node, type) { return Object.values(node.input_ports || {}).some((def) => def.type === type && def.required); }
function hasManyInput(node, type) { return Object.values(node.input_ports || {}).some((def) => def.type === type && (def.cardinality === 'many' || def.maxConnections === Infinity)); }

function typesForNode(node) {
  if (node.kind === 'input') return node.category === 'text' ? ['text-input', 'system-instruction'] : [`${node.category}-input`];
  if (node.category === 'image') return [...(!hasRequiredInput(node, 'image_url') ? ['image-generate'] : []), ...(hasInput(node, 'image_url') ? ['image-edit'] : []), ...(hasManyInput(node, 'image_url') ? ['image-compose'] : [])];
  if (node.category === 'video') return [...(!hasRequiredInput(node, 'image_url') && !hasRequiredInput(node, 'video_url') ? ['video-generate'] : []), ...(hasInput(node, 'image_url') ? ['image-to-video'] : []), ...(hasInput(node, 'video_url') ? ['video-to-video'] : [])];
  const matching = Object.entries(CREATE_WORKFLOW_TYPE_META).filter(([, meta]) => meta.capability === node.capability).map(([type]) => type);
  return matching.filter((type) => type !== 'text-transform' || Boolean(node.input_ports?.system_prompt || node.input_ports?.system_instruction));
}

export function semanticInputs(type) {
  if (type.endsWith('-input') || type === 'system-instruction') return [];
  const one = (key, media, usage, alternative = 'Invalid: this input is required.') => ({ key, media, required: true, min_connections: 1, max_connections: 1, usage, omission_behavior: alternative, connection_order_matters: false, conditions: [] });
  if (type === 'text-transform') return [one('source_text', 'text', 'Provides the existing text to modify.'), one('system_instruction', 'text', 'Tells the model exactly how to transform the source text, for example: Refine this into a detailed photorealistic image prompt.')];
  if (type === 'image-edit') return [one('instruction', 'text', 'Describes the requested edit.'), one('source_image', 'image', 'Provides the image to edit.')];
  if (type === 'image-compose') return [one('instruction', 'text', 'Describes how to combine the references.'), { key: 'reference_images', media: 'image', required: true, min_connections: 2, max_connections: null, usage: 'Provides the reference images to combine.', omission_behavior: 'Invalid: at least two references are required.', connection_order_matters: true, conditions: [] }];
  if (type === 'image-to-video') return [one('instruction', 'text', 'Describes motion, camera behavior, and temporal changes.'), one('source_image', 'image', 'Provides the source appearance that the video must preserve.', 'Invalid: use video-generate for a prompt-only video instead.')];
  if (type === 'video-to-video') return [one('instruction', 'text', 'Describes the transformation.'), one('source_video', 'video', 'Provides the source video to transform.')];
  if (type === 'prompt-merge') return [{ key: 'text_fragments', media: 'text', required: true, min_connections: 2, max_connections: null, usage: 'Provides text fragments to merge.', omission_behavior: 'Invalid: at least two text inputs are required.', connection_order_matters: true, conditions: [] }];
  if (type === 'video-combine') return [{ key: 'video_clips', media: 'video', required: true, min_connections: 2, max_connections: null, usage: 'Provides clips to concatenate.', omission_behavior: 'Invalid: at least two videos are required.', connection_order_matters: true, conditions: [] }];
  if (type === 'video-frame-extract') return [one('source_video', 'video', 'Provides the video from which to extract a frame.')];
  return [one('instruction', 'text', type === 'text-to-speech' ? 'Provides the text to speak.' : 'Provides the prompt or generation instruction.')];
}

export function buildArchitectNodeOptionCatalog(catalog = {}) {
  const byType = new Map();
  for (const node of catalog.node_types || []) {
    if (node.architect_enabled === false || node.execution_support?.executable === false || node.category === 'api') continue;
    for (const type of typesForNode(node)) {
      const meta = CREATE_WORKFLOW_TYPE_META[type];
      if (!meta) continue;
      const outputs = [...new Set(Object.values(node.output_ports || {}).map((def) => normalizedMedia(def.type)).filter((value) => MEDIA.has(value)))];
      if (!outputs.length) continue;
      if (!byType.has(type)) byType.set(type, { type, role: meta.role, label: meta.label, description: meta.description, usage_notes: meta.usage_notes, inputs: semanticInputs(type), outputs: outputs.map((output) => ({ media: output, description: `${meta.label} ${output} output.` })) });
    }
  }
  return { version: OPTIONS_VERSION, options: [...byType.values()] };
}

export function createWorkflowPlanJsonSchema(nodeOptions) {
  const types = (nodeOptions?.options || []).map((option) => option.type);
  const semanticInputKeys = [...new Set((nodeOptions?.options || []).flatMap((option) => (option.inputs || []).map((input) => input.key)))].sort();
  return { type: 'object', additionalProperties: false, required: ['version', 'operation', 'workflow_name', 'target_output', 'nodes', 'connections', 'input_values', 'assumptions'], properties: {
    version: { type: 'string', enum: [VERSION] }, operation: { type: 'string', enum: ['create_workflow'] }, workflow_name: { type: 'string', minLength: 1, maxLength: 80 }, target_output: { type: 'string', enum: [...MEDIA] },
    nodes: { type: 'array', minItems: 1, maxItems: MAX_NODES, items: { type: 'object', additionalProperties: false, required: ['id', 'type', 'title'], properties: { id: { type: 'string', pattern: ID_PATTERN.source, minLength: 2, maxLength: 40 }, type: { type: 'string', enum: types }, title: { type: 'string', minLength: 1, maxLength: 80 } } } },
    connections: { type: 'array', maxItems: MAX_CONNECTIONS, items: { type: 'object', additionalProperties: false, required: ['from_id', 'to_id', 'to_input', 'media', 'order'], properties: { from_id: { type: 'string', minLength: 2, maxLength: 40 }, to_id: { type: 'string', minLength: 2, maxLength: 40 }, to_input: { type: 'string', enum: semanticInputKeys }, media: { type: 'string', enum: [...MEDIA] }, order: { type: 'integer', minimum: 0 } } } },
    input_values: { type: 'array', maxItems: MAX_NODES, items: { type: 'object', additionalProperties: false, required: ['node_id', 'value'], properties: { node_id: { type: 'string', minLength: 2, maxLength: 40 }, value: { type: 'string', minLength: 1, maxLength: 2000 } } } },
    assumptions: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 500 } },
  } };
}

function issue(code, message, path = '') { return { severity: 'error', code, message, path }; }
function validText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function keysOnly(object, allowed) { return object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every((key) => allowed.has(key)); }

export function validateWorkflowPlan(plan, { nodeOptions } = {}) {
  const errors = []; const options = new Map((nodeOptions?.options || []).map((option) => [option.type, option]));
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, errors: [issue('PLAN_REQUIRED', 'Workflow plan must be an object.')], warnings: [] };
  if (!keysOnly(plan, new Set(['version', 'operation', 'workflow_name', 'target_output', 'nodes', 'connections', 'input_values', 'assumptions']))) errors.push(issue('PLAN_FIELDS', 'Workflow plan contains unsupported fields.'));
  if (plan.version !== VERSION) errors.push(issue('PLAN_VERSION', `version must be ${VERSION}.`, 'version'));
  if (plan.operation !== 'create_workflow') errors.push(issue('PLAN_OPERATION', 'operation must be create_workflow.', 'operation'));
  if (!validText(plan.workflow_name, 80)) errors.push(issue('PLAN_WORKFLOW_NAME', 'workflow_name must contain 1 to 80 characters.', 'workflow_name'));
  if (!MEDIA.has(plan.target_output)) errors.push(issue('PLAN_TARGET_OUTPUT', 'target_output is invalid.', 'target_output'));
  if (!Array.isArray(plan.nodes) || plan.nodes.length < 1 || plan.nodes.length > MAX_NODES) errors.push(issue('PLAN_NODES', `nodes must contain 1 to ${MAX_NODES} entries.`, 'nodes'));
  if (!Array.isArray(plan.connections) || plan.connections.length > MAX_CONNECTIONS) errors.push(issue('PLAN_CONNECTIONS', `connections must contain at most ${MAX_CONNECTIONS} entries.`, 'connections'));
  if (!Array.isArray(plan.input_values)) errors.push(issue('PLAN_INPUT_VALUES', 'input_values must be an array.', 'input_values'));
  if (!Array.isArray(plan.assumptions) || plan.assumptions.length > 16 || plan.assumptions.some((value) => typeof value !== 'string' || value.length > 500)) errors.push(issue('PLAN_ASSUMPTIONS', 'assumptions must contain at most 16 short strings.', 'assumptions'));
  const nodes = new Map();
  for (const [index, node] of (Array.isArray(plan.nodes) ? plan.nodes : []).entries()) {
    const path = `nodes[${index}]`;
    if (!keysOnly(node, new Set(['id', 'type', 'title']))) errors.push(issue('PLAN_NODE_FIELDS', 'Node contains unsupported fields.', path));
    if (!ID_PATTERN.test(node?.id || '')) errors.push(issue('PLAN_NODE_ID', 'Node id is invalid.', `${path}.id`)); else if (nodes.has(node.id)) errors.push(issue('PLAN_NODE_ID_DUPLICATE', `Duplicate node id "${node.id}".`, `${path}.id`)); else nodes.set(node.id, node);
    if (!options.has(node?.type)) errors.push(issue('PLAN_NODE_TYPE', `Node type "${node?.type}" is unavailable.`, `${path}.type`));
    if (!validText(node?.title, 80)) errors.push(issue('PLAN_NODE_TITLE', 'Node title must contain 1 to 80 characters.', `${path}.title`));
  }
  const expectedTextInputs = new Set([...nodes.values()].filter((node) => node.type === 'text-input' || node.type === 'system-instruction').map((node) => node.id)); const seenValues = new Set();
  for (const [index, item] of (Array.isArray(plan.input_values) ? plan.input_values : []).entries()) {
    if (!keysOnly(item, new Set(['node_id', 'value']))) errors.push(issue('PLAN_INPUT_VALUE_FIELDS', 'Input value contains unsupported fields.', `input_values[${index}]`));
    if (!expectedTextInputs.has(item?.node_id) || seenValues.has(item?.node_id)) errors.push(issue('PLAN_INPUT_VALUE_NODE', `input_values contains an unknown or duplicate text input "${item?.node_id}".`, `input_values[${index}].node_id`)); else seenValues.add(item.node_id);
    if (!validText(item?.value, 2000)) errors.push(issue('PLAN_INPUT_VALUE', 'Each input value must contain 1 to 2000 characters.', `input_values[${index}].value`));
  }
  for (const id of expectedTextInputs) if (!seenValues.has(id)) errors.push(issue('PLAN_INPUT_VALUE_MISSING', `Text input "${id}" requires a purpose-built value.`, 'input_values'));
  const incoming = new Map(); const outgoing = new Map(); const triples = new Set(); const validEdges = [];
  for (const [index, edge] of (Array.isArray(plan.connections) ? plan.connections : []).entries()) {
    const path = `connections[${index}]`; let usable = true;
    if (!keysOnly(edge, new Set(['from_id', 'to_id', 'to_input', 'media', 'order']))) { errors.push(issue('PLAN_CONNECTION_FIELDS', 'Connection contains unsupported fields.', path)); usable = false; }
    const source = nodes.get(edge?.from_id); const target = nodes.get(edge?.to_id);
    if (!source || !target) { errors.push(issue('PLAN_CONNECTION_REFERENCE', 'Connection references an unknown node.', path)); continue; }
    if (source.id === target.id) { errors.push(issue('PLAN_CONNECTION_SELF', 'Self-connections are not allowed.', path)); usable = false; }
    const triple = `${source.id}|${target.id}|${edge.to_input}|${edge.media}`; if (triples.has(triple)) { errors.push(issue('PLAN_CONNECTION_DUPLICATE', 'Duplicate connection.', path)); usable = false; } else triples.add(triple);
    if (!Number.isInteger(edge.order) || edge.order < 0) { errors.push(issue('PLAN_CONNECTION_ORDER', 'Connection order must be a non-negative integer.', `${path}.order`)); usable = false; }
    const sourceOption = options.get(source.type); const targetOption = options.get(target.type); const outputs = (sourceOption?.outputs || []).map((item) => item.media);
    const targetInput = (targetOption?.inputs || []).find((item) => item.key === edge.to_input);
    if (!targetInput) { errors.push(issue('PLAN_CONNECTION_INPUT', `${target.id} has no semantic input "${edge.to_input}".`, `${path}.to_input`)); usable = false; }
    if (!MEDIA.has(edge.media) || !outputs.includes(edge.media) || targetInput?.media !== edge.media) { errors.push(issue('PLAN_CONNECTION_MEDIA', `${source.id} -> ${target.id}.${edge.to_input} cannot use ${edge.media}.`, path)); usable = false; }
    if (edge.to_input === 'system_instruction' && source.type !== 'system-instruction') { errors.push(issue('PLAN_SYSTEM_INSTRUCTION_SOURCE', `${target.id}.system_instruction must come from a system-instruction node.`, path)); usable = false; }
    if (source.type === 'system-instruction' && edge.to_input !== 'system_instruction') { errors.push(issue('PLAN_SYSTEM_INSTRUCTION_TARGET', `System instruction "${source.id}" may connect only to a system_instruction input.`, path)); usable = false; }
    if (usable) { validEdges.push(edge); if (!incoming.has(target.id)) incoming.set(target.id, []); incoming.get(target.id).push(edge); if (!outgoing.has(source.id)) outgoing.set(source.id, []); outgoing.get(source.id).push(edge); }
  }
  for (const node of nodes.values()) for (const contract of options.get(node.type)?.inputs || []) {
    const edges = (incoming.get(node.id) || []).filter((edge) => edge.to_input === contract.key); const count = edges.length; const path = `nodes.${node.id}`;
    if (count < contract.min_connections) errors.push(issue(count === 0 ? 'PLAN_REQUIRED_INPUT' : 'PLAN_INPUT_MULTIPLICITY', `${node.id} (${node.type}) requires at least ${contract.min_connections} connection${contract.min_connections === 1 ? '' : 's'} to "${contract.key}" (${contract.media}) but has ${count}.`, path));
    if (contract.max_connections !== null && count > contract.max_connections) errors.push(issue('PLAN_INPUT_CARDINALITY', `${node.id} (${node.type}) accepts at most ${contract.max_connections} connection${contract.max_connections === 1 ? '' : 's'} to "${contract.key}" (${contract.media}) but has ${count}.`, path));
    const orders = edges.map((edge) => edge.order).sort((a, b) => a - b); if (new Set(orders).size !== orders.length || orders.some((value, index) => value !== index)) errors.push(issue('PLAN_CONNECTION_ORDER', `${node.id}.${contract.key} connection orders must be unique and contiguous from 0.`, path));
  }
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0])); for (const edge of validEdges) indegree.set(edge.to_id, indegree.get(edge.to_id) + 1);
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id); let visited = 0; while (queue.length) { const id = queue.shift(); visited += 1; for (const edge of outgoing.get(id) || []) { indegree.set(edge.to_id, indegree.get(edge.to_id) - 1); if (indegree.get(edge.to_id) === 0) queue.push(edge.to_id); } }
  if (visited !== nodes.size) errors.push(issue('PLAN_CYCLE', 'Workflow graph must be acyclic.', 'connections'));
  const inputIds = [...nodes.values()].filter((node) => options.get(node.type)?.role === 'input').map((node) => node.id); const reachable = new Set(inputIds); const walk = [...inputIds]; while (walk.length) { for (const edge of outgoing.get(walk.shift()) || []) if (!reachable.has(edge.to_id)) { reachable.add(edge.to_id); walk.push(edge.to_id); } }
  const terminals = [...nodes.values()].filter((node) => !(outgoing.get(node.id) || []).length && (options.get(node.type)?.outputs || []).some((output) => output.media === plan.target_output));
  if (!terminals.length) errors.push(issue('PLAN_TARGET_TERMINAL', `At least one terminal node must emit ${plan.target_output}.`, 'target_output'));
  const contributing = new Set(terminals.map((node) => node.id)); const reverse = new Map(); for (const edge of validEdges) { if (!reverse.has(edge.to_id)) reverse.set(edge.to_id, []); reverse.get(edge.to_id).push(edge.from_id); } const back = [...contributing]; while (back.length) for (const id of reverse.get(back.shift()) || []) if (!contributing.has(id)) { contributing.add(id); back.push(id); }
  for (const node of nodes.values()) { if (options.get(node.type)?.role !== 'input' && !reachable.has(node.id)) errors.push(issue('PLAN_NODE_DISCONNECTED', `Node "${node.id}" is not reachable from an input.`, `nodes.${node.id}`)); if (!contributing.has(node.id)) errors.push(issue('PLAN_NODE_DISCONNECTED', `Node "${node.id}" does not contribute to a requested terminal output.`, `nodes.${node.id}`)); }
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function materializeWorkflowPlanInputValues(plan) {
  const values = new Map((plan.input_values || []).map((item) => [item.node_id, item.value.trim()]));
  return { ...plan, nodes: (plan.nodes || []).map((node) => values.has(node.id) ? { ...node, input_value: values.get(node.id) } : { ...node }) };
}
