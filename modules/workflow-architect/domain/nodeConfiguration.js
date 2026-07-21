import { getInputPortDefinitions, getOutputPortDefinitions, nodeTypeForCategory, portTypesCompatible } from '../../workflow-domain/portRegistry.js';
import { CREATE_WORKFLOW_TYPE_META, semanticInputs } from './createWorkflowPlan.js';
import { getProviderArchitectProfiles } from './capabilityCatalog.js';

const VERSION = 'workflow-model-selection/v1';
const SECRET = /api[_-]?key|token|secret|credential|password|endpoint|model_url|url_endpoint/i;
const MEDIA_TYPES = new Set(['text', 'image_url', 'video_url', 'audio_url']);

function issue(code, message, path = '') { return { severity: 'error', code, message, path }; }
function properties(entry) { return entry?.input_schema?.schemas?.input_data?.properties || entry?.input_schema || {}; }
function media(type) { return type === 'image_url' ? 'image' : type === 'video_url' ? 'video' : type === 'audio_url' ? 'audio' : type; }
function rawMedia(value) { return value === 'image' ? 'image_url' : value === 'video' ? 'video_url' : value === 'audio' ? 'audio_url' : value; }

function safeDescriptor(name, meta) {
  if (!meta || SECRET.test(name) || meta.secret === true || meta.format === 'password' || meta.connectable === true || meta.field === 'image' || meta.field === 'video' || meta.field === 'audio' || meta.mediaKind) return null;
  const type = meta.type === 'number' || meta.type === 'float' ? 'number' : meta.type === 'integer' || meta.type === 'int' ? 'integer' : meta.type === 'boolean' || meta.type === 'bool' ? 'boolean' : meta.type === 'array' ? 'array' : 'string';
  const out = { type };
  if (Array.isArray(meta.enum) && meta.enum.length && meta.enum.length <= 100) out.enum = meta.enum.filter((value) => ['string', 'number', 'boolean'].includes(typeof value));
  if (Number.isFinite(meta.minimum ?? meta.minValue)) out.minimum = meta.minimum ?? meta.minValue;
  if (Number.isFinite(meta.maximum ?? meta.maxValue)) out.maximum = meta.maximum ?? meta.maxValue;
  if (type === 'string') out.maxLength = Math.min(Number.isFinite(meta.maxLength) ? meta.maxLength : 2000, 4000);
  if (type === 'array') { out.maxItems = Math.min(Number.isFinite(meta.maxItems) ? meta.maxItems : 20, 50); out.items = { type: meta.items?.type || 'string' }; }
  if (Object.prototype.hasOwnProperty.call(meta, 'default') && validateValue(meta.default, out)) out.default = meta.default;
  return out;
}

function matchesType(node, plannedType) {
  const meta = CREATE_WORKFLOW_TYPE_META[plannedType];
  if (!meta) return false;
  if (meta.role === 'input') return node.kind === 'input' && node.category === (plannedType === 'system-instruction' ? 'text' : plannedType.replace('-input', ''));
  const ports = Object.values(node.input_ports || {}); const has = (type) => ports.some((port) => port.type === type); const required = (type) => ports.some((port) => port.type === type && port.required);
  let semanticMatch;
  if (plannedType === 'image-generate') semanticMatch = node.category === 'image' && !required('image_url');
  else if (plannedType === 'image-edit') semanticMatch = node.category === 'image' && has('image_url');
  else if (plannedType === 'image-compose') semanticMatch = node.category === 'image' && ports.some((port) => port.type === 'image_url' && (port.cardinality === 'many' || port.maxConnections === Infinity));
  else if (plannedType === 'video-generate') semanticMatch = node.category === 'video' && !required('image_url') && !required('video_url');
  else if (plannedType === 'image-to-video') semanticMatch = node.category === 'video' && has('image_url');
  else if (plannedType === 'video-to-video') semanticMatch = node.category === 'video' && has('video_url');
  else if (plannedType === 'text-transform') semanticMatch = node.category === 'text' && Boolean(node.input_ports?.prompt) && Boolean(node.input_ports?.system_prompt || node.input_ports?.system_instruction);
  else semanticMatch = node.capability === meta.capability;
  if (!semanticMatch) return false;
  // The local concatenator's catalog schema represents one prompt field, while
  // the workflow port registry intentionally exposes it as a many-edge input.
  if (plannedType === 'prompt-merge' && node.model_id === 'prompt-concatenator') return true;
  return semanticInputs(plannedType).every((contract) => {
    const raw = rawMedia(contract.media); const candidates = ports.filter((port) => port.type === raw);
    if (!candidates.length) return false;
    return contract.min_connections < 2 || candidates.some((port) => port.cardinality === 'many' || port.maxConnections === Infinity);
  });
}

function connectedMediaFor(plan, nodeId) {
  return new Set((plan.connections || []).filter((edge) => edge.to_id === nodeId).map((edge) => edge.media));
}

function fixedModelId(type) {
  if (type === 'system-instruction') return 'text-passthrough';
  if (type.endsWith('-input')) return `${type.replace('-input', '')}-passthrough`;
  if (type === 'prompt-merge') return 'prompt-concatenator';
  if (type === 'video-combine') return 'video-combiner';
  if (type === 'video-frame-extract') return 'video-frame-extractor';
  return null;
}

export function buildModelSelectionOptions(plan, { catalog } = {}) {
  const providerProfiles = Object.values(getProviderArchitectProfiles(catalog?.provider || 'replicate')).flat();
  return {
    version: 'workflow-model-selection-options/v1',
    nodes: (plan.nodes || []).map((planned) => {
      const fixed = fixedModelId(planned.type);
      const curatedIds = fixed
        ? new Set([fixed])
        : providerProfiles.length
          ? new Set(providerProfiles.map((profile) => profile.modelId))
          : null;
      const models = (catalog?.node_types || [])
        .filter((node) => (!curatedIds || curatedIds.has(node.model_id)) && matchesType(node, planned.type))
        .map((node) => ({ model_id: node.model_id, label: node.model_label, quality_tier: node.quality_tier, speed_tier: node.speed_tier, cost: node.cost }));
      return { node_id: planned.id, type: planned.type, models };
    }),
  };
}

export function createModelSelectionJsonSchema(plan, selectionOptions) {
  const byId = new Map(selectionOptions.nodes.map((node) => [node.node_id, node]));
  const nodeIds = plan.nodes.map((node) => node.id);
  return {
    type: 'object', additionalProperties: false, required: ['version', 'models_by_node'],
    properties: {
      version: { type: 'string', enum: [VERSION] },
      models_by_node: {
        type: 'object', additionalProperties: false, required: nodeIds,
        properties: Object.fromEntries(nodeIds.map((id) => [id, {
          type: 'string',
          enum: (byId.get(id)?.models || []).map((model) => model.model_id),
        }])),
      },
    },
  };
}

export function normalizeModelSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || !selection.models_by_node) return selection;
  return {
    version: selection.version,
    nodes: Object.entries(selection.models_by_node).map(([id, model_id]) => ({ id, model_id })),
  };
}

function validateValue(value, descriptor) {
  if (value === null || value === undefined) return false;
  if (descriptor.type === 'integer' && (!Number.isInteger(value))) return false;
  if (descriptor.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (descriptor.type === 'boolean' && typeof value !== 'boolean') return false;
  if (descriptor.type === 'string' && (typeof value !== 'string' || value.length > (descriptor.maxLength || 4000))) return false;
  if (descriptor.type === 'array' && (!Array.isArray(value) || value.length > (descriptor.maxItems || 50) || value.some((item) => item === null || typeof item === 'object'))) return false;
  if (descriptor.enum && !descriptor.enum.some((item) => Object.is(item, value))) return false;
  if (typeof value === 'number' && (value < (descriptor.minimum ?? -Infinity) || value > (descriptor.maximum ?? Infinity))) return false;
  return true;
}

export function validateModelSelection(plan, selection, { selectionOptions } = {}) {
  const errors = []; const expected = new Map((selectionOptions?.nodes || []).map((node) => [node.node_id, node])); const seen = new Set();
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return { valid: false, errors: [issue('CONFIGURATION_REQUIRED', 'Model selection must be an object.')], warnings: [] };
  if (selection.version !== VERSION) errors.push(issue('CONFIGURATION_VERSION', `version must be ${VERSION}.`, 'version'));
  if (!Array.isArray(selection.nodes) || selection.nodes.length !== plan.nodes.length) errors.push(issue('CONFIGURATION_NODE_COVERAGE', 'Selection must contain exactly one entry per planned node.', 'nodes'));
  for (const [index, node] of (Array.isArray(selection.nodes) ? selection.nodes : []).entries()) {
    const path = `nodes[${index}]`; const option = expected.get(node?.id);
    if (!option || seen.has(node?.id)) { errors.push(issue('CONFIGURATION_NODE_COVERAGE', 'Configuration contains an unknown or duplicate node.', `${path}.id`)); continue; }
    seen.add(node.id); const impl = option.models.find((item) => item.model_id === node.model_id);
    if (!impl) { errors.push(issue('CONFIGURATION_MODEL', `Model "${node.model_id}" is not allowed for ${node.id}.`, `${path}.model_id`)); continue; }
  }
  for (const id of expected.keys()) if (!seen.has(id)) errors.push(issue('CONFIGURATION_NODE_MISSING', `Configuration for "${id}" is missing.`, 'nodes'));
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function buildConfigurationOptions(plan, selection, { catalog, userRequest = '' } = {}) {
  const selected = new Map((selection?.nodes || []).map((node) => [node.id, node.model_id]));
  return {
    version: 'workflow-node-configuration-options/v1',
    nodes: (plan.nodes || []).map((planned) => {
      const modelId = selected.get(planned.id); const node = (catalog?.node_types || []).find((item) => item.model_id === modelId && matchesType(item, planned.type));
      if (!node) return { node_id: planned.id, type: planned.type, implementations: [], connected_media: [] };
      const connected = connectedMediaFor(plan, planned.id); const entry = catalog?.categories?.[node.category]?.models?.[node.model_id]; const configurable_inputs = {};
      for (const [name, meta] of Object.entries(properties(entry))) {
        const port = node.input_ports?.[name]; if (port && MEDIA_TYPES.has(port.type) && connected.has(media(port.type))) continue;
        const descriptor = safeDescriptor(name, meta); if (descriptor) configurable_inputs[name] = descriptor;
      }
      const inputs = {};
      if ((planned.type === 'text-input' || planned.type === 'system-instruction') && configurable_inputs.prompt) inputs.prompt = String(planned.input_value || '').slice(0, configurable_inputs.prompt.maxLength || 2000);
      return { node_id: planned.id, type: planned.type, implementations: [{ model_id: node.model_id, label: node.model_label, quality_tier: node.quality_tier, speed_tier: node.speed_tier, cost: node.cost, configurable_inputs }], connected_media: [...connected], inputs };
    }),
  };
}

export function materializeNodeConfiguration(configurationOptions) {
  return { version: 'workflow-node-configuration/v1', nodes: configurationOptions.nodes.map((node) => ({ id: node.node_id, model_id: node.implementations[0]?.model_id, inputs: node.inputs || {} })) };
}

function catalogNode(catalog, modelId) { return (catalog?.node_types || []).find((node) => node.model_id === modelId) || null; }

function preferredConcretePorts(semanticInput) {
  if (semanticInput === 'system_instruction') return ['system_prompt', 'system_instruction'];
  if (semanticInput === 'source_text' || semanticInput === 'instruction' || semanticInput === 'text_fragments') return ['prompt', 'messages'];
  if (semanticInput === 'source_image') return ['image_url', 'images_list'];
  if (semanticInput === 'reference_images') return ['images_list', 'image_url'];
  if (semanticInput === 'source_video') return ['video_url', 'videos_list'];
  if (semanticInput === 'video_clips') return ['videos_list', 'video_url'];
  return [];
}

function resolveConnection(planEdge, source, target, catalog, used, incomingCounts) {
  const outputs = getOutputPortDefinitions({ category: source.category, modelId: source.model_id });
  const inputs = getInputPortDefinitions({ category: target.category, modelId: target.model_id, nodeType: target.node_type, catalog });
  const rawType = rawMedia(planEdge.media);
  const preferred = preferredConcretePorts(planEdge.to_input);
  const inputEntries = Object.entries(inputs).sort(([leftName, left], [rightName, right]) => {
    const leftPreference = preferred.indexOf(leftName); const rightPreference = preferred.indexOf(rightName);
    if (leftPreference !== rightPreference) return (leftPreference < 0 ? 999 : leftPreference) - (rightPreference < 0 ? 999 : rightPreference);
    if ((incomingCounts.get(`${target.ref}|${planEdge.to_input}`) || 0) < 2) return 0;
    return Number(right.maxConnections === Infinity) - Number(left.maxConnections === Infinity);
  });
  for (const [fromPort, fromDef] of Object.entries(outputs)) for (const [toPort, toDef] of inputEntries) {
    if (fromDef.type !== rawType || toDef.type !== rawType || !portTypesCompatible(fromDef.type, toDef.type)) continue;
    const count = used.get(`${target.ref}|${toPort}`) || 0;
    if ((toDef.maxConnections ?? 1) !== Infinity && count > 0) continue;
    used.set(`${target.ref}|${toPort}`, count + 1);
    return { from_ref: source.ref, from_port: fromPort, to_ref: target.ref, to_port: toPort, order: planEdge.order };
  }
  return null;
}

export function hydrateCreateWorkflowIr(plan, configuration, { catalog } = {}) {
  const configs = new Map(configuration.nodes.map((node) => [node.id, node]));
  const nodes = plan.nodes.map((planned) => {
    const config = configs.get(planned.id); const record = catalogNode(catalog, config.model_id);
    if (!record) throw Object.assign(new Error(`Configured model "${config.model_id}" is unavailable.`), { code: 'ARCHITECT_CONFIGURATION_INVALID' });
    const entry = catalog.categories?.[record.category]?.models?.[record.model_id]; const defaults = {};
    for (const [key, meta] of Object.entries(properties(entry))) { const descriptor = safeDescriptor(key, meta); if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'default')) defaults[key] = descriptor.default; }
    const connected = connectedMediaFor(plan, planned.id); const inputPorts = getInputPortDefinitions({ category: record.category, modelId: record.model_id, nodeType: record.node_type, catalog });
    const parameters = { ...defaults, ...config.inputs };
    for (const [key, def] of Object.entries(inputPorts)) if (connected.has(media(def.type))) delete parameters[key];
    return { ref: planned.id, role: CREATE_WORKFLOW_TYPE_META[planned.type].role, expose_as_input: CREATE_WORKFLOW_TYPE_META[planned.type].expose_as_input !== false, capability: record.capability, operation_mode: record.operation_modes?.[0] || null, category: record.category, model_id: record.model_id, node_type: record.node_type || nodeTypeForCategory(record.category, record.model_id), title: planned.title, prompt_port: record.model_preferences?.prompt_port || null, parameters };
  });
  const byRef = new Map(nodes.map((node) => [node.ref, node])); const used = new Map(); const incomingCounts = new Map();
  for (const edge of plan.connections) incomingCounts.set(`${edge.to_id}|${edge.to_input}`, (incomingCounts.get(`${edge.to_id}|${edge.to_input}`) || 0) + 1);
  const orderedEdges = [...plan.connections].sort((left, right) => left.to_id.localeCompare(right.to_id) || left.to_input.localeCompare(right.to_input) || left.order - right.order);
  const connections = orderedEdges.map((edge) => {
    const resolved = resolveConnection(edge, byRef.get(edge.from_id), byRef.get(edge.to_id), catalog, used, incomingCounts);
    if (!resolved) throw Object.assign(new Error(`No concrete ${edge.media} port for ${edge.from_id} -> ${edge.to_id}.`), { code: 'ARCHITECT_HYDRATED_IR_INVALID' });
    return resolved;
  });
  return { version: 'workflow-architect-ir/v1', operation: 'create_workflow', workflow_name: plan.workflow_name.trim(), target_category: plan.target_output, nodes, connections, assumptions: plan.assumptions || [] };
}

export function validateHydratedCreateWorkflowIr(ir, { catalog } = {}) {
  const errors = []; const refs = new Map();
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return { valid: false, errors: [issue('HYDRATED_IR_REQUIRED', 'Hydrated IR must be an object.')], warnings: [] };
  if (ir.version !== 'workflow-architect-ir/v1' || ir.operation !== 'create_workflow') errors.push(issue('HYDRATED_IR_CONTRACT', 'Hydrated IR contract is invalid.'));
  for (const [index, node] of (ir.nodes || []).entries()) {
    const record = catalogNode(catalog, node.model_id); if (!record || record.category !== node.category) errors.push(issue('HYDRATED_IR_MODEL', `Model "${node.model_id}" is unavailable.`, `nodes[${index}].model_id`));
    if (refs.has(node.ref)) errors.push(issue('HYDRATED_IR_REF', `Duplicate ref "${node.ref}".`, `nodes[${index}].ref`)); else refs.set(node.ref, node);
    const props = properties(catalog?.categories?.[node.category]?.models?.[node.model_id]);
    for (const [key, value] of Object.entries(node.parameters || {})) { const descriptor = safeDescriptor(key, props[key]); if (!descriptor || !validateValue(value, descriptor)) errors.push(issue('HYDRATED_IR_PARAMETER', `Parameter "${key}" is invalid.`, `nodes[${index}].parameters.${key}`)); }
  }
  const occupied = new Map();
  for (const [index, edge] of (ir.connections || []).entries()) {
    const source = refs.get(edge.from_ref); const target = refs.get(edge.to_ref); if (!source || !target) { errors.push(issue('HYDRATED_IR_CONNECTION_REF', 'Connection references an unknown node.', `connections[${index}]`)); continue; }
    const out = getOutputPortDefinitions({ category: source.category, modelId: source.model_id })[edge.from_port]; const input = getInputPortDefinitions({ category: target.category, modelId: target.model_id, nodeType: target.node_type, catalog })[edge.to_port];
    if (!out || !input || !portTypesCompatible(out.type, input.type)) errors.push(issue('HYDRATED_IR_CONNECTION_PORT', 'Connection ports are invalid or incompatible.', `connections[${index}]`));
    const key = `${edge.to_ref}|${edge.to_port}`; occupied.set(key, (occupied.get(key) || 0) + 1); if (input?.maxConnections !== Infinity && occupied.get(key) > 1) errors.push(issue('HYDRATED_IR_CARDINALITY', 'Target port cardinality exceeded.', `connections[${index}]`));
  }
  for (const node of refs.values()) {
    const inputs = getInputPortDefinitions({ category: node.category, modelId: node.model_id, nodeType: node.node_type, catalog });
    for (const [port, def] of Object.entries(inputs)) if (def.required && !occupied.get(`${node.ref}|${port}`) && !Object.prototype.hasOwnProperty.call(node.parameters || {}, port)) errors.push(issue('HYDRATED_IR_REQUIRED_INPUT', `${node.ref}.${port} is required.`, `nodes.${node.ref}`));
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}
