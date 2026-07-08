import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ user: null }, { status: 401 });
    }

    return NextResponse.json({ user });
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
