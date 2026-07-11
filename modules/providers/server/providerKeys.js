import { requireUser } from '../../auth/server/auth.js';
import {
  getUserMuapiApiKey,
  getUserReplicateApiKey,
} from '../../auth/server/users.js';

function getLegacyMuapiKey(request) {
  return (
    request.headers.get('x-api-key') ||
    request.cookies.get('muapi_key')?.value ||
    process.env.MUAPI_API_KEY ||
    null
  );
}

export async function getActiveProviderKey(request) {
  const user = await requireUser(request);
  const provider = user.preferredProvider || user.provider || 'replicate';

  if (provider === 'muapi') {
    return {
      user,
      provider,
      apiKey: (await getUserMuapiApiKey(user.id)) || getLegacyMuapiKey(request),
    };
  }

  return {
    user,
    provider: 'replicate',
    apiKey: (await getUserReplicateApiKey(user.id)) || process.env.REPLICATE_API_TOKEN || null,
  };
}

export function getProviderMissingKeyMessage(provider) {
  return provider === 'muapi'
    ? 'A MuAPI API key is required for the selected provider.'
    : 'A Replicate API key is required for the selected provider.';
}
