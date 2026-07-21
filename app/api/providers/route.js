import { NextResponse } from 'next/server';
import { listProviderManifests } from '@/modules/providers/publicRegistry';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ providers: listProviderManifests() });
}
