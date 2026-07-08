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

export function middleware(request) {
    const url = request.nextUrl;
    const pathname = url.pathname;

    const isProtectedPage = PROTECTED_PAGE_PREFIXES.some((prefix) =>
        pathname === prefix || pathname.startsWith(`${prefix}/`)
    );

    if (!isPublicPath(pathname) && isProtectedPage && !hasSessionCookie(request)) {
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('next', pathname + url.search);
        return NextResponse.redirect(loginUrl);
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
            return NextResponse.rewrite(targetUrl);
        }
    }

    return NextResponse.next();
}

// Match the paths we want to proxy
export const config = {
    matcher: [
        '/studio/:path*',
        '/workflow/:path*',
        '/agents/:path*',
        '/assistant/:path*',
        '/settings/:path*',
        '/api/workflow/:path*', 
        '/api/app/:path*',
        '/api/v1/:path*'
    ],
};
