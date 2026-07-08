import { NextResponse } from 'next/server';
import { getCurrentUser, updateAccount } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: 'Authentication is required.' } },
        { status: 401 }
      );
    }

    return NextResponse.json({ user });
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const user = await updateAccount(request, body);
    return NextResponse.json({ user });
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
