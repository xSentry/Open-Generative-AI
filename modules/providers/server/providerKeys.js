import { requireUser } from '../../auth/server/auth.js';
import { getUserProviderCredential } from './credentials.js';
import { requireProviderManifest } from '../publicRegistry.js';

export async function getActiveProviderKey(request) {
  const user = await requireUser(request);
  const provider = user.preferredProvider || user.provider || 'replicate';
  requireProviderManifest(provider);
  return {
    user,
    provider,
    apiKey: await getUserProviderCredential(user.id, provider),
  };
}

export function getProviderMissingKeyMessage(provider) {
  const manifest = requireProviderManifest(provider);
  return `A ${manifest.credential.label} is required for ${manifest.label}.`;
}
