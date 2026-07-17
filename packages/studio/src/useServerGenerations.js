// Shared React hook that backs studio components with server-persisted, async
// generations. It loads the user's history from the server, starts generations
// (returning optimistic cards immediately and polling in-flight items until they
// resolve), and supports deletion.
//
// Falls back to a disabled/no-op state when not running in a hosted browser
// (e.g. Electron file://), so components can keep their legacy local flow.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    deleteGeneration,
    listGenerations,
    pollGenerations,
    startGeneration,
    subscribeGenerations,
} from './generations.js';

export function isHostedBrowser() {
    return typeof window !== 'undefined' && window.location?.protocol?.startsWith('http');
}

function randomId() {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch {
        // ignore
    }
    return `tmp-${Math.random().toString(36).slice(2)}`;
}

// Normalize a server generation record into the flat shape studio grids render.
function mapCard(generation) {
    return {
        id: generation.id,
        url: generation.url || null,
        prompt: generation.prompt || '',
        model: generation.model,
        mode: generation.mode,
        params: generation.params || {},
        mediaType: generation.mediaType,
        providerCreatedAt: generation.providerCreatedAt || null,
        createdAt: generation.createdAt || null,
        aspect_ratio: generation.outputMeta?.aspect_ratio,
        outputType: generation.outputType || null,
        status: generation.status || 'succeeded',
        error: generation.error || null,
        // Preserve an already received estimate when an older server response
        // does not include the field. New persisted rows always include it.
        ...(Object.prototype.hasOwnProperty.call(generation, 'runtimeEstimate')
            ? { runtimeEstimate: generation.runtimeEstimate }
            : {}),
        timestamp: generation.createdAt || new Date().toISOString(),
    };
}

export function useServerGenerations({ mediaType, mode, enabled = true, onSucceeded } = {}) {
    const active = enabled && isHostedBrowser();
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(false);
    const cancelers = useRef([]);
    const sseConnected = useRef(false);
    const refreshRequest = useRef(0);
    const onSucceededRef = useRef(onSucceeded);
    onSucceededRef.current = onSucceeded;

    // Normalize the accepted mode(s) into a stable Set so we can both scope the
    // server query and filter live (SSE) updates to this tool's own history.
    const modeList = Array.isArray(mode) ? mode.filter(Boolean) : mode ? [mode] : [];
    const modeKey = modeList.join(',');
    const modeSet = useRef(new Set());
    modeSet.current = new Set(modeList);
    const matchesMode = useCallback(
        (card) => modeSet.current.size === 0 || modeSet.current.has(card?.mode),
        [],
    );

    const refresh = useCallback(async () => {
        if (!active) return;
        const requestId = ++refreshRequest.current;
        setLoading(true);
        try {
            const data = await listGenerations({ mediaType, mode: modeKey || undefined });
            // A later reconnect refresh or live update has newer state.
            if (requestId !== refreshRequest.current) return;
            setItems((data.items || []).map(mapCard));
        } catch (error) {
            console.warn('[useServerGenerations] failed to load history:', error?.message || error);
        } finally {
            if (requestId === refreshRequest.current) setLoading(false);
        }
    }, [active, mediaType, modeKey]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // Clean up any pollers on unmount.
    useEffect(() => () => cancelers.current.forEach((cancel) => cancel()), []);

    const upsert = useCallback((card) => {
        setItems((prev) => {
            const idx = prev.findIndex((item) => item.id === card.id);
            if (idx === -1) return [card, ...prev];
            const next = prev.slice();
            next[idx] = { ...next[idx], ...card };
            return next;
        });
    }, []);

    const beginPolling = useCallback((ids) => {
        if (ids.length === 0) return;
        const cancel = pollGenerations(ids, (generation) => {
            const card = mapCard(generation);
            upsert(card);
            if (card.status === 'succeeded' && card.url) {
                onSucceededRef.current?.(card);
            }
        });
        cancelers.current.push(cancel);
    }, [upsert]);

    // Live updates via SSE. When connected we skip per-item polling entirely.
    useEffect(() => {
        if (!active) return undefined;
        const dispose = subscribeGenerations({
            onOpen: () => {
                sseConnected.current = true;
                // Redis events are live-only. Rehydrate after every initial
                // connection and reconnect so an update that happened between
                // the first history request and subscription (or during a
                // dropped connection) cannot leave cards stale.
                refresh();
            },
            onError: () => {
                sseConnected.current = false;
            },
            onUpdate: (generation) => {
                const card = mapCard(generation);
                // Ignore updates for other tools' generations (the SSE stream is
                // per-user, not per-mode) so pages don't cross-populate.
                if (!matchesMode(card)) return;
                // Prevent an older in-flight history response from replacing
                // this event-hydrated record.
                refreshRequest.current += 1;
                setLoading(false);
                upsert(card);
                if (card.status === 'succeeded' && card.url) {
                    onSucceededRef.current?.(card);
                }
            },
        });
        return () => {
            sseConnected.current = false;
            dispose?.();
        };
    }, [active, matchesMode, refresh, upsert]);

    // Start `count` independent generations. Returns immediately after the
    // requests are accepted; in-flight items resolve via SSE (or polling
    // fallback when SSE is unavailable).
    const generate = useCallback(async ({ mode, model, params, count = 1 }) => {
        const pendingIds = [];
        const requests = Array.from({ length: Math.max(1, count) }).map(async () => {
            const data = await startGeneration({ mode, model, params });
            if (Array.isArray(data?.generations)) {
                data.generations.forEach((generation) => {
                    const card = mapCard(generation);
                    upsert(card);
                    if (card.status === 'generating') pendingIds.push(card.id);
                    else if (card.status === 'succeeded') onSucceededRef.current?.(card);
                });
            } else if (data?.generation) {
                const card = mapCard(data.generation);
                upsert(card);
                if (card.status === 'succeeded') onSucceededRef.current?.(card);
            } else if (data?.url) {
                // Legacy synchronous response without a DB row.
                const card = mapCard({ id: data.id || randomId(), ...data, status: 'succeeded' });
                upsert(card);
                onSucceededRef.current?.(card);
            }
        });

        await Promise.all(requests);
        // Only poll when the live SSE stream isn't connected.
        if (!sseConnected.current) beginPolling(pendingIds);
    }, [upsert, beginPolling]);

    const remove = useCallback(async (id) => {
        setItems((prev) => prev.filter((item) => item.id !== id));
        try {
            await deleteGeneration(id);
        } catch (error) {
            console.warn('[useServerGenerations] delete failed:', error?.message || error);
        }
    }, []);

    return { active, items, loading, generate, remove, refresh, setItems };
}

