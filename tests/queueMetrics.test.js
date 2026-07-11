import test from 'node:test';
import assert from 'node:assert/strict';
import { collectQueueMetrics, collectQueueMetricsSnapshot } from '../modules/queue/server/metrics.js';

test('collectQueueMetrics returns counts, workers, and sampled timing stats', async () => {
  const queue = {
    async getJobCounts(...states) {
      assert.deepEqual(states, [
        'waiting',
        'active',
        'delayed',
        'prioritized',
        'waiting-children',
        'paused',
        'completed',
        'failed',
      ]);
      return { waiting: 2, active: 1, delayed: 0, completed: 8, failed: 1 };
    },
    async getWorkers() {
      return [{ id: 'worker-1', addr: '127.0.0.1:6379', name: 'studio-worker', age: 10 }];
    },
    async getJobs(states, start, end, asc) {
      assert.deepEqual(states, ['completed', 'failed', 'active']);
      assert.equal(start, 0);
      assert.equal(end, 99);
      assert.equal(asc, false);
      return [
        { timestamp: 1000, processedOn: 1500, finishedOn: 2500 },
        { timestamp: 2000, processedOn: 5000, finishedOn: 7000 },
        { timestamp: 3000, processedOn: 4500 },
      ];
    },
  };

  const metrics = await collectQueueMetrics({
    queue,
    name: 'studio-generations',
    configuredConcurrency: 4,
  });

  assert.equal(metrics.name, 'studio-generations');
  assert.equal(metrics.configuredConcurrency, 4);
  assert.equal(metrics.sampledJobs, 3);
  assert.deepEqual(metrics.counts, { waiting: 2, active: 1, delayed: 0, completed: 8, failed: 1 });
  assert.deepEqual(metrics.workers, [
    { id: 'worker-1', addr: '127.0.0.1:6379', name: 'studio-worker', age: 10 },
  ]);
  assert.deepEqual(metrics.waitTime, { count: 3, averageMs: 1667, p50Ms: 1500, p95Ms: 3000 });
  assert.deepEqual(metrics.runTime, { count: 2, averageMs: 1500, p50Ms: 1000, p95Ms: 2000 });
});

test('collectQueueMetricsSnapshot wraps multiple queue metrics', async () => {
  const queue = {
    async getJobCounts() {
      return { waiting: 0, active: 0 };
    },
    async getJobs() {
      return [];
    },
  };

  const snapshot = await collectQueueMetricsSnapshot({
    generatedAt: new Date('2026-07-11T12:00:00.000Z'),
    queues: [
      { queue, name: 'studio-generations', configuredConcurrency: 4 },
      { queue, name: 'workflow-runs', configuredConcurrency: 2 },
    ],
  });

  assert.equal(snapshot.generatedAt, '2026-07-11T12:00:00.000Z');
  assert.equal(snapshot.queues.length, 2);
  assert.equal(snapshot.queues[0].name, 'studio-generations');
  assert.equal(snapshot.queues[1].name, 'workflow-runs');
});
