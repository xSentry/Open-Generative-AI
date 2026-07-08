import { NextResponse } from 'next/server';
import { errorResponse } from '@/modules/auth/server/errors';
import {
    getActiveProviderKey,
    getProviderMissingKeyMessage,
} from '@/modules/providers/server/providerKeys';
import { proxyMuapiV1Request } from '@/modules/providers/muapi/server/run';
import { handleMuapiV1PostRequest } from '@/modules/studio/server/apiHandlers';
import { findReplicateModelByEndpoint } from '@/modules/providers/replicate/server/catalog';
import { runReplicatePrediction } from '@/modules/providers/replicate/server/run';

const MUAPI_BASE = 'https://api.muapi.ai';

function getApiKey(request) {
    const headerKey = request.headers.get('x-api-key');
    if (headerKey) return headerKey;
    const cookieKey = request.cookies.get('muapi_key')?.value;
    return cookieKey;
}

function cleanHeaders(request) {
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('connection');
    headers.delete('cookie');
    return headers;
}

// Proxies /api/api/v1/* -> https://api.muapi.ai/api/v1/*
// This is required because the AiAgent library hardcodes a double /api/api
export async function GET(request, { params }) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const path = pathSegments.join('/');
    
    const { search } = new URL(request.url);
    const targetUrl = `${MUAPI_BASE}/api/v1/${path}${search}`;

    const headers = cleanHeaders(request);
    const apiKey = getApiKey(request);
    
    if (apiKey) headers.set('x-api-key', apiKey);

    try {
        const response = await fetch(targetUrl, { headers, method: 'GET' });
        const data = await response.json();
        return NextResponse.json(data, { status: response.status });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(request, { params }) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const path = pathSegments.join('/');

    return handleMuapiV1PostRequest(request, {
        path,
        deps: {
            errorResponse,
            findReplicateModelByEndpoint,
            getActiveProviderKey,
            getProviderMissingKeyMessage,
            getRequestApiKey: getApiKey,
            proxyMuapiV1Request,
            runReplicatePrediction,
        },
    });
}
