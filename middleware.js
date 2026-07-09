import { NextResponse } from 'next/server';
import { hasSessionCookie } from './modules/auth/server/session';

const PROTECTED_PAGE_PREFIXES = [
    '/studio',
    '/workflow',
    '/agents',
    '/assistant',
    '/settings',
];

function isPublicPath(pathname) {
    return (
        pathname === '/login' ||
        pathname.startsWith('/api/auth') ||
        pathname.startsWith('/_next') ||
        pathname.startsWith('/assets') ||
        pathname === '/favicon.ico' ||
        pathname === '/robots.txt' ||
        pathname === '/sitemap.xml'
    );
}

function addSecurityHeaders(response) {
    // Prevent MIME type sniffing (CWE-693)
    response.headers.set('X-Content-Type-Options', 'nosniff');
    // Prevent clickjacking (CWE-1021)
    response.headers.set('X-Frame-Options', 'DENY');
    // Enable XSS filter in legacy browsers
    response.headers.set('X-XSS-Protection', '1; mode=block');
    // Referrer policy
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Allow local MinIO during self-hosted development while keeping arbitrary
    // non-HTTPS origins blocked. Production S3/CDN URLs should remain HTTPS.
    const localS3Sources = 'http://localhost:9000 http://127.0.0.1:9000';
    response.headers.set(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: ${localS3Sources}; media-src 'self' data: blob: https: ${localS3Sources}; connect-src 'self' https: ${localS3Sources}; font-src 'self' data:;`
    );
    return response;
}

export function middleware(request) {
    const url = request.nextUrl;
    const pathname = url.pathname;

    const isProtectedPage = PROTECTED_PAGE_PREFIXES.some((prefix) =>
        pathname === prefix || pathname.startsWith(`${prefix}/`)
    );

    if (!isPublicPath(pathname) && isProtectedPage && !hasSessionCookie(request)) {
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('next', pathname + url.search);
        return addSecurityHeaders(NextResponse.redirect(loginUrl));
    }

    // Catch requests to /api/workflow, /api/app, and /api/v1
    const isMuApi = pathname.startsWith('/api/workflow') ||
                    pathname.startsWith('/api/app') ||
                    pathname.startsWith('/api/v1');

    if (isMuApi) {
        // Exclude paths that have their own dedicated route handlers with custom logic
        const isHandledByRoute = pathname.startsWith('/api/v1/creative-agent') ||
                                pathname.startsWith('/api/v1/get_upload_url') ||
                                pathname.startsWith('/api/v1/upload-binary');

        if (pathname.startsWith('/api/v1') && !isHandledByRoute) {
            const targetUrl = new URL(pathname + url.search, 'https://api.muapi.ai');
            return addSecurityHeaders(NextResponse.rewrite(targetUrl));
        }
    }

    // Add security headers to all responses
    return addSecurityHeaders(NextResponse.next());
}

// Match all pages/API routes for security headers. Exclude Next.js internals.
export const config = {
    matcher: [
        '/api/:path*',
        '/((?!_next/static|_next/image|favicon.ico|__nextjs_original-stack-frame).*)',
    ],
};
