import { NextResponse } from 'next/server';
import { errorResponse } from '@/modules/auth/server/errors';
import { getActiveProviderKey } from '@/modules/providers/server/providerKeys';
import {
    assertS3Config,
    createObjectKey,
    createPresignedGetUrl,
    getS3Config,
} from '@/modules/storage/server/s3';
import { requireProviderOperation } from '@/modules/providers/server/registry';

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

export async function GET(request) {
    const { search } = new URL(request.url);
    let active;

    try {
        active = await getActiveProviderKey(request);
        const adapter = requireProviderOperation(active.provider, 'studio');
        if (!adapter.uploads?.usesProviderUploadProxy) {
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
    const apiKey = active.apiKey;
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
