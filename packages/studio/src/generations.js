// Client helpers for the server-persisted studio generations API. These talk to
// the Next.js routes under /api/studio/generations and the async generate route.
//
// The generation history is loaded from the server (cross-browser / cross-device)
// instead of localStorage. localStorage is kept only for UI preferences.

import { resolveDeferredParams } from './muapi.js';

const API_BASE = (typeof window !== 'undefined' && window.location?.protocol?.startsWith('http'))
    ? '/api'
    : 'https://api.muapi.ai';

async function readJson(response) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

async function cleanupRejectedInputs(params) {
    try {
        await fetch(`${API_BASE}/studio/upload`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ params }),
        });
    } catch {
        // Best effort only. Accepted generations are cleaned by the processor;
        // this covers requests rejected before a generation row is created.
    }
}

function notifyAuthRequired(status, detail) {
    if (typeof window === 'undefined') return;
    if (status !== 401 && status !== 403) return;
    window.dispatchEvent(new CustomEvent('muapi:auth-required', { detail: { status, message: detail } }));
}

// Kick off a generation. Returns { generations: [{ id, status, ... }] } (async
// mode, 202) or { generation } (synchronous mode) depending on server config.
export async function startGeneration({ mode, model, params }) {
    // Inputs were held locally until now; upload any deferred files to the bucket
    // at submit time and swap in the real URLs before sending the request. This
    // prevents orphaned uploads for selections that never get generated.
    const resolvedParams = await resolveDeferredParams(null, params);
    const response = await fetch(`${API_BASE}/studio/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, model, params: resolvedParams }),
    });
    const data = await readJson(response);
    if (!response.ok) {
        await cleanupRejectedInputs(resolvedParams);
        notifyAuthRequired(response.status, data?.message);
        throw new Error(data?.message || `Generation request failed: ${response.status}`);
    }
    return data;
}

// Load the current user's generations, newest first.
export async function listGenerations({ mediaType, mode, status, limit, cursor } = {}) {
    const query = new URLSearchParams();
    if (mediaType) query.set('mediaType', mediaType);
    if (mode) {
        const modeValue = Array.isArray(mode) ? mode.filter(Boolean).join(',') : mode;
        if (modeValue) query.set('mode', modeValue);
    }
    if (status) query.set('status', status);
    if (limit) query.set('limit', String(limit));
    if (cursor?.createdAt && cursor?.id) {
        query.set('cursorCreatedAt', cursor.createdAt);
        query.set('cursorId', cursor.id);
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await fetch(`${API_BASE}/studio/generations${suffix}`);
    const data = await readJson(response);
    if (!response.ok) {
        notifyAuthRequired(response.status, data?.message);
        throw new Error(data?.message || `Failed to load generations: ${response.status}`);
    }
    return data || { items: [], nextCursor: null };
}

export async function getGeneration(id) {
    const response = await fetch(`${API_BASE}/studio/generations/${id}`);
    const data = await readJson(response);
    if (!response.ok) {
        notifyAuthRequired(response.status, data?.message);
        throw new Error(data?.message || `Failed to load generation: ${response.status}`);
    }
    return data?.generation || null;
}

export async function deleteGeneration(id) {
    const response = await fetch(`${API_BASE}/studio/generations/${id}`, { method: 'DELETE' });
    const data = await readJson(response);
    if (!response.ok) {
        notifyAuthRequired(response.status, data?.message);
        throw new Error(data?.message || `Failed to delete generation: ${response.status}`);
    }
    return data?.deleted === true;
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

export function isTerminalStatus(status) {
    return TERMINAL_STATUSES.has(status);
}

// Subscribe to live generation updates via the authenticated, Redis-backed app
// event stream. Events are lightweight notifications, so hydrate the affected
// generation from the REST endpoint before notifying callers.
export function subscribeGenerations({ onUpdate, onOpen, onError } = {}) {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
        return null;
    }
    if (!window.location?.protocol?.startsWith('http')) {
        return null;
    }

    const source = new EventSource(`${API_BASE}/events/stream`);

    source.onopen = () => onOpen?.();
    source.onerror = (event) => onError?.(event);
    source.onmessage = async (event) => {
        if (!event.data) return;
        let payload;
        try {
            payload = JSON.parse(event.data);
        } catch {
            // ignore malformed frames
            return;
        }
        if (payload?.type !== 'studio.generation.updated' || !payload.id) return;
        try {
            const generation = await getGeneration(payload.id);
            if (generation) onUpdate?.(generation);
        } catch (error) {
            onError?.(error);
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

// Poll a set of in-flight generation ids until they all reach a terminal state.
// Calls onUpdate(item) whenever an item's latest state is fetched. Returns a
// function that cancels polling.
export function pollGenerations(ids, onUpdate, { interval = 2500, maxAttempts = 900 } = {}) {
    const pending = new Set(ids);
    let attempts = 0;
    let stopped = false;
    let timer = null;

    const tick = async () => {
        if (stopped || pending.size === 0) return;
        attempts += 1;
        await Promise.all(
            [...pending].map(async (id) => {
                try {
                    const item = await getGeneration(id);
                    if (item) {
                        onUpdate?.(item);
                        if (isTerminalStatus(item.status)) pending.delete(id);
                    }
                } catch {
                    // transient error; retry on next tick
                }
            })
        );
        if (!stopped && pending.size > 0 && attempts < maxAttempts) {
            timer = setTimeout(tick, interval);
        }
    };

    timer = setTimeout(tick, interval);

    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
    };
}

