import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFinalAttemptWorkerLog,
  createWorkerLog,
  isFinalJobAttempt,
} from '../modules/queue/server/workerLogs.js';

test('createWorkerLog stores typed JSON payloads', async () => {
  let seen = null;
  const row = await createWorkerLog(
    {
      type: 'error',
      data: { jobId: 'job-1', runId: 'run-1', attempt: 2, error: 'failed' },
    },
    {
      query: async (sql, params) => {
        seen = { sql, params };
        return {
          rows: [{
            id: 'log-1',
            type: params[0],
            data: JSON.parse(params[1]),
            created_at: '2026-07-11T12:00:00.000Z',
          }],
        };
      },
    }
  );

  assert.match(seen.sql, /insert into worker_logs/);
  assert.equal(seen.params[0], 'error');
  assert.deepEqual(JSON.parse(seen.params[1]), {
    jobId: 'job-1',
    runId: 'run-1',
    attempt: 2,
    error: 'failed',
  });
  assert.deepEqual(row, {
    id: 'log-1',
    type: 'error',
    data: { jobId: 'job-1', runId: 'run-1', attempt: 2, error: 'failed' },
    createdAt: '2026-07-11T12:00:00.000Z',
  });
});

test('createFinalAttemptWorkerLog only stores exhausted jobs', async () => {
  let calls = 0;
  const deps = {
    query: async (sql, params) => {
      calls += 1;
      return {
        rows: [{
          id: 'log-2',
          type: params[0],
          data: JSON.parse(params[1]),
          created_at: '2026-07-11T12:00:00.000Z',
        }],
      };
    },
  };

  assert.equal(isFinalJobAttempt({ attemptsMade: 1, opts: { attempts: 2 } }), false);
  assert.equal(isFinalJobAttempt({ attemptsMade: 2, opts: { attempts: 2 } }), true);

  const skipped = await createFinalAttemptWorkerLog(
    { attemptsMade: 1, opts: { attempts: 2 } },
    { type: 'error', data: { jobId: 'job-2' } },
    deps
  );
  assert.equal(skipped, null);
  assert.equal(calls, 0);

  const stored = await createFinalAttemptWorkerLog(
    { attemptsMade: 2, opts: { attempts: 2 } },
    { type: 'error', data: { jobId: 'job-2' } },
    deps
  );
  assert.equal(stored.id, 'log-2');
  assert.equal(calls, 1);
});
