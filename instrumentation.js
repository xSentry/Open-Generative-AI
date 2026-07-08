// Next.js instrumentation hook. Runs once when the server process boots. We use
// it to start the studio generations worker loop when async generation is on.
//
// The Node-only worker import is wrapped in a `NEXT_RUNTIME === 'nodejs'` guard
// so it is excluded from the Edge compilation (the worker pulls in `pg`, which
// needs Node's `fs`/`net`).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (String(process.env.STUDIO_ASYNC_GENERATIONS ?? '').toLowerCase() !== 'true') return;
    // Opt-out for deployments that run the worker as a dedicated process.
    if (String(process.env.STUDIO_WORKER_IN_PROCESS ?? 'true').toLowerCase() === 'false') return;

    const { startWorkerLoop } = await import('./modules/studio/server/worker.js');
    startWorkerLoop({ env: process.env });
    console.log('[studio-worker] in-process worker loop started.');

    // Workflow runs share the same async/in-process flags but can be disabled
    // independently via WORKFLOW_WORKER_IN_PROCESS=false.
    if (String(process.env.WORKFLOW_WORKER_IN_PROCESS ?? 'true').toLowerCase() !== 'false') {
      const { startWorkerLoop: startWorkflowWorker } = await import('./modules/workflow/server/worker.js');
      startWorkflowWorker({ env: process.env });
      console.log('[workflow-worker] in-process worker loop started.');
    }
  }
}

