// Shared, ref-counted Server-Sent Events subscription to the app event stream
// (`/api/events/stream`). One EventSource connection is shared by every
// node/component that watches a run; each subscriber receives hydrated node-run
// update events and filters by run_id/node_id itself.
//
// Robustness: the SSE connection can fail to establish for reasons outside our
// control — a browser extension / tracking protection blocking the request, the
// HTTP/1.1 per-host connection limit, a dev-server/proxy that buffers streams,
// etc. When that happens the request shows up as "blocked" and no events ever
// arrive. To avoid live updates silently dying, every run watcher here starts a
// short connect watchdog: if the EventSource never opens (or errors before it
// ever connected) we transparently fall back to polling `run/{id}/status`.
import axios from "axios";

const STREAM_URL = "/api/events/stream";
// If the EventSource hasn't opened within this window we assume it's blocked and
// switch that watcher to polling.
const CONNECT_TIMEOUT_MS = 4000;
const POLL_INTERVAL_MS = 3000;

let source = null;
let started = false;
let connected = false; // the current EventSource has fired `onopen`
let everConnected = false; // it connected at least once (transient drops auto-reconnect)
const listeners = new Set();
const architectListeners = new Set();
const statusListeners = new Set();

function streamSupported() {
  return (
    typeof window !== "undefined" &&
    typeof EventSource !== "undefined" &&
    window.location?.protocol?.startsWith("http")
  );
}

function notifyStatus(status) {
  statusListeners.forEach((fn) => {
    try {
      fn(status);
    } catch {
      // a faulty listener must not break the others
    }
  });
}

function emitRunStatus(runId, data, onEvent) {
  const nodesInRes = data?.nodes || {};
  for (const [nodeId, runs] of Object.entries(nodesInRes)) {
    if (!runs || runs.length === 0) continue;
    const latest = runs[runs.length - 1];
    onEvent({
      run_id: runId,
      workflow_id: data?.workflow_id,
      node_id: nodeId,
      node_run_id: latest.node_run_id,
      status: latest.status,
      run_status: data?.status,
      result: latest.result,
      error: latest.error,
    });
  }
}

function ensureStream() {
  if (started || !streamSupported()) return;
  started = true;
  connected = false;
  everConnected = false;
  try {
    source = new EventSource(STREAM_URL, { withCredentials: true });
    source.onmessage = (event) => {
      if (!event?.data) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload?.type === "workflow.architect.job.updated" && payload.jobId) {
        architectListeners.forEach((fn) => {
          try {
            fn(payload);
          } catch {
            // a faulty listener must not break the others
          }
        });
        return;
      }
      if (payload?.type !== "workflow.run.updated" || !payload.runId) return;
      listeners.forEach((fn) => {
        try {
          fn(payload);
        } catch {
          // a faulty listener must not break the others
        }
      });
    };
    // EventSource auto-reconnects; Redis Pub/Sub events are live notifications,
    // and each event hydrates current state from REST.
    source.onopen = () => {
      connected = true;
      everConnected = true;
      notifyStatus("open");
    };
    source.onerror = () => {
      connected = false;
      // Only a failure to EVER connect means the stream is blocked/unavailable —
      // transient post-connect drops are handled by EventSource's own retry.
      notifyStatus(everConnected ? "drop" : "error");
    };
  } catch {
    started = false;
    source = null;
    connected = false;
    // Defer so subscribers have attached their status listener first.
    setTimeout(() => notifyStatus("error"), 0);
  }
}

export function normalizeNodeId(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

// Subscribe to raw workflow update notifications `{ type, runId, workflowId,
// status, queueStatus }`. Returns an unsubscribe fn. The underlying connection
// is opened on first subscribe and closed when the last subscriber leaves.
export function subscribeWorkflowUpdates(onEvent) {
  listeners.add(onEvent);
  ensureStream();
  return () => {
    listeners.delete(onEvent);
    if (listeners.size === 0 && architectListeners.size === 0 && source) {
      try {
        source.close();
      } catch {
        // ignore
      }
      source = null;
      started = false;
      connected = false;
      everConnected = false;
    }
  };
}

// Subscribe to Workflow Architect live job notifications:
// `{ type, jobId, workflowId, conversationId, status, queueStatus, eventType, stage, proposalId, error }`.
// Returns an unsubscribe fn. Callers hydrate current state from REST when events arrive.
export function subscribeWorkflowArchitectJobs(onEvent) {
  architectListeners.add(onEvent);
  ensureStream();
  return () => {
    architectListeners.delete(onEvent);
    if (listeners.size === 0 && architectListeners.size === 0 && source) {
      try {
        source.close();
      } catch {
        // ignore
      }
      source = null;
      started = false;
      connected = false;
      everConnected = false;
    }
  };
}

// Subscribe to hydrated node-run events `{ run_id, workflow_id, node_id,
// node_run_id, status, run_status, result, error }`. Returns an unsubscribe fn.
export function subscribeWorkflowRuns(onEvent) {
  return subscribeWorkflowUpdates((ev) => {
    const runId = ev.runId;
    if (!runId) return;
    axios
      .get(`/api/workflow/run/${runId}/status`)
      .then((response) => emitRunStatus(runId, response.data, onEvent))
      .catch(() => {
        // Individual watchers keep their polling fallback; this shared
        // subscription should not fail the EventSource because one hydrate
        // request had a transient error.
      });
  });
}

// Subscribe to connection-health notifications ("open" | "error" | "drop").
// Returns an unsubscribe fn.
export function subscribeStreamStatus(onStatus) {
  statusListeners.add(onStatus);
  return () => statusListeners.delete(onStatus);
}

export function isStreamConnected() {
  return connected;
}

export function isWorkflowStreamAvailable() {
  return streamSupported();
}

// Watch every node-run event of a single run, with an automatic SSE→polling
// fallback. `onEvent` receives a normalized event shape in BOTH transports:
//   { run_id, node_id, node_run_id, status, run_status, result, error }
// Returns a disposer.
export function watchWorkflowRun(runId, onEvent, onError) {
  let disposed = false;
  let unsub = null;
  let statusUnsub = null;
  let pollTimer = null;
  let connectTimer = null;
  let polling = false;
  let consecutivePollErrors = 0;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (unsub) unsub();
    if (statusUnsub) statusUnsub();
    if (pollTimer) clearInterval(pollTimer);
    if (connectTimer) clearTimeout(connectTimer);
  };

  const startPolling = () => {
    if (disposed || polling) return;
    polling = true;
    // Tear down the (unusable) SSE subscription before polling.
    if (unsub) { unsub(); unsub = null; }
    if (statusUnsub) { statusUnsub(); statusUnsub = null; }
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }

    const tick = () => {
      axios
        .get(`/api/workflow/run/${runId}/status`)
        .then((response) => {
          if (disposed) return;
          consecutivePollErrors = 0;
          emitRunStatus(runId, response.data, onEvent);
        })
        .catch((error) => {
          consecutivePollErrors += 1;
          if (consecutivePollErrors >= 3) {
            onError?.(error);
          }
        });
    };
    tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  };

  // No EventSource at all (SSR / Electron file://) → poll straight away.
  if (!streamSupported()) {
    startPolling();
    return dispose;
  }

  unsub = subscribeWorkflowUpdates((ev) => {
    if (disposed) return;
    if (ev.runId !== runId) return;
    axios
      .get(`/api/workflow/run/${runId}/status`)
      .then((response) => {
        if (!disposed) emitRunStatus(runId, response.data, onEvent);
      })
      .catch((error) => {
        if (!disposed) onError?.(error);
      });
  });

  // Fall back to polling if the stream is blocked (never opens / errors before
  // connecting). A stream that's already connected needs no watchdog.
  statusUnsub = subscribeStreamStatus((status) => {
    if (disposed) return;
    if (status === "open" && connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    if (status === "error") startPolling();
  });

  connectTimer = setTimeout(() => {
    if (!disposed && !isStreamConnected()) startPolling();
  }, CONNECT_TIMEOUT_MS);

  return dispose;
}

// Watch a single node's run to completion. Builds on watchWorkflowRun so it
// inherits the SSE→polling fallback. The terminal `latest` object matches the
// polled status shape (`{ node_run_id, status, result, error }`) so callers keep
// their existing success/failure handling. Returns a disposer.
export function watchNodeRun(runId, nodeId, { onSucceeded, onFailed, onError } = {}) {
  let disposer = null;

  const handleEvent = (ev) => {
    if (normalizeNodeId(ev.node_id) !== normalizeNodeId(nodeId)) return;
    const latest = {
      node_run_id: ev.node_run_id,
      status: ev.status,
      result: ev.result,
      error: ev.error,
    };
    if (latest.status === "succeeded" || latest.status === "completed") {
      disposer?.();
      onSucceeded?.(latest);
    } else if (latest.status === "failed") {
      disposer?.();
      onFailed?.(latest);
    }
  };

  disposer = watchWorkflowRun(runId, handleEvent, onError);
  return disposer;
}
