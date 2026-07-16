export const WORKFLOW_PATCH_VERSION = 'workflow-patch/v1';

export const PATCH_OPERATIONS = new Set([
  'add_node',
  'set_node_parameter',
  'unset_node_parameter',
  'set_node_model',
  'set_node_model_policy',
  'set_node_exposure',
  'connect',
  'disconnect',
  'set_workflow_metadata',
]);

export const PATCH_PRECONDITIONS = new Set([
  'workflow_revision_equals',
  'node_exists',
  'node_not_exists',
  'edge_exists',
  'edge_not_exists',
  'field_equals',
  'target_port_unoccupied',
  'model_remains_available',
  'node_type_unchanged',
]);

export function createWorkflowPatch({ baseRevision = undefined, preconditions = [], operations = [] } = {}) {
  return {
    version: WORKFLOW_PATCH_VERSION,
    ...(baseRevision != null ? { baseRevision } : {}),
    preconditions,
    operations,
  };
}
