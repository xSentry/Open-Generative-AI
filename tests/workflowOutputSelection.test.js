import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildActiveUpstreamResults,
  outputSelectionPatch,
  resolveConnectedImageInputs,
  selectOutput,
} from '../packages/Vibe-Workflow/packages/workflow-builder/src/components/workflowOutputSelection.js';

test('selectOutput moves the active generated version to outputs[0]', () => {
  const outputs = [
    { id: 'one', type: 'image_url', value: 'first.png' },
    { id: 'two', type: 'image_url', value: 'second.png' },
  ];
  assert.deepEqual(selectOutput(outputs, 'second.png').map((output) => output.id), ['two', 'one']);
});

test('one connected image replaces stale image lists instead of appending to them', () => {
  assert.deepEqual(resolveConnectedImageInputs(['new.png'], {
    image_url: 'old-single.png',
    images_list: ['old-one.png', 'old-two.png'],
  }), { imageUrl: 'new.png', imagesList: [] });
});

test('multiple connected images exactly rebuild the list', () => {
  assert.deepEqual(resolveConnectedImageInputs(['new-one.png', 'new-two.png', 'new-one.png'], {
    images_list: ['old.png'],
  }), { imageUrl: null, imagesList: ['new-one.png', 'new-two.png'] });
});

test('buildActiveUpstreamResults captures each canvas selection and excludes the target', () => {
  const results = buildActiveUpstreamResults([
    { id: 'text', data: { resultUrl: 'selected', outputs: [{ type: 'text', value: 'latest' }] } },
    { id: 'image', data: { resultUrl: 'two.png', outputs: [{ value: 'one.png' }, { value: 'two.png' }] } },
    { id: 'target', data: { outputs: [{ value: 'ignore' }] } },
  ], 'target');

  assert.equal(results.text[0].value, 'selected');
  assert.equal(results.text[0].key, undefined);
  assert.equal(results.image[0].value, 'two.png');
  assert.equal(results.target, undefined);
});

test('outputSelectionPatch keeps display and propagated result in lockstep', () => {
  assert.deepEqual(outputSelectionPatch([{ value: 'a' }, { value: 'b' }], 1), {
    resultUrl: 'b',
    viewingOutput: 'b',
  });
});
