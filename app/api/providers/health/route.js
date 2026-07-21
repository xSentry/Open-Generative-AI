import { NextResponse } from 'next/server';
import { requireUser } from '@/modules/auth/server/auth';
import { refreshProviderDiagnostics } from '@/modules/providers/server/registry';
import { listUserProviderCredentialStates } from '@/modules/providers/server/credentials';
import { errorResponse } from '@/modules/auth/server/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const user = await requireUser(request);
    const credentials = await listUserProviderCredentialStates(user.id);
    return NextResponse.json({
      providers: (await refreshProviderDiagnostics()).map((diagnostic) => ({
        ...diagnostic,
        userCredentialPresent: Boolean(credentials[diagnostic.provider]?.hasCredential),
        userCredentialValidated: null,
      })),
    });
  } catch (error) {
    const { body, status } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
