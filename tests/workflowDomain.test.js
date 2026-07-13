import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNodeSchemas } from '../modules/workflow/server/schemas.js';
import {
  savedPayloadToWorkflowGraph,
  workflowGraphToSavedPayload,
  workflowGraphToExecutionPlan,
  reactFlowStateToWorkflowGraph,
  workflowGraphToReactFlowState,
} from '../modules/workflow-domain/workflowAdapters.js';
import { validateWorkflowGraph } from '../modules/workflow-domain/graphValidator.js';
import { createWorkflowPatch } from '../modules/workflow-domain/patchSchema.js';
import { applyWorkflowPatch, WorkflowPatchConflict } from '../modules/workflow-domain/applyPatch.js';
import {
  assertRevisionMatches,
  createInitialRevision,
  createNextRevision,
  createRevertRevision,
  WorkflowRevisionConflict,
} from '../modules/workflow-domain/revisionService.js';

function catalog() {
  return buildNodeSchemas('replicate');
}

function savedTextToImagePayload() {
  return {
    workflow_id: 'wf-1',
    revision: 3,
    name: 'Text to image',
    category: 'image',
    edges: [
      {
        id: 'edge-text-image',
        source: 'text-1',
        target: 'image-1',
        sourceHandle: 'textOutput',
        targetHandle: 'imageInput',
      },
    ],
    data: {
      nodes: [
        {
          id: 'text-1',
          title: 'Prompt',
          category: 'text',
          model: 'text-passthrough',
          input_params: { prompt: 'a quiet lake', make_input: true },
          params: { prompt: 'a quiet lake' },
          position: { x: 10, y: 20 },
        },
        {
          id: 'image-1',
          title: 'Image',
          category: 'image',
          model: 'image-passthrough',
          input_params: { prompt: '', make_output: true },
          params: { prompt: '{{ text-1.outputs[0].value }}' },
          position: { x: 300, y: 20 },
          inputs: ['text-1'],
        },
      ],
    },
  };
}

test('saved payload adapter converts legacy templates into canonical graph bindings', () => {
  const graph = savedPayloadToWorkflowGraph(savedTextToImagePayload(), {
    provider: 'replicate',
    catalog: catalog(),
  });

  assert.equal(graph.version, 'workflow-graph/v1');
  assert.equal(graph.workflowId, 'wf-1');
  assert.equal(graph.revision, 3);
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.nodes[1].inputs.prompt, {
    type: 'connection',
    sourceNodeId: 'text-1',
    sourcePort: 'text',
  });
  assert.equal(graph.nodes[1].parameters.prompt, '');
  assert.equal(graph.nodes[0].exposure.makeInput, true);
  assert.equal(graph.nodes[1].exposure.makeOutput, true);

  const validation = validateWorkflowGraph(graph, { catalog: catalog() });
  assert.equal(validation.valid, true, validation.errors.map((error) => error.message).join('; '));
});

test('canonical graph serializes back to the existing save and execution envelope', () => {
  const graph = savedPayloadToWorkflowGraph(savedTextToImagePayload(), {
    provider: 'replicate',
    catalog: catalog(),
  });
  const saved = workflowGraphToSavedPayload(graph);
  const imageNode = saved.data.nodes.find((node) => node.id === 'image-1');

  assert.equal(saved.workflow_id, 'wf-1');
  assert.deepEqual(saved.edges, savedTextToImagePayload().edges);
  assert.equal(imageNode.params.prompt, '{{ text-1.outputs[0].value }}');
  assert.equal(imageNode.input_params.make_output, true);

  const executionPlan = workflowGraphToExecutionPlan(graph);
  assert.deepEqual(executionPlan.nodes, saved.data.nodes);
  assert.deepEqual(executionPlan.edges, saved.edges);
});

test('ReactFlow adapter round-trips through canonical graph without templates', () => {
  const reactFlow = {
    nodes: [
      {
        id: 'text-1',
        type: 'textNode',
        position: { x: 0, y: 0 },
        data: {
          title: 'Prompt',
          modelId: 'text-passthrough',
          selectedModel: { id: 'text-passthrough' },
          formValues: { prompt: 'a lake', make_input: true },
          outputs: [{ type: 'text', value: 'a lake', id: 'out-1' }],
          resultUrl: null,
        },
      },
      {
        id: 'image-1',
        type: 'imageNode',
        position: { x: 320, y: 0 },
        data: {
          title: 'Image',
          modelId: 'image-passthrough',
          selectedModel: { id: 'image-passthrough' },
          formValues: { prompt: '', make_output: true },
          outputs: [],
          resultUrl: null,
        },
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source: 'text-1',
        target: 'image-1',
        sourceHandle: 'textOutput',
        targetHandle: 'imageInput',
      },
    ],
  };

  const graph = reactFlowStateToWorkflowGraph(reactFlow, {
    workflowId: 'wf-rf',
    revision: 7,
    name: 'RF',
    category: 'image',
    catalog: catalog(),
  });
  assert.equal(graph.workflowId, 'wf-rf');
  assert.equal(graph.revision, 7);
  assert.deepEqual(graph.nodes.find((node) => node.id === 'image-1').inputs.prompt, {
    type: 'connection',
    sourceNodeId: 'text-1',
    sourcePort: 'text',
  });
  assert.ok(!JSON.stringify(graph.nodes).includes('{{ text-1.outputs[0].value }}'));

  const next = workflowGraphToReactFlowState(graph);
  assert.equal(next.nodes.find((node) => node.id === 'text-1').data.formValues.make_input, true);
  assert.equal(next.nodes.find((node) => node.id === 'image-1').data.formValues.make_output, true);
  assert.deepEqual(next.edges, reactFlow.edges);
});

test('graph validator rejects missing nodes, duplicate edges, cycles, cardinality, and secrets', () => {
  const base = savedPayloadToWorkflowGraph(savedTextToImagePayload(), {
    provider: 'replicate',
    catalog: catalog(),
  });

  const bad = {
    ...base,
    nodes: [
      ...base.nodes,
      { ...base.nodes[0], id: 'text-2', parameters: { api_key: 'r8_abcdefghijklmnopqrstuvwxyz' } },
    ],
    edges: [
      ...base.edges,
      { id: 'dup-target', source: { nodeId: 'text-2', port: 'text' }, target: { nodeId: 'image-1', port: 'prompt' } },
      { id: 'missing-node', source: { nodeId: 'ghost', port: 'text' }, target: { nodeId: 'image-1', port: 'prompt' } },
      { id: 'cycle', source: { nodeId: 'image-1', port: 'image' }, target: { nodeId: 'text-1', port: 'prompt' } },
    ],
  };

  const result = validateWorkflowGraph(bad, { catalog: catalog() });
  assert.equal(result.valid, false);
  const codes = new Set(result.errors.map((error) => error.code));
  assert.ok(codes.has('PORT_CARDINALITY'));
  assert.ok(codes.has('UNKNOWN_SOURCE_NODE'));
  assert.ok(codes.has('GRAPH_CYCLE'));
  assert.ok(codes.has('SECRET_KEY'));
  assert.ok(codes.has('SECRET_VALUE'));
});

test('graph validator rejects constant/connection conflicts and unresolved required inputs', () => {
  const graph = savedPayloadToWorkflowGraph(savedTextToImagePayload(), {
    provider: 'replicate',
    catalog: catalog(),
  });
  const conflict = {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'image-1'
        ? {
            ...node,
            inputs: {
              ...node.inputs,
              prompt: { type: 'constant', value: 'manual prompt' },
            },
          }
        : node
    ),
  };
  const conflictResult = validateWorkflowGraph(conflict, { catalog: catalog() });
  assert.equal(conflictResult.valid, false);
  assert.ok(conflictResult.errors.some((error) => error.code === 'CONSTANT_CONNECTION_CONFLICT'));

  const required = savedPayloadToWorkflowGraph({
    name: 'Required input',
    edges: [],
    data: {
      nodes: [
        {
          id: 'frame',
          category: 'utility',
          model: 'video-frame-extractor',
          input_params: { video_url: '' },
          params: { video_url: '' },
        },
      ],
    },
  }, { provider: 'replicate', catalog: catalog() });
  const requiredResult = validateWorkflowGraph(required, { catalog: catalog() });
  assert.equal(requiredResult.valid, false);
  assert.ok(requiredResult.errors.some((error) => error.code === 'REQUIRED_INPUT_UNRESOLVED'));
});

test('applyWorkflowPatch applies deterministic edits and rejects stale preconditions', () => {
  const graph = savedPayloadToWorkflowGraph(savedTextToImagePayload(), {
    provider: 'replicate',
    catalog: catalog(),
  });

  const patch = createWorkflowPatch({
    baseRevision: 3,
    preconditions: [
      { type: 'workflow_revision_equals', revision: 3 },
      { type: 'node_exists', node_id: 'text-1' },
    ],
    operations: [
      {
        op: 'set_node_parameter',
        node_id: 'text-1',
        parameter: 'prompt',
        expected_previous_value: 'a quiet lake',
        value: 'a storm over the lake',
      },
      { op: 'set_node_exposure', node_id: 'text-1', exposure: { makeInput: false } },
      { op: 'set_workflow_metadata', metadata: { name: 'Updated flow' } },
    ],
  });

  const next = applyWorkflowPatch(graph, patch, { catalog: catalog() });
  assert.equal(next.metadata.name, 'Updated flow');
  assert.equal(next.nodes.find((node) => node.id === 'text-1').parameters.prompt, 'a storm over the lake');
  assert.equal(next.nodes.find((node) => node.id === 'text-1').exposure.makeInput, false);

  const stalePatch = createWorkflowPatch({
    preconditions: [{ type: 'workflow_revision_equals', revision: 2 }],
    operations: [],
  });
  assert.throws(
    () => applyWorkflowPatch(graph, stalePatch, { catalog: catalog() }),
    (error) => error instanceof WorkflowPatchConflict && error.code === 'WORKFLOW_REVISION_CONFLICT'
  );
});

test('applyWorkflowPatch connects and disconnects bindings deterministically', () => {
  const graph = savedPayloadToWorkflowGraph({
    workflow_id: 'wf-connect',
    revision: 1,
    name: 'Connect',
    edges: [],
    data: {
      nodes: [
        {
          id: 'text-1',
          category: 'text',
          model: 'text-passthrough',
          input_params: { prompt: 'hello' },
          params: { prompt: 'hello' },
        },
        {
          id: 'image-1',
          category: 'image',
          model: 'image-passthrough',
          input_params: {},
          params: {},
        },
      ],
    },
  }, { provider: 'replicate', catalog: catalog() });

  const connected = applyWorkflowPatch(graph, createWorkflowPatch({
    preconditions: [{ type: 'target_port_unoccupied', node_id: 'image-1', port: 'prompt' }],
    operations: [
      {
        op: 'connect',
        edge_id: 'edge-new',
        source: { node_id: 'text-1', port: 'text' },
        target: { node_id: 'image-1', port: 'prompt' },
        mode: 'fail_if_occupied',
      },
    ],
  }), { catalog: catalog() });
  assert.deepEqual(connected.nodes.find((node) => node.id === 'image-1').inputs.prompt, {
    type: 'connection',
    sourceNodeId: 'text-1',
    sourcePort: 'text',
  });

  const disconnected = applyWorkflowPatch(connected, createWorkflowPatch({
    operations: [{ op: 'disconnect', edge_id: 'edge-new' }],
  }), { catalog: catalog() });
  assert.equal(disconnected.edges.length, 0);
  assert.equal(disconnected.nodes.find((node) => node.id === 'image-1').inputs.prompt, undefined);
});

test('compatibility corpus preserves semantic save-envelope behavior', () => {
  const fixtures = [
    savedTextToImagePayload(),
    {
      workflow_id: 'wf-video',
      name: 'Text image video',
      category: 'video',
      edges: [
        { id: 'e1', source: 'text', target: 'image', sourceHandle: 'textOutput', targetHandle: 'imageInput' },
        { id: 'e2', source: 'text', target: 'video', sourceHandle: 'textOutput', targetHandle: 'videoInput' },
        { id: 'e3', source: 'image', target: 'video', sourceHandle: 'imageOutput', targetHandle: 'videoInput2' },
      ],
      data: {
        nodes: [
          { id: 'text', category: 'text', model: 'text-passthrough', input_params: { prompt: 'motion' }, params: { prompt: 'motion' } },
          { id: 'image', category: 'image', model: 'image-passthrough', input_params: {}, params: { prompt: '{{ text.outputs[0].value }}' } },
          {
            id: 'video',
            category: 'video',
            model: 'video-passthrough',
            input_params: {},
            params: {
              prompt: '{{ text.outputs[0].value }}',
              image_url: '{{ image.outputs[0].value }}',
            },
          },
        ],
      },
    },
    {
      workflow_id: 'wf-utility',
      name: 'Utility',
      category: 'video',
      edges: [
        { id: 'e1', source: 'video-a', target: 'combine', sourceHandle: 'videoOutput', targetHandle: 'videoInput7' },
        { id: 'e2', source: 'video-b', target: 'combine', sourceHandle: 'videoOutput', targetHandle: 'videoInput7' },
      ],
      data: {
        nodes: [
          { id: 'video-a', category: 'video', model: 'video-passthrough', input_params: { video_url: 'https://a.test/a.mp4' }, params: { video_url: 'https://a.test/a.mp4' } },
          { id: 'video-b', category: 'video', model: 'video-passthrough', input_params: { video_url: 'https://a.test/b.mp4' }, params: { video_url: 'https://a.test/b.mp4' } },
          { id: 'combine', category: 'utility', model: 'video-combiner', input_params: { aspect_ratio: 'auto' }, params: { videos_list: ['{{ video-a.outputs[0].value }}', '{{ video-b.outputs[0].value }}'], aspect_ratio: 'auto' } },
        ],
      },
    },
  ];

  for (const fixture of fixtures) {
    const graph = savedPayloadToWorkflowGraph(fixture, { provider: 'replicate', catalog: catalog() });
    const validation = validateWorkflowGraph(graph, { catalog: catalog() });
    assert.equal(validation.valid, true, validation.errors.map((error) => error.message).join('; '));
    const saved = workflowGraphToSavedPayload(graph);
    assert.deepEqual(saved.edges, fixture.edges);
    assert.deepEqual(
      saved.data.nodes.map((node) => ({ id: node.id, category: node.category, model: node.model, params: node.params })),
      fixture.data.nodes.map((node) => ({ id: node.id, category: node.category, model: node.model, params: node.params }))
    );
  }
});

test('revision service creates revision metadata and detects conflicts', () => {
  const graph = savedPayloadToWorkflowGraph(savedTextToImagePayload());
  const initial = createInitialRevision({ workflowId: 'wf-1', graph, createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(initial.revision, 1);
  assert.equal(initial.parentRevision, null);
  assert.equal(initial.graph.revision, 1);

  const next = createNextRevision({
    workflowId: 'wf-1',
    currentRevision: initial.revision,
    graph: initial.graph,
    source: 'architect',
    proposalId: 'proposal-1',
    createdAt: '2026-01-01T00:01:00.000Z',
  });
  assert.equal(next.revision, 2);
  assert.equal(next.parentRevision, 1);
  assert.equal(next.proposalId, 'proposal-1');
  assert.equal(next.graph.revision, 2);

  const revert = createRevertRevision({
    workflowId: 'wf-1',
    currentRevision: next.revision,
    targetRevision: 1,
    targetGraph: initial.graph,
    createdAt: '2026-01-01T00:02:00.000Z',
  });
  assert.equal(revert.revision, 3);
  assert.equal(revert.source, 'revert');
  assert.equal(revert.revertedToRevision, 1);

  assert.doesNotThrow(() => assertRevisionMatches(2, 2));
  assert.throws(
    () => assertRevisionMatches(3, 2),
    (error) => error instanceof WorkflowRevisionConflict && error.code === 'WORKFLOW_REVISION_CONFLICT'
  );
});
