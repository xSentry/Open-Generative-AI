export function summarizePatchDiff(patch = {}, { proposalRevision = null } = {}) {
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
    connection_changes: [],
    branch_replacements: [],
    revision: {
      base_revision: patch.baseRevision ?? null,
      proposal_revision: proposalRevision,
      operation_count: Array.isArray(patch.operations) ? patch.operations.length : 0,
    },
  };

  const disconnected = new Map();

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
        {
          const edge = {
          edge_id: operation.edge_id,
          source: operation.source,
          target: operation.target,
          mode: operation.mode || 'fail_if_occupied',
        };
          diff.edges_added.push(edge);
          diff.connection_changes.push({ action: 'connect', ...edge });
          const replaced = [...disconnected.values()].filter((item) =>
            item.target?.node_id === operation.target?.node_id &&
            item.target?.port === operation.target?.port
          );
          if (operation.mode === 'replace_existing' && replaced.length > 0) {
            for (const removed of replaced) {
              diff.branch_replacements.push({
                removed_edge_id: removed.edge_id,
                added_edge_id: operation.edge_id,
                target: operation.target,
              });
            }
          }
        }
        break;
      case 'disconnect':
        {
          const edge = {
            edge_id: operation.edge_id,
            source: operation.source || null,
            target: operation.target || null,
          };
          disconnected.set(operation.edge_id, edge);
          diff.edges_removed.push(edge);
          diff.connection_changes.push({ action: 'disconnect', ...edge });
        }
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
