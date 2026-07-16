import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCreateWorkflowIrToPatch } from '../modules/workflow-architect/domain/compiler.js';
import { layoutCreateWorkflowIr, validateWorkflowLayout } from '../modules/workflow-architect/domain/layout.js';

function ir(refs, connections) {
  return {
    version: 'workflow-architect-ir/v1',
    operation: 'create_workflow',
    workflow_name: 'Layout test',
    target_category: 'text',
    nodes: refs.map((ref) => ({ ref, category: 'text', model_id: 'text-passthrough', role: ref === 'input' ? 'input' : 'generation', parameters: {} })),
    connections: connections.map(([from_ref, to_ref, order = 0]) => ({ from_ref, from_port: 'text', to_ref, to_port: 'prompt', order })),
  };
}

function positions(value) {
  return Object.fromEntries(value.nodes.map((node) => [node.ref, node.layout]));
}

test('lays out a single chain from left to right on one row', () => {
  const result = layoutCreateWorkflowIr(ir(['input', 'middle', 'output'], [['input', 'middle'], ['middle', 'output']]));
  const byRef = positions(result);
  assert.equal(byRef.input.y, byRef.middle.y);
  assert.equal(byRef.middle.y, byRef.output.y);
  assert.deepEqual([byRef.input.x, byRef.middle.x, byRef.output.x], [80, 580, 1080]);
  assert.equal(validateWorkflowLayout(result).valid, true);
});

test('separates independent starts and centers their join', () => {
  const result = layoutCreateWorkflowIr(ir(['left', 'right', 'join'], [['left', 'join', 0], ['right', 'join', 1]]));
  const byRef = positions(result);
  assert.equal(byRef.left.x, byRef.right.x);
  assert.notEqual(byRef.left.y, byRef.right.y);
  assert.equal(Math.abs(byRef.left.y - byRef.right.y), 380);
  assert.equal(byRef.join.x, byRef.left.x + 500);
  assert.equal(byRef.join.y, (byRef.left.y + byRef.right.y) / 2);
});

test('separates sibling branches to the right of their source', () => {
  const result = layoutCreateWorkflowIr(ir(['input', 'branch-a', 'branch-b'], [['input', 'branch-a', 1], ['input', 'branch-b', 0]]));
  const byRef = positions(result);
  assert.equal(byRef['branch-a'].x, byRef['branch-b'].x);
  assert.equal(byRef['branch-a'].x > byRef.input.x, true);
  assert.notEqual(byRef['branch-a'].y, byRef['branch-b'].y);
  assert.equal(byRef['branch-b'].y < byRef['branch-a'].y, true);
  assert.equal(byRef.input.y, (byRef['branch-a'].y + byRef['branch-b'].y) / 2);
});

test('lays out a diamond with centered source and join', () => {
  const result = layoutCreateWorkflowIr(ir(
    ['source', 'upper', 'lower', 'join'],
    [['source', 'upper', 0], ['source', 'lower', 1], ['upper', 'join', 0], ['lower', 'join', 1]],
  ));
  const byRef = positions(result);
  assert.equal(byRef.upper.x, byRef.lower.x);
  assert.notEqual(byRef.upper.y, byRef.lower.y);
  assert.equal(byRef.source.y, byRef.join.y);
  assert.equal(byRef.join.y, (byRef.upper.y + byRef.lower.y) / 2);
  assert.equal(byRef.source.x < byRef.upper.x && byRef.upper.x < byRef.join.x, true);
});

test('keeps multiple terminal outputs visible on separate lanes', () => {
  const result = layoutCreateWorkflowIr(ir(['source', 'output-a', 'output-b'], [['source', 'output-a'], ['source', 'output-b']]));
  const byRef = positions(result);
  assert.equal(byRef['output-a'].x, byRef['output-b'].x);
  assert.equal(byRef['output-a'].x > byRef.source.x, true);
  assert.notEqual(byRef['output-a'].y, byRef['output-b'].y);
});

test('places an input used only by a late step immediately before that step', () => {
  const result = layoutCreateWorkflowIr(ir(
    ['initial-input', 'first-image', 'refinement', 'final-prompt', 'final-image'],
    [
      ['initial-input', 'first-image'],
      ['first-image', 'refinement'],
      ['refinement', 'final-image'],
      ['final-prompt', 'final-image'],
    ],
  ));
  const byRef = positions(result);
  assert.equal(byRef['initial-input'].x, 80);
  assert.equal(byRef['final-prompt'].x, byRef.refinement.x);
  assert.equal(byRef['final-prompt'].x, byRef['final-image'].x - 500);
});

test('layout is stable when node and connection arrays are reordered', () => {
  const original = ir(
    ['source', 'branch-b', 'branch-a', 'join', 'terminal'],
    [['source', 'branch-b', 1], ['branch-a', 'join', 0], ['source', 'branch-a', 0], ['branch-b', 'join', 1], ['join', 'terminal', 0]],
  );
  const reordered = { ...original, nodes: [...original.nodes].reverse(), connections: [...original.connections].reverse() };
  assert.deepEqual(positions(layoutCreateWorkflowIr(original)), positions(layoutCreateWorkflowIr(reordered)));
});

test('does not mutate IR topology or connection order', () => {
  const original = ir(['source', 'first', 'second'], [['source', 'first', 1], ['source', 'second', 0]]);
  const connections = structuredClone(original.connections);
  const result = layoutCreateWorkflowIr(original);
  assert.deepEqual(result.connections, connections);
  assert.equal(result.connections, original.connections);
  assert.equal(original.nodes.every((node) => node.layout == null), true);
});

test('rejects cycles with the layout error code', () => {
  assert.throws(
    () => layoutCreateWorkflowIr(ir(['a', 'b'], [['a', 'b'], ['b', 'a']])),
    (error) => error.code === 'ARCHITECT_LAYOUT_INVALID' && error.validation.errors[0].code === 'LAYOUT_GRAPH_CYCLE',
  );
});

test('layout validator catches overlap and backward edges', () => {
  const value = ir(['source', 'target'], [['source', 'target']]);
  value.nodes = value.nodes.map((node) => ({ ...node, layout: { x: 80, y: 120 } }));
  const validation = validateWorkflowLayout(value);
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((item) => item.code === 'LAYOUT_OVERLAP'), true);
  assert.equal(validation.errors.some((item) => item.code === 'LAYOUT_EDGE_DIRECTION'), true);
});

test('compiler preserves a layout supplied by the IR', () => {
  const value = ir(['input'], []);
  value.nodes[0].layout = { x: 777, y: -42 };
  const patch = compileCreateWorkflowIrToPatch(value);
  const added = patch.operations.find((operation) => operation.op === 'add_node');
  assert.deepEqual(added.node.layout, { x: 777, y: -42 });
});
