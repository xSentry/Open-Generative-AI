import { NextResponse } from 'next/server';
import { updateProviderSettings } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';

export const runtime = 'nodejs';

export async function PUT(request) {
  try {
    const body = await request.json();
    const user = await updateProviderSettings(request, body);
    return NextResponse.json({ user });
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
