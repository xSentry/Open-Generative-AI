const API_BASE = '/api';

function upsertById(items, item, { prepend = false } = {}) {
  if (!item?.id) return items;
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return prepend ? [item, ...items] : [...items, item];
  const next = items.slice();
  next[index] = { ...next[index], ...item };
  return next;
}

export function mergeRemixProjectPatch(graph, patch) {
  if (!graph || !patch) return graph;
  return {
    ...graph,
    project: patch.project ? { ...graph.project, ...patch.project } : graph.project,
    jobs: patch.job ? upsertById(graph.jobs, patch.job, { prepend: true }) : graph.jobs,
    frameEdits: patch.frameEdit
      ? upsertById(graph.frameEdits, patch.frameEdit, { prepend: true })
      : graph.frameEdits,
    videoVersions: patch.videoVersion
      ? upsertById(graph.videoVersions, patch.videoVersion)
      : graph.videoVersions,
  };
}

export function subscribeRemixJobs({ onUpdate, onOpen, onError } = {}) {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return null;
  }
  if (!window.location?.protocol?.startsWith('http')) {
    return null;
  }

  const source = new EventSource(`${API_BASE}/events/stream`);
  source.onopen = () => onOpen?.();
  source.onerror = (event) => onError?.(event);
  source.onmessage = (event) => {
    if (!event.data) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload?.type === 'remix.job.updated' && payload.projectId && payload.jobId) {
      onUpdate?.(payload);
    }
  };

  return () => {
    try {
      source.close();
    } catch {
      // ignore
    }
  };
}
