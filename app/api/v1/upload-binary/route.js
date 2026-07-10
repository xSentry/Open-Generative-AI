import { NextResponse } from 'next/server';
import { errorResponse } from '@/modules/auth/server/errors';
import { getActiveProviderKey } from '@/modules/providers/server/providerKeys';
import { createPresignedGetUrl, getS3Config, uploadObject } from '@/modules/storage/server/s3';
import { validateUploadProxyTarget } from '../../../../src/lib/uploadProxyTarget';

export async function POST(request) {
    try {
        let active = null;
        try {
            active = await getActiveProviderKey(request);
        } catch {
            active = null;
        }

        const formData = await request.formData();

        // Extract the original S3 target URL
        const targetUrl = formData.get('x-proxy-target-url');
        const key = formData.get('key');
        const file = formData.get('file');

        if (active?.provider && active.provider !== 'muapi' && key && file?.arrayBuffer) {
            const config = getS3Config();
            await uploadObject({
                config,
                key: String(key),
                body: Buffer.from(await file.arrayBuffer()),
                contentType: file.type || 'application/octet-stream',
            });
            const url = createPresignedGetUrl({ config, key: String(key) });
            return NextResponse.json({ url, key: String(key) });
        }

        if (!targetUrl) {
            return NextResponse.json({ error: 'Missing proxy target URL' }, { status: 400 });
        }

        const validatedTarget = validateUploadProxyTarget(targetUrl);
        if (!validatedTarget.ok) {
            return NextResponse.json(
                { error: 'Invalid upload target', reason: validatedTarget.reason },
                { status: 400 }
            );
        }

        const s3FormData = new FormData();
        for (const [key, value] of formData.entries()) {
            if (key !== 'x-proxy-target-url') {
                s3FormData.append(key, value);
            }
        }

        const s3Response = await fetch(validatedTarget.url, {
            method: 'POST',
            body: s3FormData,
        });

        if (s3Response.ok || s3Response.status === 204) {
            return new Response(null, { status: 204 });
        } else {
            const errorText = await s3Response.text();
            console.error('S3 Proxy Error:', errorText);
            return new Response(errorText, { status: s3Response.status });
        }
    } catch (error) {
        console.error('Upload Proxy Exception:', error);
        const { body, status } = errorResponse(error);
        return NextResponse.json(status === 500 ? { error: error.message } : body, { status });
    }
}
