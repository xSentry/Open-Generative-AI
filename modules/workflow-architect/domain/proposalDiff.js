export function summarizePatchDiff(patch = {}) {
  const diff = {
    nodes_added: [],
    nodes_updated: [],
    nodes_removed: [],
    edges_added: [],
    edges_removed: [],
    model_changes: [],
    parameter_changes: [],
    exposure_changes: [],
    workflow_metadata_changes: [],
  };

  for (const operation of patch.operations || []) {
    switch (operation.op) {
      case 'add_node':
        diff.nodes_added.push({
          node_id: operation.node?.id,
          title: operation.node?.title || operation.node?.id,
          node_type: operation.node?.nodeType,
          model_id: operation.node?.modelId || null,
        });
        break;
      case 'set_node_parameter':
      case 'unset_node_parameter':
        diff.nodes_updated.push(operation.node_id);
        diff.parameter_changes.push({
          node_id: operation.node_id,
          parameter: operation.parameter,
          op: operation.op,
          previous_value: Object.hasOwn(operation, 'expected_previous_value')
            ? operation.expected_previous_value
            : undefined,
          value: operation.op === 'set_node_parameter' ? operation.value : undefined,
        });
        break;
      case 'set_node_model':
        diff.nodes_updated.push(operation.node_id);
        diff.model_changes.push({
          node_id: operation.node_id,
          model_id: operation.model_id,
        });
        break;
      case 'set_node_exposure':
        diff.nodes_updated.push(operation.node_id);
        diff.exposure_changes.push({
          node_id: operation.node_id,
          exposure: operation.exposure || {},
        });
        break;
      case 'connect':
        diff.edges_added.push({
          edge_id: operation.edge_id,
          source: operation.source,
          target: operation.target,
        });
        break;
      case 'disconnect':
        diff.edges_removed.push({ edge_id: operation.edge_id });
        break;
      case 'set_workflow_metadata':
        diff.workflow_metadata_changes.push(operation.metadata || {});
        break;
      default:
        break;
    }
  }

  diff.nodes_updated = [...new Set(diff.nodes_updated)];
  return diff;
}

export function defaultProposalSummary(patch = {}) {
  const diff = summarizePatchDiff(patch);
  const changeCount = Object.values(diff).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
  return {
    title: 'Workflow proposal',
    message: changeCount > 0
      ? `Prepared ${changeCount} deterministic workflow change${changeCount === 1 ? '' : 's'}.`
      : 'Prepared a workflow proposal with no graph changes.',
    assumptions: [],
    warnings: [],
    diff,
  };
}
