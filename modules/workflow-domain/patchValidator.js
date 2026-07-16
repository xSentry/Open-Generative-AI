import { PATCH_OPERATIONS, PATCH_PRECONDITIONS, WORKFLOW_PATCH_VERSION } from './patchSchema.js';

function issue(code, message, path = '') {
  return { severity: 'error', code, message, path };
}

export function validateWorkflowPatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object') {
    return { valid: false, errors: [issue('PATCH_REQUIRED', 'Workflow patch is required.')], warnings: [] };
  }
  if (patch.version !== WORKFLOW_PATCH_VERSION) {
    errors.push(issue('UNSUPPORTED_PATCH_VERSION', `Unsupported workflow patch version "${patch.version}".`, 'version'));
  }
  if (!Array.isArray(patch.preconditions)) errors.push(issue('PRECONDITIONS_REQUIRED', 'Patch preconditions must be an array.', 'preconditions'));
  if (!Array.isArray(patch.operations)) errors.push(issue('OPERATIONS_REQUIRED', 'Patch operations must be an array.', 'operations'));

  for (const [index, precondition] of (patch.preconditions || []).entries()) {
    if (!PATCH_PRECONDITIONS.has(precondition?.type)) {
      errors.push(issue('UNKNOWN_PRECONDITION', `Unknown patch precondition "${precondition?.type}".`, `preconditions[${index}].type`));
    }
  }
  for (const [index, operation] of (patch.operations || []).entries()) {
    if (!PATCH_OPERATIONS.has(operation?.op)) {
      errors.push(issue('UNKNOWN_OPERATION', `Unknown patch operation "${operation?.op}".`, `operations[${index}].op`));
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}
