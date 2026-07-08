import { NextResponse } from 'next/server';
import { login } from '@/modules/auth/server/auth';
import { createSessionCookie } from '@/modules/auth/server/session';
import { errorResponse } from '@/modules/auth/server/errors';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const body = await request.json();
    const user = await login(body);
    const response = NextResponse.json({ user });
    response.headers.set('Set-Cookie', await createSessionCookie(user));
    return response;
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
