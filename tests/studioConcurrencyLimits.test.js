import test from 'node:test';
import assert from 'node:assert/strict';
import { studioConcurrencySemaphores } from '../modules/studio/server/concurrencyLimits.js';

test('studioConcurrencySemaphores creates provider and user semaphores', () => {
  const env = {
    REPLICATE_MAX_ACTIVE_JOBS: '20',
    STUDIO_PER_USER_CONCURRENCY_LIMIT: '2',
    STUDIO_CONCURRENCY_LEASE_MS: '300000',
    STUDIO_CONCURRENCY_RETRY_DELAY_MS: '250',
  };

  const semaphores = studioConcurrencySemaphores({
    provider: 'replicate',
    userId: 'user-1',
  }, env);

  assert.equal(semaphores.length, 2);
  assert.deepEqual(semaphores.map((item) => item.name), [
    'studio:provider:replicate',
    'studio:user:user-1',
  ]);
  assert.deepEqual(semaphores.map((item) => item.limit), [20, 2]);
  assert.deepEqual(semaphores.map((item) => item.leaseMs), [300000, 300000]);
  assert.deepEqual(semaphores.map((item) => item.retryDelayMs), [250, 250]);
});

test('studioConcurrencySemaphores disables missing provider caps but keeps user limit', () => {
  const semaphores = studioConcurrencySemaphores({
    provider: 'muapi',
    userId: 'user-2',
  }, {
    STUDIO_PER_USER_CONCURRENCY_LIMIT: '3',
  });

  assert.equal(semaphores.length, 2);
  assert.equal(semaphores[0].name, 'studio:provider:muapi');
  assert.equal(semaphores[0].limit, 0);
  assert.equal(semaphores[1].name, 'studio:user:user-2');
  assert.equal(semaphores[1].limit, 3);
});

test('studioConcurrencySemaphores omits user semaphore when user id is unavailable', () => {
  const semaphores = studioConcurrencySemaphores({
    provider: 'replicate',
  }, {
    REPLICATE_MAX_ACTIVE_JOBS: '5',
    STUDIO_PER_USER_CONCURRENCY_LIMIT: '2',
  });

  assert.equal(semaphores.length, 1);
  assert.equal(semaphores[0].name, 'studio:provider:replicate');
  assert.equal(semaphores[0].limit, 5);
});
