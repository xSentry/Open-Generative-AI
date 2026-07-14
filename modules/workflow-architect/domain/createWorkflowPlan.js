const VERSION = 'workflow-architect-plan/v1';
const MEDIA = new Set(['text', 'image', 'video', 'audio']);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;

const TYPE_META = {
  'text-input': { capability: 'text', role: 'input', label: 'Text input', description: 'Provide editable text or a rough idea to downstream nodes.' },
  'image-input': { capability: 'image', role: 'input', label: 'Image input', description: 'Provide one image to downstream nodes.' },
  'video-input': { capability: 'video', role: 'input', label: 'Video input', description: 'Provide one video to downstream nodes.' },
  'audio-input': { capability: 'audio', role: 'input', label: 'Audio input', description: 'Provide one audio asset to downstream nodes.' },
  'text-generate': { capability: 'text_generation', role: 'generation', label: 'Generate text', description: 'Generate text from one text instruction.' },
  'image-generate': { capability: 'image_generation', role: 'generation', label: 'Generate an image from text', description: 'Generate an image from one text prompt.' },
  'image-edit': { capability: 'image_editing', role: 'generation', label: 'Edit an image using text', description: 'Edit one image according to one text instruction.' },
  'image-compose': { capability: 'image_editing', role: 'generation', label: 'Compose multiple reference images', description: 'Generate one image from two or more reference images and one text instruction.' },
  'video-generate': { capability: 'video_generation', role: 'generation', label: 'Generate a video from text', description: 'Generate a video from one text prompt without an input image or video.' },
  'image-to-video': { capability: 'image_to_video', role: 'generation', label: 'Generate video from an image', description: 'Animate one image according to one text instruction.' },
  'video-to-video': { capability: 'video_to_video', role: 'generation', label: 'Transform a video using text', description: 'Transform one video according to one text instruction.' },
  'text-to-speech': { capability: 'text_to_speech', role: 'generation', label: 'Generate speech from text', description: 'Generate speech audio from one text input.' },
  'prompt-merge': { capability: 'utility_text_merge', role: 'utility', label: 'Merge multiple text prompts', description: 'Merge two or more text inputs into one text output in connection order.' },
  'video-combine': { capability: 'utility_video_combine', role: 'utility', label: 'Combine multiple videos', description: 'Combine two or more videos into one video in connection order.' },
  'video-frame-extract': { capability: 'utility_frame_extraction', role: 'utility', label: 'Extract a frame from video', description: 'Extract one image frame from one input video.' },
};

function media(type) {
  return type === 'image_url' ? 'image' : type === 'video_url' ? 'video' : type === 'audio_url' ? 'audio' : type;
}

function hasInput(node, type) { return Object.values(node.input_ports || {}).some((def) => def.type === type); }
function hasRequiredInput(node, type) { return Object.values(node.input_ports || {}).some((def) => def.type === type && def.required); }
function typesForNode(node) {
  if (node.kind === 'input') return [`${node.category}-input`];
  if (node.category === 'image') return [...(!hasRequiredInput(node, 'image_url') ? ['image-generate'] : []), ...(hasInput(node, 'image_url') ? ['image-edit'] : []), ...(Object.values(node.input_ports || {}).some((port) => port.type === 'image_url' && port.cardinality === 'many') ? ['image-compose'] : [])];
  if (node.category === 'video') return [...(!hasRequiredInput(node, 'image_url') && !hasRequiredInput(node, 'video_url') ? ['video-generate'] : []), ...(hasInput(node, 'image_url') ? ['image-to-video'] : []), ...(hasInput(node, 'video_url') ? ['video-to-video'] : [])];
  return Object.entries(TYPE_META).filter(([, meta]) => meta.capability === node.capability).map(([type]) => type);
}

function semanticInputs(type) {
  if (type.endsWith('-input')) return [];
  const one = (mediaType, description) => ({ media: mediaType, required: true, min_connections: 1, max_connections: 1, description });
  if (type === 'image-edit') return [one('text', 'Instruction describing the edit.'), one('image', 'Image to edit.')];
  if (type === 'image-compose') return [one('text', 'Instruction describing how to combine the references.'), { media: 'image', required: true, min_connections: 2, max_connections: null, description: 'Reference images to combine into the result.' }];
  if (type === 'image-to-video') return [one('text', 'Instruction describing the desired motion.'), one('image', 'Image to animate.')];
  if (type === 'video-to-video') return [one('text', 'Instruction describing the transformation.'), one('video', 'Video to transform.')];
  if (type === 'prompt-merge') return [{ media: 'text', required: true, min_connections: 2, max_connections: null, description: 'Text fragments to merge in connection order.' }];
  if (type === 'video-combine') return [{ media: 'video', required: true, min_connections: 2, max_connections: null, description: 'Videos to combine in connection order.' }];
  if (type === 'video-frame-extract') return [one('video', 'Video from which to extract a frame.')];
  return [one('text', type === 'text-to-speech' ? 'Text to speak.' : 'Prompt or instruction for generation.')];
}

export function buildArchitectNodeOptionCatalog(catalog = {}) {
  const byType = new Map();
  for (const node of catalog.node_types || []) {
    if (node.architect_enabled === false || node.execution_support?.executable === false) continue;
    for (const type of typesForNode(node)) {
      const meta = TYPE_META[type]; if (!meta) continue;
      const inputs = semanticInputs(type);
      const outputs = [...new Set(Object.values(node.output_ports || {}).map((def) => media(def.type)).filter((value) => MEDIA.has(value)))];
      if (outputs.length === 0) continue;
      const candidate = { type, role: meta.role, label: meta.label, description: meta.description, inputs, outputs: outputs.map((output) => ({ media: output, description: `${meta.label} ${output} output.` })) };
      if (!byType.has(type)) byType.set(type, candidate);
    }
  }
  return { version: 'workflow-node-options/v1', options: [...byType.values()] };
}

const PATH_BLUEPRINTS = [
  { id: 'text-to-text', label: 'Generate text from an idea', target_output: 'text', nodes: [['input', 'text-input', 'Idea'], ['output', 'text-generate', 'Generated text']], connections: [['input', 'output', 'text']] },
  { id: 'text-to-image', label: 'Generate an image from a prompt', target_output: 'image', nodes: [['prompt', 'text-input', 'Prompt'], ['output', 'image-generate', 'Generated image']], connections: [['prompt', 'output', 'text']] },
  { id: 'text-to-video', label: 'Generate a video directly from a prompt', target_output: 'video', nodes: [['prompt', 'text-input', 'Prompt'], ['output', 'video-generate', 'Generated video']], connections: [['prompt', 'output', 'text']] },
  { id: 'text-to-speech', label: 'Generate speech from text', target_output: 'audio', nodes: [['text', 'text-input', 'Text'], ['output', 'text-to-speech', 'Generated speech']], connections: [['text', 'output', 'text']] },
  { id: 'text-and-image-edit', label: 'Edit an input image with text', target_output: 'image', nodes: [['prompt', 'text-input', 'Edit instruction'], ['image', 'image-input', 'Input image'], ['output', 'image-edit', 'Edited image']], connections: [['prompt', 'output', 'text'], ['image', 'output', 'image']] },
  { id: 'text-and-image-to-video', label: 'Animate an input image with text', target_output: 'video', nodes: [['prompt', 'text-input', 'Motion instruction'], ['image', 'image-input', 'Input image'], ['output', 'image-to-video', 'Animated video']], connections: [['prompt', 'output', 'text'], ['image', 'output', 'image']] },
  { id: 'text-and-video-transform', label: 'Transform an input video with text', target_output: 'video', nodes: [['prompt', 'text-input', 'Transformation instruction'], ['video', 'video-input', 'Input video'], ['output', 'video-to-video', 'Transformed video']], connections: [['prompt', 'output', 'text'], ['video', 'output', 'video']] },
  { id: 'idea-to-image-to-video', label: 'Generate an image from an idea and animate it', target_output: 'video', nodes: [['idea', 'text-input', 'Idea'], ['image', 'image-generate', 'Generated image'], ['output', 'image-to-video', 'Generated video']], connections: [['idea', 'image', 'text'], ['idea', 'output', 'text'], ['image', 'output', 'image']] },
  { id: 'idea-to-script-to-image-to-video', label: 'Develop an idea into text, an image, and an animated video', target_output: 'video', nodes: [['idea', 'text-input', 'Rough idea'], ['script', 'text-generate', 'Developed prompt'], ['image', 'image-generate', 'Generated image'], ['output', 'image-to-video', 'Generated video']], connections: [['idea', 'script', 'text'], ['script', 'image', 'text'], ['script', 'output', 'text'], ['image', 'output', 'image']] },
  { id: 'merge-prompts-to-image', label: 'Merge two prompts and generate an image', target_output: 'image', nodes: [['prompt1', 'text-input', 'Prompt one'], ['prompt2', 'text-input', 'Prompt two'], ['merge', 'prompt-merge', 'Merged prompt'], ['output', 'image-generate', 'Generated image']], connections: [['prompt1', 'merge', 'text'], ['prompt2', 'merge', 'text'], ['merge', 'output', 'text']] },
  { id: 'generate-two-images-and-compose', label: 'Generate two reference images and compose them into a final image', target_output: 'image', nodes: [['subject_prompt', 'text-input', 'First reference prompt'], ['subject_image', 'image-generate', 'First reference image'], ['scene_prompt', 'text-input', 'Second reference prompt'], ['scene_image', 'image-generate', 'Second reference image'], ['composition_prompt', 'text-input', 'Composition prompt'], ['output', 'image-compose', 'Composed image']], connections: [['subject_prompt', 'subject_image', 'text'], ['scene_prompt', 'scene_image', 'text'], ['composition_prompt', 'output', 'text'], ['subject_image', 'output', 'image'], ['scene_image', 'output', 'image']] },
  { id: 'combine-two-videos', label: 'Combine two input videos', target_output: 'video', nodes: [['video1', 'video-input', 'Video one'], ['video2', 'video-input', 'Video two'], ['output', 'video-combine', 'Combined video']], connections: [['video1', 'output', 'video'], ['video2', 'output', 'video']] },
  { id: 'extract-video-frame', label: 'Extract an image frame from a video', target_output: 'image', nodes: [['video', 'video-input', 'Input video'], ['output', 'video-frame-extract', 'Extracted frame']], connections: [['video', 'output', 'video']] },
];

export function buildWorkflowPathCatalog(nodeOptions) {
  const available = new Set((nodeOptions?.options || []).map((option) => option.type));
  return {
    version: 'workflow-path-options/v1',
    paths: PATH_BLUEPRINTS.filter((path) => path.nodes.every(([, type]) => available.has(type))).map((path) => ({
      id: path.id,
      label: path.label,
      target_output: path.target_output,
      nodes: path.nodes.map(([id, type, title]) => ({ id, type, title })),
      connections: path.connections.map(([from_id, to_id, mediaType]) => ({ from_id, to_id, media: mediaType })),
    })),
  };
}

export function createWorkflowAssemblyJsonSchema(pathCatalog) {
  return {
    type: 'object', additionalProperties: false,
    required: ['version', 'operation', 'workflow_name', 'path_id', 'input_values', 'assumptions'],
    properties: {
      version: { type: 'string', enum: ['workflow-architect-assembly/v1'] },
      operation: { type: 'string', enum: ['create_workflow'] },
      workflow_name: { type: 'string', minLength: 1, maxLength: 80 },
      path_id: { type: 'string', enum: (pathCatalog?.paths || []).map((path) => path.id) },
      input_values: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['node_id', 'value'], properties: { node_id: { type: 'string', minLength: 1, maxLength: 40 }, value: { type: 'string', minLength: 1, maxLength: 2000 } } } },
      assumptions: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 500 } },
    },
  };
}

export function validateWorkflowAssembly(assembly, { pathCatalog } = {}) {
  const errors = [];
  if (!assembly || typeof assembly !== 'object' || Array.isArray(assembly)) return { valid: false, errors: [issue('ASSEMBLY_REQUIRED', 'Workflow assembly must be an object.')], warnings: [] };
  if (assembly.version !== 'workflow-architect-assembly/v1') errors.push(issue('ASSEMBLY_VERSION', 'version must be workflow-architect-assembly/v1.', 'version'));
  if (assembly.operation !== 'create_workflow') errors.push(issue('ASSEMBLY_OPERATION', 'operation must be create_workflow.', 'operation'));
  if (!validAssemblyText(assembly.workflow_name, 80)) errors.push(issue('ASSEMBLY_WORKFLOW_NAME', 'workflow_name must contain 1 to 80 characters.', 'workflow_name'));
  if (!(pathCatalog?.paths || []).some((path) => path.id === assembly.path_id)) errors.push(issue('ASSEMBLY_PATH', `path_id "${assembly.path_id}" is unavailable.`, 'path_id'));
  const path = (pathCatalog?.paths || []).find((item) => item.id === assembly.path_id);
  const expectedInputs = new Set((path?.nodes || []).filter((node) => node.type === 'text-input').map((node) => node.id));
  const seenInputs = new Set();
  if (!Array.isArray(assembly.input_values)) errors.push(issue('ASSEMBLY_INPUT_VALUES', 'input_values must be an array.', 'input_values'));
  for (const [index, input] of (Array.isArray(assembly.input_values) ? assembly.input_values : []).entries()) {
    if (!expectedInputs.has(input?.node_id) || seenInputs.has(input?.node_id)) errors.push(issue('ASSEMBLY_INPUT_VALUE_NODE', `input_values contains an unknown or duplicate text input "${input?.node_id}".`, `input_values[${index}].node_id`));
    else seenInputs.add(input.node_id);
    if (!validAssemblyText(input?.value, 2000)) errors.push(issue('ASSEMBLY_INPUT_VALUE', 'Each input value must contain 1 to 2000 characters.', `input_values[${index}].value`));
  }
  for (const id of expectedInputs) if (!seenInputs.has(id)) errors.push(issue('ASSEMBLY_INPUT_VALUE_MISSING', `Text input "${id}" requires a purpose-built value.`, 'input_values'));
  if (!Array.isArray(assembly.assumptions)) errors.push(issue('ASSEMBLY_ASSUMPTIONS', 'assumptions must be an array.', 'assumptions'));
  return { valid: errors.length === 0, errors, warnings: [] };
}

function validAssemblyText(value, maxLength) { return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength; }

export function assembleWorkflowPlan(assembly, { pathCatalog } = {}) {
  const path = (pathCatalog?.paths || []).find((item) => item.id === assembly.path_id);
  if (!path) throw Object.assign(new Error(`Workflow path "${assembly.path_id}" is unavailable.`), { code: 'ARCHITECT_PLAN_INVALID' });
  const inputValues = new Map((assembly.input_values || []).map((item) => [item.node_id, item.value.trim()]));
  return { version: VERSION, operation: 'create_workflow', workflow_name: assembly.workflow_name.trim(), target_output: path.target_output, nodes: path.nodes.map((node) => inputValues.has(node.id) ? { ...node, input_value: inputValues.get(node.id) } : { ...node }), connections: path.connections.map((connection) => ({ ...connection })), assumptions: [...(assembly.assumptions || [])] };
}

export function createWorkflowPlanJsonSchema(nodeOptions) {
  const types = (nodeOptions?.options || []).map((option) => option.type);
  return {
    type: 'object', additionalProperties: false,
    required: ['version', 'operation', 'workflow_name', 'target_output', 'nodes', 'connections', 'assumptions'],
    properties: {
      version: { type: 'string', enum: [VERSION] }, operation: { type: 'string', enum: ['create_workflow'] },
      workflow_name: { type: 'string', minLength: 1, maxLength: 80 }, target_output: { type: 'string', enum: [...MEDIA] },
      nodes: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['id', 'type', 'title'], properties: { id: { type: 'string', pattern: ID_PATTERN.source, minLength: 2, maxLength: 40 }, type: { type: 'string', enum: types }, title: { type: 'string', minLength: 1, maxLength: 80 } } } },
      connections: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['from_id', 'to_id', 'media'], properties: { from_id: { type: 'string' }, to_id: { type: 'string' }, media: { type: 'string', enum: [...MEDIA] } } } },
      assumptions: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 500 } },
    },
  };
}

function issue(code, message, path = '') { return { severity: 'error', code, message, path }; }

export function validateWorkflowPlan(plan, { nodeOptions } = {}) {
  const errors = [];
  const options = new Map((nodeOptions?.options || []).map((option) => [option.type, option]));
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, errors: [issue('PLAN_REQUIRED', 'Workflow plan must be an object.')], warnings: [] };
  if (plan.version !== VERSION) errors.push(issue('PLAN_VERSION', `version must be ${VERSION}.`, 'version'));
  if (plan.operation !== 'create_workflow') errors.push(issue('PLAN_OPERATION', 'operation must be create_workflow.', 'operation'));
  if (typeof plan.workflow_name !== 'string' || !plan.workflow_name.trim() || plan.workflow_name.length > 80) errors.push(issue('PLAN_WORKFLOW_NAME', 'workflow_name must contain 1 to 80 characters.', 'workflow_name'));
  if (!MEDIA.has(plan.target_output)) errors.push(issue('PLAN_TARGET_OUTPUT', 'target_output is invalid.', 'target_output'));
  if (!Array.isArray(plan.nodes) || plan.nodes.length < 1 || plan.nodes.length > 8) errors.push(issue('PLAN_NODES', 'nodes must contain 1 to 8 entries.', 'nodes'));
  const nodes = new Map();
  for (const [index, node] of (Array.isArray(plan.nodes) ? plan.nodes : []).entries()) {
    const path = `nodes[${index}]`;
    if (!node || typeof node !== 'object' || Array.isArray(node)) { errors.push(issue('PLAN_NODE_OBJECT', 'Each node must be an object.', path)); continue; }
    if (!ID_PATTERN.test(node.id || '')) errors.push(issue('PLAN_NODE_ID', 'Node id is invalid.', `${path}.id`));
    else if (nodes.has(node.id)) errors.push(issue('PLAN_NODE_ID_DUPLICATE', `Duplicate node id "${node.id}".`, `${path}.id`));
    else nodes.set(node.id, node);
    if (!options.has(node.type)) errors.push(issue('PLAN_NODE_TYPE', `Node type "${node.type}" is unavailable.`, `${path}.type`));
    if (typeof node.title !== 'string' || !node.title.trim() || node.title.length > 80) errors.push(issue('PLAN_NODE_TITLE', 'Node title must contain 1 to 80 characters.', `${path}.title`));
  }
  const incoming = new Map(); const outgoing = new Map(); const triples = new Set();
  for (const [index, connection] of (Array.isArray(plan.connections) ? plan.connections : []).entries()) {
    const path = `connections[${index}]`; const source = nodes.get(connection?.from_id); const target = nodes.get(connection?.to_id);
    if (!source || !target) { errors.push(issue('PLAN_CONNECTION_REFERENCE', 'Connection references an unknown node.', path)); continue; }
    let usable = true;
    if (source.id === target.id) { errors.push(issue('PLAN_CONNECTION_SELF', 'Self-connections are not allowed.', path)); usable = false; }
    const sourceOption = options.get(source.type); const targetOption = options.get(target.type);
    const sourceOutputs = (sourceOption?.outputs || []).map((output) => output.media);
    if (!sourceOutputs.includes(connection.media) || !targetOption?.inputs.some((input) => input.media === connection.media)) { errors.push(issue('PLAN_CONNECTION_MEDIA', `${source.id} -> ${target.id} cannot use ${connection.media}; source outputs are ${sourceOutputs.join(', ') || 'none'} and target inputs are ${(targetOption?.inputs || []).map((input) => input.media).join(', ') || 'none'}.`, `${path}.media`)); usable = false; }
    const key = `${source.id}|${target.id}|${connection.media}`;
    if (triples.has(key)) { errors.push(issue('PLAN_CONNECTION_DUPLICATE', 'Duplicate connection.', path)); usable = false; } else triples.add(key);
    if (usable) {
      incoming.set(target.id, [...(incoming.get(target.id) || []), connection]);
      outgoing.set(source.id, [...(outgoing.get(source.id) || []), connection]);
    }
  }
  if (!Array.isArray(plan.connections)) errors.push(issue('PLAN_CONNECTIONS', 'connections must be an array.', 'connections'));
  for (const node of nodes.values()) {
    const option = options.get(node.type); const counts = new Map();
    for (const edge of incoming.get(node.id) || []) counts.set(edge.media, (counts.get(edge.media) || 0) + 1);
    for (const input of option?.inputs || []) {
      const count = counts.get(input.media) || 0;
      if (input.max_connections != null && count > input.max_connections) errors.push(issue('PLAN_INPUT_CARDINALITY', `${node.id} accepts at most ${input.max_connections} ${input.media} connection(s).`, `nodes.${node.id}`));
      if ((input.min_connections || 0) > count) {
        const code = input.min_connections === 1 ? 'PLAN_REQUIRED_INPUT' : 'PLAN_INPUT_MULTIPLICITY';
        errors.push(issue(code, `${node.id} (${node.type}) requires at least ${input.min_connections} ${input.media} connection(s), but has ${count}.`, `nodes.${node.id}`));
      }
    }
  }
  const visiting = new Set(); const visited = new Set();
  function cycle(id) { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const edge of outgoing.get(id) || []) if (cycle(edge.to_id)) return true; visiting.delete(id); visited.add(id); return false; }
  if ([...nodes.keys()].some(cycle)) errors.push(issue('PLAN_CYCLE', 'Workflow plan must be acyclic.', 'connections'));
  const inputs = [...nodes.values()].filter((node) => options.get(node.type)?.role === 'input');
  const reachable = new Set(inputs.map((node) => node.id)); const queue = [...reachable];
  while (queue.length) for (const edge of outgoing.get(queue.shift()) || []) if (!reachable.has(edge.to_id)) { reachable.add(edge.to_id); queue.push(edge.to_id); }
  const terminals = [...nodes.values()].filter((node) => !(outgoing.get(node.id) || []).length && options.get(node.type)?.outputs.some((output) => output.media === plan.target_output));
  if (!terminals.length) errors.push(issue('PLAN_TARGET_TERMINAL', 'At least one terminal node must emit target_output.', 'target_output'));
  const contributes = new Set(terminals.map((node) => node.id)); const reverseQueue = [...contributes];
  while (reverseQueue.length) { const id = reverseQueue.shift(); for (const edge of incoming.get(id) || []) if (!contributes.has(edge.from_id)) { contributes.add(edge.from_id); reverseQueue.push(edge.from_id); } }
  for (const node of nodes.values()) if (options.get(node.type)?.role !== 'input' && (!reachable.has(node.id) || !contributes.has(node.id))) errors.push(issue('PLAN_NODE_DISCONNECTED', `${node.id} must be reachable from an input and contribute to the target.`, `nodes.${node.id}`));
  return { valid: errors.length === 0, errors, warnings: [] };
}

export const CREATE_WORKFLOW_TYPE_META = TYPE_META;
