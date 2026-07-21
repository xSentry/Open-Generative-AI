import { decryptSecret, encryptSecret } from '../../auth/server/crypto.js';
import { query } from '../../db/server/db.js';
import { listProviderManifests, requireProviderManifest } from '../publicRegistry.js';

function decryptRow(row) {
  if (!row?.secret_encrypted) return null;
  return decryptSecret({ encrypted: row.secret_encrypted, iv: row.secret_iv, tag: row.secret_tag });
}

export async function getUserProviderCredential(userId, providerId, deps = {}) {
  requireProviderManifest(providerId);
  const queryFn = deps.query || query;
  const result = await queryFn(
    `select secret_encrypted, secret_iv, secret_tag
     from user_provider_credentials where user_id = $1 and provider = $2 limit 1`,
    [userId, providerId],
  );
  return decryptRow(result.rows[0]);
}

export async function upsertUserProviderCredential(userId, providerId, secret, deps = {}) {
  requireProviderManifest(providerId);
  const encrypted = encryptSecret(typeof secret === 'string' ? secret.trim() : '');
  if (!encrypted) throw new TypeError('Provider credential is required.');
  const result = await (deps.query || query)(
    `insert into user_provider_credentials
       (user_id, provider, secret_encrypted, secret_iv, secret_tag)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id, provider) do update set
       secret_encrypted = excluded.secret_encrypted,
       secret_iv = excluded.secret_iv,
       secret_tag = excluded.secret_tag,
       updated_at = now()
     returning user_id, provider, metadata, created_at, updated_at`,
    [userId, providerId, encrypted.encrypted, encrypted.iv, encrypted.tag],
  );
  return result.rows[0] || null;
}

export async function deleteUserProviderCredential(userId, providerId, deps = {}) {
  requireProviderManifest(providerId);
  const result = await (deps.query || query)(
    'delete from user_provider_credentials where user_id = $1 and provider = $2',
    [userId, providerId],
  );
  return result.rowCount > 0;
}

export async function listUserProviderCredentialStates(userId, deps = {}) {
  const queryFn = deps.query || query;
  const result = await queryFn(
    'select provider from user_provider_credentials where user_id = $1',
    [userId],
  );
  const present = new Set(result.rows.map((row) => row.provider));
  return Object.fromEntries(listProviderManifests().map(({ id }) => [id, { hasCredential: present.has(id) }]));
}
