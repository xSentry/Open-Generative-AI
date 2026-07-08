import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/modules/auth/server/session';

export const runtime = 'nodejs';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.headers.set('Set-Cookie', clearSessionCookie());
  return response;
}
