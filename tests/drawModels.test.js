import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDefaultDrawAspectRatio,
  getDrawAspectRatios,
  getDrawModels,
  supportsDrawToEdit,
} from '../packages/studio/src/drawModels.js';

const compatible = {
  id: 'edit-model',
  imageField: 'input_image',
  inputs: {
    prompt: { type: 'string', required: true },
    input_image: { type: 'string', mediaKind: 'image', required: true },
    aspect_ratio: { type: 'string', enum: ['1:1', '16:9'], default: '16:9' },
  },
  required: ['prompt', 'input_image'],
};

test('Draw catalog keeps only prompt + image models it can fully supply', () => {
  const noPrompt = { ...compatible, id: 'no-prompt', inputs: { input_image: compatible.inputs.input_image } };
  const noImage = { ...compatible, id: 'no-image', imageField: null, inputs: { prompt: compatible.inputs.prompt } };
  const extraRequired = { ...compatible, id: 'extra', required: ['prompt', 'input_image', 'mask'] };

  assert.equal(supportsDrawToEdit(compatible), true);
  assert.deepEqual(
    getDrawModels({ i2i: [noPrompt, compatible, noImage, extraRequired] }).map((model) => model.id),
    ['edit-model'],
  );
});

test('Draw options use the selected provider model aspect-ratio schema', () => {
  assert.deepEqual(getDrawAspectRatios(compatible), ['1:1', '16:9']);
  assert.equal(getDefaultDrawAspectRatio(compatible), '16:9');
});
