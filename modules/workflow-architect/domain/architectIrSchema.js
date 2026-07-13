const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TARGET_CATEGORIES = new Set(['image', 'video', 'audio', 'text']);

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
  if (value.operation !== 'create_workflow') {
    errors.push(issue('IR_OPERATION_UNSUPPORTED', 'Only create_workflow IR is supported in Phase 2.', 'operation'));
  }
  if (!TARGET_CATEGORIES.has(value.target_category)) {
    errors.push(issue('IR_TARGET_CATEGORY', 'target_category must be image, video, audio, or text.', 'target_category'));
  }
  if (typeof value.workflow_name !== 'string' || value.workflow_name.trim().length < 1) {
    errors.push(issue('IR_WORKFLOW_NAME', 'workflow_name is required.', 'workflow_name'));
  }
  if (typeof value.prompt !== 'string' || value.prompt.trim().length < 2) {
    errors.push(issue('IR_PROMPT', 'prompt must describe the generation request.', 'prompt'));
  }
  if (value.model_id != null && typeof value.model_id !== 'string') {
    errors.push(issue('IR_MODEL_ID', 'model_id must be a string when provided.', 'model_id'));
  }
  if (value.parameters != null && (typeof value.parameters !== 'object' || Array.isArray(value.parameters))) {
    errors.push(issue('IR_PARAMETERS', 'parameters must be an object when provided.', 'parameters'));
  }
  if (catalog && value.target_category && value.model_id) {
    const model = catalog.categories?.[value.target_category]?.models?.[value.model_id];
    if (!model) {
      errors.push(issue('IR_MODEL_NOT_CURATED', `Model "${value.model_id}" is not enabled for Architect create workflows.`, 'model_id'));
    }
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function createWorkflowIrJsonSchema(catalog) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['operation', 'workflow_name', 'target_category', 'prompt'],
    properties: {
      operation: { type: 'string', enum: ['create_workflow'] },
      workflow_name: { type: 'string', minLength: 1, maxLength: 80 },
      target_category: { type: 'string', enum: ['image', 'video', 'audio', 'text'] },
      model_id: {
        type: 'string',
        enum: catalog?.compact?.map((item) => item.model_id) || [],
      },
      prompt: { type: 'string', minLength: 2, maxLength: 2000 },
      parameters: {
        type: 'object',
        additionalProperties: true,
      },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  };
}
