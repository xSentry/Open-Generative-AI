import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeRunStatus } from '../modules/workflow/server/serialization.js';

test('serializeRunStatus includes the node-run creation time for live countdowns', () => {
  const createdAt = new Date('2026-07-17T12:00:00.000Z');
  const serialized = serializeRunStatus([{
    id: 'node-run-1',
    nodeId: 'image-1',
    status: 'running',
    result: { runtimeEstimate: { seconds: 75 } },
    createdAt,
  }], {
    id: 'run-1',
    status: 'running',
  });

  assert.equal(serialized.nodes['image-1'][0].created_at, createdAt);
  assert.deepEqual(
    serialized.nodes['image-1'][0].result.runtimeEstimate,
    { seconds: 75 },
  );
});
