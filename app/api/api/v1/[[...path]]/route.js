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
import { getChatJob } from '@/modules/agents/server/repo';

const MUAPI_BASE = 'https://api.muapi.ai';

function cleanHeaders(request) {
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('connection');
    headers.delete('cookie');
    headers.delete('x-api-key');
    headers.delete('authorization');
    return headers;
}

// Proxies /api/api/v1/* -> https://api.muapi.ai/api/v1/*
// This is required because the AiAgent library hardcodes a double /api/api
export async function GET(request, { params }) {
    const slug = await params;
    const pathSegments = slug.path || [];
    const path = pathSegments.join('/');
    let active;

    try {
        active = await getActiveProviderKey(request);
    } catch (error) {
        const { body, status } = errorResponse(error);
        return NextResponse.json(body, { status });
    }

    if (pathSegments.length === 3 && pathSegments[0] === 'predictions' && pathSegments[2] === 'result') {
        if (active.provider !== 'muapi') {
                const job = await getChatJob(pathSegments[1], {
                    userId: active.user.id,
                    provider: active.provider,
                });
                if (!job) {
                    return NextResponse.json({ error: 'Prediction not found.' }, { status: 404 });
                }
                if (job.result) {
                    return NextResponse.json(job.result, { status: 200 });
                }
                return NextResponse.json({
                    status: job.status,
                    is_complete: job.status === 'failed',
                    error: job.error || null,
                    messages: job.error ? [{ role: 'assistant', content: job.error }] : [],
                    suggestions: [],
                }, { status: 200 });
        }
    }
    if (active.provider !== 'muapi') {
        return NextResponse.json({ error: 'provider_feature_unsupported' }, { status: 400 });
    }
    
    const { search } = new URL(request.url);
    const targetUrl = `${MUAPI_BASE}/api/v1/${path}${search}`;

    const headers = cleanHeaders(request);
    const apiKey = active.apiKey;

    // NOTE: credential logging removed for security (CWE-200)
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
            proxyMuapiV1Request,
            runReplicatePrediction,
        },
    });
}
