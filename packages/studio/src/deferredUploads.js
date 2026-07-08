// Deferred (lazy) upload registry for studio inputs.
//
// Previously, selecting a file in any studio tool uploaded it to S3 immediately,
// even if the user never pressed "Generate". That left orphaned/stale objects in
// the bucket. Instead, we now hold the selected `File` in the browser and hand
// the UI a local `blob:` URL for preview. The real S3 upload is deferred until
// the generation is actually submitted, at which point `resolveDeferred` walks
// the outgoing params and swaps every deferred `blob:` URL for its uploaded URL.
//
// This module is provider/tool agnostic: it only knows how to hold files and,
// given an `uploader(file) -> Promise<url>`, resolve them on demand. The concrete
// uploader (the S3/MinIO XHR) lives in `muapi.js`.

// blob: URL -> { file, promise, url }
const registry = new Map();

// Register a selected File and return a local blob: URL to use for preview.
// The file is NOT uploaded here — only when the generation is submitted.
export function registerDeferredFile(file) {
    if (typeof URL === 'undefined' || !URL.createObjectURL) {
        // No browser URL API (SSR). Callers only invoke this on user interaction,
        // so this path is effectively unreachable, but stay defensive.
        throw new Error('registerDeferredFile requires a browser environment');
    }
    const key = URL.createObjectURL(file);
    registry.set(key, { file, promise: null, url: null });
    return key;
}

// Whether a value is a blob: URL we are holding a pending file for.
export function isDeferredUrl(value) {
    return typeof value === 'string' && registry.has(value);
}

// Upload a single held file (once), caching the resulting URL so repeated
// resolutions (e.g. batch generations reusing the same input) upload only once.
async function uploadDeferred(key, uploader) {
    const entry = registry.get(key);
    if (!entry) return key;
    if (entry.url) return entry.url;
    if (!entry.promise) {
        entry.promise = Promise.resolve(uploader(entry.file)).then((url) => {
            entry.url = url;
            return url;
        });
    }
    return entry.promise;
}

// Deep-walk any params value and replace deferred blob: URLs with their uploaded
// S3 URLs. Non-deferred strings (e.g. already-hosted URLs restored from history)
// pass through untouched. `uploader` is `(file) => Promise<url>`.
export async function resolveDeferred(value, uploader) {
    if (typeof value === 'string') {
        return isDeferredUrl(value) ? uploadDeferred(value, uploader) : value;
    }
    if (Array.isArray(value)) {
        return Promise.all(value.map((item) => resolveDeferred(item, uploader)));
    }
    if (value && typeof value === 'object') {
        const entries = await Promise.all(
            Object.entries(value).map(async ([k, v]) => [k, await resolveDeferred(v, uploader)]),
        );
        const out = {};
        for (const [k, v] of entries) out[k] = v;
        return out;
    }
    return value;
}

// Release a held file and revoke its blob: URL (frees browser memory). Safe to
// call with any value; no-ops for non-deferred URLs.
export function releaseDeferred(value) {
    if (!isDeferredUrl(value)) return;
    try {
        URL.revokeObjectURL(value);
    } catch {
        // ignore
    }
    registry.delete(value);
}

