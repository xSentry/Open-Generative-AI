import { NextResponse } from 'next/server';
import { getActiveProviderKey } from '@/modules/providers/server/providerKeys';
import { createObjectKey } from '@/modules/storage/server/s3';
import { requireProviderOperation } from '@/modules/providers/server/registry';

export const runtime = 'nodejs';

const MUAPI_BASE = 'https://api.muapi.ai';

function cleanHeaders(request) {
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('connection');
    headers.delete('cookie'); // CRITICAL: Stop forwarding browser cookies to MuAPI to avoid auth conflicts
    headers.delete('x-api-key');
    headers.delete('authorization');
    return headers;
}

export async function GET(request, { params }) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const path = pathSegments.join('/');
    
    // Handle alias: get_upload_file -> get_file_upload_url
    const effectivePath = path === 'get_upload_file' ? 'get_file_upload_url' : path;
    
    const { search } = new URL(request.url);

    let active;
    try {
        active = await getActiveProviderKey(request);
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: error.status || 401 });
    }

    if (effectivePath === 'get_file_upload_url') {
        try {
            const adapter = requireProviderOperation(active.provider, 'studio');
            if (!adapter.transports?.appProxy) {
                const url = new URL(request.url);
                const filename = url.searchParams.get('filename') || 'upload';
                const key = createObjectKey({ userId: active.user.id, filename });
                return NextResponse.json({
                    url: '/api/v1/upload-binary',
                    fields: { key, public_url: null },
                    key,
                });
            }
        } catch (error) {
            return NextResponse.json({ error: error.message }, { status: error.status || 400 });
        }
    }

    try {
        requireProviderOperation(active.provider, 'apps');
    } catch (error) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 400 });
    }

    const targetUrl = `${MUAPI_BASE}/app/${effectivePath}${search}`;

    const headers = cleanHeaders(request);

    const apiKey = active.apiKey;
    if (apiKey) headers.set('x-api-key', apiKey);

    try {
        const response = await fetch(targetUrl, {
            headers,
            method: 'GET',
        });

        const data = await response.json();

        // SPECIAL CASE: Intercept upload URL and redirect to local binary proxy
        if (effectivePath === 'get_file_upload_url' && data.url) {
            const originalS3Url = data.url;
            // We pass the real S3 URL as a header to our proxy
            data.url = `/api/upload-binary`;
            
            // Store target in a temporary way? 
            // Better: Return the target URL as an extra field that our proxy will look for
            data.fields = {
                ...data.fields,
                'x-proxy-target-url': originalS3Url
            };
        }

        return NextResponse.json(data, { status: response.status });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(request, { params }) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const path = pathSegments.join('/');

    // Self-hosted providers (e.g. Replicate) have no MuAPI cost API, and their
    // task_names (model ids) are unknown to MuAPI — proxying would 404. Resolve
    // the active provider and compute the dynamic cost locally instead so the
    // builder's useGenerationCost hook works. Only MuAPI keeps proxying.
    let active;
    try {
        active = await getActiveProviderKey(request);
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: error.status || 401 });
    }
    if (path === 'calculate_dynamic_cost') {
        try {
            requireProviderOperation(active.provider, 'apps');
        } catch {
            // No pricing metadata exists for Replicate models in our catalog, so
            // we return a nominal local estimate (see workflow self-hosting plan
            // §9). The local workflow engine does not charge against this value.
            return NextResponse.json({ cost: 0 }, { status: 200 });
        }
    }
    try {
        requireProviderOperation(active.provider, 'apps');
    } catch (error) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 400 });
    }

    const { search } = new URL(request.url);
    const targetUrl = `${MUAPI_BASE}/app/${path}${search}`;

    const headers = cleanHeaders(request);

    const apiKey = active.apiKey;
    if (apiKey) headers.set('x-api-key', apiKey);

    try {
        const body = await request.arrayBuffer();
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body
        });

        const data = await response.json();
        return NextResponse.json(data, { status: response.status });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function DELETE(request, { params }) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const path = pathSegments.join('/');
    
    const { search } = new URL(request.url);
    let active;
    try {
        active = await getActiveProviderKey(request);
        requireProviderOperation(active.provider, 'apps');
    } catch (error) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 400 });
    }
    const targetUrl = `${MUAPI_BASE}/app/${path}${search}`;

    const headers = cleanHeaders(request);

    const apiKey = active.apiKey;
    if (apiKey) headers.set('x-api-key', apiKey);

    try {
        const response = await fetch(targetUrl, {
            method: 'DELETE',
            headers
        });
        const data = await response.json();
        return NextResponse.json(data, { status: response.status });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function PUT(request, { params }) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const path = pathSegments.join('/');
    
    const { search } = new URL(request.url);
    let active;
    try {
        active = await getActiveProviderKey(request);
        requireProviderOperation(active.provider, 'apps');
    } catch (error) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status || 400 });
    }
    const targetUrl = `${MUAPI_BASE}/app/${path}${search}`;

    const headers = cleanHeaders(request);

    const apiKey = active.apiKey;
    if (apiKey) headers.set('x-api-key', apiKey);

    try {
        const body = await request.arrayBuffer();
        const response = await fetch(targetUrl, {
            method: 'PUT',
            headers,
            body
        });
        const data = await response.json();
        return NextResponse.json(data, { status: response.status });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
