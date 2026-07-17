import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { watchNodeRun } from '../packages/Vibe-Workflow/packages/workflow-builder/src/components/workflowStream.js';

test('watchNodeRun immediately hydrates a run that finished before SSE attached', async () => {
  const originalWindow = globalThis.window;
  const originalEventSource = globalThis.EventSource;
  const originalGet = axios.get;

  class FakeEventSource {
    close() {}
  }

  globalThis.window = { location: { protocol: 'http:' } };
  globalThis.EventSource = FakeEventSource;
  axios.get = async () => ({
    data: {
      workflow_id: 'wf-1',
      status: 'completed',
      nodes: {
        prompt: [{
          node_run_id: 'node-run-1',
          status: 'succeeded',
          created_at: '2026-07-17T12:00:00.000Z',
          result: { outputs: [{ type: 'text', value: 'done' }] },
          error: null,
        }],
      },
    },
  });

  try {
    const updates = [];
    const terminal = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        dispose();
        reject(new Error('watcher did not hydrate the completed node'));
      }, 250);
      const dispose = watchNodeRun('run-1', 'prompt', {
        onUpdate: (latest) => updates.push(latest.status),
        onSucceeded: (latest) => {
          clearTimeout(timer);
          resolve(latest);
        },
        onError: reject,
      });
    });

    assert.equal(terminal.node_run_id, 'node-run-1');
    assert.equal(terminal.created_at, '2026-07-17T12:00:00.000Z');
    assert.equal(terminal.result.outputs[0].value, 'done');
    assert.deepEqual(updates, ['succeeded']);
  } finally {
    axios.get = originalGet;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalEventSource;
  }
});
