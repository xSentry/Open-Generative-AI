import { NextResponse } from 'next/server';
import { updateReplicateApiKey } from '@/modules/auth/server/auth';
import { errorResponse } from '@/modules/auth/server/errors';

export const runtime = 'nodejs';

export async function PUT(request) {
  try {
    const body = await request.json();
    const result = await updateReplicateApiKey(request, body);
    return NextResponse.json(result);
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
