import { NextResponse } from 'next/server';
import { errorResponse } from '@/modules/auth/server/errors';
import { getActiveProviderKey } from '@/modules/providers/server/providerKeys';
import {
    assertS3Config,
    createObjectKey,
    createPresignedGetUrl,
    getS3Config,
} from '@/modules/storage/server/s3';

const MUAPI_BASE = 'https://api.muapi.ai';

function getApiKey(request) {
    const headerKey = request.headers.get('x-api-key');
    if (headerKey) return headerKey;
    // Cookie-based auth removed for security (CWE-522)
    return null;
}

function cleanHeaders(request) {
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('connection');
    headers.delete('cookie');
    return headers;
}

export async function GET(request) {
    const { search } = new URL(request.url);

    try {
        const active = await getActiveProviderKey(request);
        if (active.provider !== 'muapi') {
            const url = new URL(request.url);
            const filename = url.searchParams.get('filename') || 'upload';
            const config = getS3Config();
            assertS3Config(config);
            const key = createObjectKey({ userId: active.user.id, filename });
            const publicUrl = createPresignedGetUrl({ config, key });

            return NextResponse.json({
                url: '/api/v1/upload-binary',
                fields: {
                    key,
                    public_url: publicUrl,
                    provider: active.provider,
                },
                public_url: publicUrl,
            });
        }
    } catch (error) {
        const { body, status } = errorResponse(error);
        if (status !== 500) return NextResponse.json(body, { status });
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const targetUrl = `${MUAPI_BASE}/app/get_file_upload_url${search}`;

    const headers = cleanHeaders(request);
    const apiKey = getApiKey(request);
    if (apiKey) headers.set('x-api-key', apiKey);

    try {
        const response = await fetch(targetUrl, {
            headers,
            method: 'GET',
        });

        const data = await response.json();

        return NextResponse.json(data, { status: response.status });
    } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
