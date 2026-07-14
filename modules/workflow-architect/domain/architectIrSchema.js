const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TARGET_CATEGORIES = new Set(['image', 'video', 'audio', 'text']);
const NODE_CAPABILITIES = new Set([
  'image', 'image_generation', 'image_editing', 'text_to_image', 'image_to_image',
  'video', 'video_generation', 'text_to_video', 'image_to_video', 'video_to_video',
  'audio', 'text_to_speech', 'tts', 'audio_generation',
  'text', 'text_generation',
  'utility_text_merge', 'utility_video_combine', 'utility_frame_extraction',
]);
const NODE_OPERATION_MODES = new Set(['input', 'generate', 'edit', 'image_input', 'video_input', 'audio_input', 'image_to_video', 'video_to_video', 'utility']);
const NODE_ROLES = new Set(['input', 'generation', 'utility']);

function issue(code, message, path = '') {
  return { severity: 'error', code, message, path };
}

function hasForbiddenKey(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenKey(child)) return true;
  }
  return false;
}

export function validateCreateWorkflowIr(value, { catalog = null } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: [issue('IR_REQUIRED', 'Architect IR must be an object.')], warnings: [] };
  }
  if (hasForbiddenKey(value)) {
    errors.push(issue('IR_FORBIDDEN_KEY', 'Architect IR contains a forbidden object key.'));
  }
  if (value.version != null && value.version !== 'workflow-architect-ir/v1') {
    errors.push(issue('IR_VERSION_UNSUPPORTED', 'Only workflow-architect-ir/v1 is supported.', 'version'));
  }
  if (value.operation !== 'create_workflow') {
    errors.push(issue('IR_OPERATION_UNSUPPORTED', 'Only create_workflow IR is supported.', 'operation'));
  }
  if (!TARGET_CATEGORIES.has(value.target_category)) {
    errors.push(issue('IR_TARGET_CATEGORY', 'target_category must be image, video, audio, or text.', 'target_category'));
  }
  if (typeof value.workflow_name !== 'string' || value.workflow_name.trim().length < 1) {
    errors.push(issue('IR_WORKFLOW_NAME', 'workflow_name is required.', 'workflow_name'));
  }
  if (!Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 6) {
    errors.push(issue('IR_NODES', 'nodes must contain 2 to 6 role descriptors.', 'nodes'));
  } else {
    const refs = new Set();
    value.nodes.forEach((node, index) => {
      const path = `nodes[${index}]`;
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        errors.push(issue('IR_NODE_OBJECT', 'Each IR node must be an object.', path));
        return;
      }
      if (typeof node.ref !== 'string' || !/^[a-z][a-z0-9_-]{1,39}$/i.test(node.ref)) {
        errors.push(issue('IR_NODE_REF', 'Node ref must be a stable short identifier.', `${path}.ref`));
      } else if (refs.has(node.ref)) {
        errors.push(issue('IR_NODE_REF_DUPLICATE', `Duplicate node ref "${node.ref}".`, `${path}.ref`));
      } else {
        refs.add(node.ref);
      }
      if (!NODE_ROLES.has(node.role)) {
        errors.push(issue('IR_NODE_ROLE', 'Node role must be input or generation.', `${path}.role`));
      }
      if (!NODE_CAPABILITIES.has(node.capability)) {
        errors.push(issue('IR_NODE_CAPABILITY', 'Node capability is not in the Architect capability allowlist.', `${path}.capability`));
      }
      if (node.operation_mode != null && !NODE_OPERATION_MODES.has(node.operation_mode)) {
        errors.push(issue('IR_NODE_OPERATION_MODE', 'Node operation_mode is not supported by the Architect catalog contract.', `${path}.operation_mode`));
      }
      if (node.model_id != null) {
        errors.push(issue('IR_MODEL_SELECTION_FORBIDDEN', 'Model IDs are server-selected and must not appear in workflow-architect-ir/v1.', `${path}.model_id`));
      }
      if (node.parameters != null && (typeof node.parameters !== 'object' || Array.isArray(node.parameters))) {
        errors.push(issue('IR_NODE_PARAMETERS', 'Node parameters must be an object when provided.', `${path}.parameters`));
      }
    });
    if (!value.nodes.some((node) => node?.role === 'input' && node.capability === 'text')) {
      errors.push(issue('IR_TEXT_INPUT_REQUIRED', 'Create workflow IR must include a text input role.', 'nodes'));
    }
    if (!value.nodes.some((node) => node?.role === 'generation' || node?.role === 'utility')) {
      errors.push(issue('IR_GENERATION_REQUIRED', 'Create workflow IR must include at least one generation or utility role.', 'nodes'));
    }
  }
  if (value.connections != null) {
    if (!Array.isArray(value.connections)) {
      errors.push(issue('IR_CONNECTIONS', 'connections must be an array when provided.', 'connections'));
    } else {
      value.connections.forEach((connection, index) => {
        const path = `connections[${index}]`;
        if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
          errors.push(issue('IR_CONNECTION_OBJECT', 'Each connection must be an object.', path));
          return;
        }
        for (const key of ['from_ref', 'to_ref']) {
          if (typeof connection[key] !== 'string' || !connection[key].trim()) {
            errors.push(issue('IR_CONNECTION_REF', `${key} is required.`, `${path}.${key}`));
          }
        }
      });
    }
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function createWorkflowIrJsonSchema(catalog) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'operation', 'workflow_name', 'target_category', 'nodes', 'connections', 'assumptions'],
    properties: {
      version: { type: 'string', enum: ['workflow-architect-ir/v1'] },
      operation: { type: 'string', enum: ['create_workflow'] },
      workflow_name: { type: 'string', minLength: 1, maxLength: 80 },
      target_category: { type: 'string', enum: ['image', 'video', 'audio', 'text'] },
      nodes: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', minLength: 2, maxLength: 40 },
            role: { type: 'string', enum: [...NODE_ROLES] },
            capability: { type: 'string', enum: [...NODE_CAPABILITIES] },
            operation_mode: { type: ['string', 'null'], enum: [...NODE_OPERATION_MODES, null] },
            title: { type: ['string', 'null'], maxLength: 80 },
            prompt: { type: ['string', 'null'], maxLength: 2000 },
            parameters: {
              type: ['object', 'null'],
              additionalProperties: false,
              properties: {},
              required: [],
            },
            model_preferences: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: ['speed_tier', 'quality_tier', 'stability'],
              properties: {
                speed_tier: { type: ['string', 'null'], enum: ['fast', 'balanced', null] },
                quality_tier: { type: ['string', 'null'], enum: ['standard', 'high', null] },
                stability: { type: ['string', 'null'], enum: ['stable', null] },
              },
            },
          },
          required: [
            'ref',
            'role',
            'capability',
            'operation_mode',
            'title',
            'prompt',
            'parameters',
            'model_preferences',
          ],
        },
      },
      connections: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from_ref: { type: 'string' },
            from_capability: { type: ['string', 'null'], enum: [...NODE_CAPABILITIES, null] },
            to_ref: { type: 'string' },
            to_capability: { type: ['string', 'null'], enum: [...NODE_CAPABILITIES, null] },
            to_port: { type: ['string', 'null'] },
          },
          required: ['from_ref', 'from_capability', 'to_ref', 'to_capability', 'to_port'],
        },
      },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  };
}
