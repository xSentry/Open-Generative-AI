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

// Subscribe to live generation updates via Server-Sent Events. Returns a
// disposer that closes the connection. Falls back to null when EventSource is
// unavailable (caller should then poll). `onOpen`/`onError` report connection
// state so the caller can enable/disable polling fallback.
export function subscribeGenerations({ onUpdate, onOpen, onError } = {}) {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
        return null;
    }
    if (!window.location?.protocol?.startsWith('http')) {
        return null;
    }

    const source = new EventSource(`${API_BASE}/studio/generations/stream`);

    source.onopen = () => onOpen?.();
    source.onerror = (event) => onError?.(event);
    source.onmessage = (event) => {
        if (!event.data) return;
        try {
            onUpdate?.(JSON.parse(event.data));
        } catch {
            // ignore malformed frames
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

