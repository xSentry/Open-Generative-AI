const DEFAULT_LAYOUT = Object.freeze({
  originX: 80,
  originY: 120,
  columnGap: 500,
  rowGap: 320,
});

function issue(code, message, path = null) {
  return path ? { code, message, path } : { code, message };
}

function refOf(node) {
  return typeof node?.ref === 'string' ? node.ref : '';
}

function compareNodes(left, right) {
  const category = String(left?.category || '').localeCompare(String(right?.category || ''));
  return category || refOf(left).localeCompare(refOf(right));
}

function compareConnections(left, right) {
  const leftOrder = Number.isFinite(left?.order) ? left.order : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(right?.order) ? right.order : Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder
    || String(left?.to_ref || '').localeCompare(String(right?.to_ref || ''))
    || String(left?.to_port || '').localeCompare(String(right?.to_port || ''))
    || String(left?.from_ref || '').localeCompare(String(right?.from_ref || ''));
}

function layoutError(validation) {
  const error = new Error(validation.errors.map((item) => item.message).join('; '));
  error.code = 'ARCHITECT_LAYOUT_INVALID';
  error.validation = validation;
  return error;
}

function buildIndexes(ir) {
  const errors = [];
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  const connections = Array.isArray(ir?.connections) ? ir.connections : [];
  const nodesByRef = new Map();
  const incomingByRef = new Map();
  const outgoingByRef = new Map();
  const indegreeByRef = new Map();
  const outdegreeByRef = new Map();

  for (const [index, node] of nodes.entries()) {
    const ref = refOf(node);
    if (!ref) {
      errors.push(issue('LAYOUT_NODE_REF', 'Every node must have a non-empty ref.', `nodes[${index}].ref`));
      continue;
    }
    if (nodesByRef.has(ref)) {
      errors.push(issue('LAYOUT_NODE_REF', `Duplicate node ref "${ref}".`, `nodes[${index}].ref`));
      continue;
    }
    nodesByRef.set(ref, node);
    incomingByRef.set(ref, []);
    outgoingByRef.set(ref, []);
    indegreeByRef.set(ref, 0);
    outdegreeByRef.set(ref, 0);
  }

  for (const [index, connection] of connections.entries()) {
    const sourceExists = nodesByRef.has(connection?.from_ref);
    const targetExists = nodesByRef.has(connection?.to_ref);
    if (!sourceExists || !targetExists) {
      errors.push(issue('LAYOUT_CONNECTION_REF', 'Every connection must reference existing source and target nodes.', `connections[${index}]`));
      continue;
    }
    outgoingByRef.get(connection.from_ref).push(connection);
    incomingByRef.get(connection.to_ref).push(connection);
    indegreeByRef.set(connection.to_ref, indegreeByRef.get(connection.to_ref) + 1);
    outdegreeByRef.set(connection.from_ref, outdegreeByRef.get(connection.from_ref) + 1);
  }

  for (const edges of incomingByRef.values()) edges.sort(compareConnections);
  for (const edges of outgoingByRef.values()) edges.sort(compareConnections);

  return { errors, nodesByRef, incomingByRef, outgoingByRef, indegreeByRef, outdegreeByRef };
}

function computeColumns(indexes) {
  const indegrees = new Map(indexes.indegreeByRef);
  const columns = new Map([...indexes.nodesByRef.keys()].map((ref) => [ref, 0]));
  const ready = [...indexes.nodesByRef.values()]
    .filter((node) => indegrees.get(node.ref) === 0)
    .sort(compareNodes);
  let visited = 0;

  while (ready.length > 0) {
    const node = ready.shift();
    visited += 1;
    for (const edge of indexes.outgoingByRef.get(node.ref)) {
      columns.set(edge.to_ref, Math.max(columns.get(edge.to_ref), columns.get(node.ref) + 1));
      indegrees.set(edge.to_ref, indegrees.get(edge.to_ref) - 1);
      if (indegrees.get(edge.to_ref) === 0) {
        ready.push(indexes.nodesByRef.get(edge.to_ref));
        ready.sort(compareNodes);
      }
    }
  }

  if (visited !== indexes.nodesByRef.size) {
    throw layoutError({
      valid: false,
      warnings: [],
      errors: [issue('LAYOUT_GRAPH_CYCLE', 'Logical layout requires an acyclic workflow graph.', 'connections')],
    });
  }

  // Longest-path layering correctly places joins, but it leaves a short branch
  // at the far left when that branch feeds a much later step. Walk backwards
  // and move each non-terminal node to the latest column allowed by its
  // children. Nodes on the critical path stay put, while late-only inputs land
  // immediately before the step that consumes them.
  const nodesRightToLeft = [...indexes.nodesByRef.values()]
    .sort((left, right) => columns.get(right.ref) - columns.get(left.ref) || compareNodes(left, right));
  for (const node of nodesRightToLeft) {
    const outgoing = indexes.outgoingByRef.get(node.ref);
    if (outgoing.length === 0) continue;
    const latestColumn = Math.min(...outgoing.map((edge) => columns.get(edge.to_ref) - 1));
    columns.set(node.ref, Math.max(columns.get(node.ref), latestColumn));
  }
  return columns;
}

function symmetricOffsets(count) {
  const midpoint = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => index - midpoint);
}

function isFree(row, occupied) {
  return occupied.every((other) => Math.abs(other - row) >= 1 - Number.EPSILON);
}

function nearestFreeRow(preferred, occupied) {
  if (isFree(preferred, occupied)) return preferred;
  for (let distance = 1; distance <= occupied.length + 1; distance += 1) {
    if (isFree(preferred + distance, occupied)) return preferred + distance;
    if (isFree(preferred - distance, occupied)) return preferred - distance;
  }
  return preferred + occupied.length + 1;
}

function computeRows(indexes, columns) {
  const rows = new Map();
  const nodesByColumn = new Map();
  for (const node of indexes.nodesByRef.values()) {
    const column = columns.get(node.ref);
    if (!nodesByColumn.has(column)) nodesByColumn.set(column, []);
    nodesByColumn.get(column).push(node);
  }

  const columnNumbers = [...nodesByColumn.keys()].sort((left, right) => left - right);
  for (const column of columnNumbers) {
    const desiredGroups = new Map();
    for (const node of nodesByColumn.get(column)) {
      const incoming = indexes.incomingByRef.get(node.ref);
      const desired = incoming.length === 0
        ? 0
        : incoming.reduce((sum, edge) => sum + rows.get(edge.from_ref), 0) / incoming.length;
      const key = String(desired);
      if (!desiredGroups.has(key)) desiredGroups.set(key, { desired, nodes: [] });
      desiredGroups.get(key).nodes.push(node);
    }

    const occupied = [];
    const groups = [...desiredGroups.values()].sort((left, right) => left.desired - right.desired);
    for (const group of groups) {
      group.nodes.sort((left, right) => {
        const leftIncoming = indexes.incomingByRef.get(left.ref)[0];
        const rightIncoming = indexes.incomingByRef.get(right.ref)[0];
        return compareConnections(leftIncoming, rightIncoming) || compareNodes(left, right);
      });
      const offsets = symmetricOffsets(group.nodes.length);
      for (const [index, node] of group.nodes.entries()) {
        const row = nearestFreeRow(group.desired + offsets[index], occupied);
        rows.set(node.ref, row);
        occupied.push(row);
      }
    }
  }
  return rows;
}

export function validateWorkflowLayout(ir) {
  const errors = [];
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  const byRef = new Map();
  const occupied = new Map();

  for (const [index, node] of nodes.entries()) {
    byRef.set(node?.ref, node);
    const { x, y } = node?.layout || {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      errors.push(issue('LAYOUT_COORDINATE', `Node "${node?.ref || index}" must have finite x and y coordinates.`, `nodes[${index}].layout`));
      continue;
    }
    const key = `${x}|${y}`;
    if (occupied.has(key)) {
      errors.push(issue('LAYOUT_OVERLAP', `Nodes "${occupied.get(key)}" and "${node.ref}" have the same coordinates.`, `nodes[${index}].layout`));
    } else {
      occupied.set(key, node.ref);
    }
  }

  for (const [index, connection] of (ir?.connections || []).entries()) {
    const source = byRef.get(connection?.from_ref);
    const target = byRef.get(connection?.to_ref);
    if (!source || !target) {
      errors.push(issue('LAYOUT_CONNECTION_REF', 'Every connection must reference existing source and target nodes.', `connections[${index}]`));
    } else if (Number.isFinite(source.layout?.x) && Number.isFinite(target.layout?.x) && source.layout.x >= target.layout.x) {
      errors.push(issue('LAYOUT_EDGE_DIRECTION', `Connection "${connection.from_ref}" -> "${connection.to_ref}" must point left-to-right.`, `connections[${index}]`));
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

export function layoutCreateWorkflowIr(ir, options = {}) {
  const settings = { ...DEFAULT_LAYOUT, ...options };
  for (const key of Object.keys(DEFAULT_LAYOUT)) {
    if (!Number.isFinite(settings[key])) {
      throw layoutError({ valid: false, warnings: [], errors: [issue('LAYOUT_OPTION', `Layout option "${key}" must be finite.`, `options.${key}`)] });
    }
  }

  const indexes = buildIndexes(ir);
  if (indexes.errors.length > 0) throw layoutError({ valid: false, warnings: [], errors: indexes.errors });
  const columns = computeColumns(indexes);
  const rows = computeRows(indexes, columns);
  const rowValues = [...rows.values()];
  const center = rowValues.length > 0 ? (Math.min(...rowValues) + Math.max(...rowValues)) / 2 : 0;
  const result = {
    ...ir,
    nodes: (ir?.nodes || []).map((node) => ({
      ...node,
      layout: {
        x: settings.originX + columns.get(node.ref) * settings.columnGap,
        y: settings.originY + (rows.get(node.ref) - center) * settings.rowGap,
      },
    })),
  };
  const validation = validateWorkflowLayout(result);
  if (!validation.valid) throw layoutError(validation);
  return result;
}
