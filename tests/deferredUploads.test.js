import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerDeferredFile,
  releaseDeferred,
  resolveDeferred,
} from '../packages/studio/src/deferredUploads.js';

test('deferred file inputs upload once per submit, not once per retained form value', async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let nextId = 0;

  URL.createObjectURL = () => `blob:test-${++nextId}`;
  URL.revokeObjectURL = () => {};

  try {
    const file = { name: 'reference.png' };
    const deferredUrl = registerDeferredFile(file);
    const uploadedFiles = [];
    let uploadCount = 0;
    const uploader = async (value) => {
      uploadedFiles.push(value);
      return `https://bucket.example/studio-uploads/reference-${++uploadCount}.png`;
    };

    const first = await resolveDeferred(
      { image_url: deferredUrl, images_list: [deferredUrl] },
      uploader,
    );
    const second = await resolveDeferred({ image_url: deferredUrl }, uploader);

    assert.equal(uploadCount, 2);
    assert.deepEqual(uploadedFiles, [file, file]);
    assert.equal(first.image_url, 'https://bucket.example/studio-uploads/reference-1.png');
    assert.deepEqual(first.images_list, ['https://bucket.example/studio-uploads/reference-1.png']);
    assert.equal(second.image_url, 'https://bucket.example/studio-uploads/reference-2.png');

    releaseDeferred(deferredUrl);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});
