import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE_NAME = 'auth_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function getSessionSecret() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) {
    throw new Error('AUTH_SESSION_SECRET is required.');
  }

  return new TextEncoder().encode(secret);
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  return parts.join('; ');
}

export async function createSessionCookie(user) {
  const token = await new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret());

  return serializeCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
  });
}

export async function readSession(request) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getSessionSecret());
    return {
      userId: payload.sub,
      email: payload.email,
    };
  } catch {
    return null;
  }
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
    expires: new Date(0),
    path: '/',
  });
}

export function hasSessionCookie(request) {
  return Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}
