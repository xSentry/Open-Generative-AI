import { query } from '../../db/server/db.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { AuthError } from './errors.js';

export async function createUser({ email, passwordHash, name, replicateApiKey }) {
  const encryptedKey = encryptSecret(replicateApiKey);

  try {
    const result = await query(
      `insert into auth_users (
        email,
        password_hash,
        name,
        replicate_api_key_encrypted,
        replicate_api_key_iv,
        replicate_api_key_tag
      ) values ($1, $2, $3, $4, $5, $6)
      returning *`,
      [
        email,
        passwordHash,
        name,
        encryptedKey?.encrypted ?? null,
        encryptedKey?.iv ?? null,
        encryptedKey?.tag ?? null,
      ]
    );

    return result.rows[0];
  } catch (error) {
    if (error?.code === '23505') {
      throw new AuthError('email_exists', 'Email already exists.', 409);
    }

    throw error;
  }
}

export async function updateUserAccount(userId, { name, email }) {
  try {
    const result = await query(
      `update auth_users
       set name = $2,
           email = $3,
           updated_at = now()
       where id = $1
       returning *`,
      [userId, name, email]
    );

    return result.rows[0] ?? null;
  } catch (error) {
    if (error?.code === '23505') {
      throw new AuthError('email_exists', 'Email already exists.', 409);
    }

    throw error;
  }
}

export async function updateUserReplicateApiKey(userId, replicateApiKey) {
  const encryptedKey = encryptSecret(replicateApiKey);

  if (!encryptedKey) {
    throw new AuthError('invalid_input', 'Replicate API key is required.');
  }

  const result = await query(
    `update auth_users
     set replicate_api_key_encrypted = $2,
         replicate_api_key_iv = $3,
         replicate_api_key_tag = $4,
         updated_at = now()
     where id = $1
     returning *`,
    [userId, encryptedKey.encrypted, encryptedKey.iv, encryptedKey.tag]
  );

  return result.rows[0] ?? null;
}

export async function updateUserMuapiApiKey(userId, muapiApiKey) {
  const encryptedKey = encryptSecret(muapiApiKey);

  if (!encryptedKey) {
    throw new AuthError('invalid_input', 'MuAPI API key is required.');
  }

  const result = await query(
    `update auth_users
     set muapi_api_key_encrypted = $2,
         muapi_api_key_iv = $3,
         muapi_api_key_tag = $4,
         updated_at = now()
     where id = $1
     returning *`,
    [userId, encryptedKey.encrypted, encryptedKey.iv, encryptedKey.tag]
  );

  return result.rows[0] ?? null;
}

export async function updateUserPreferredProvider(userId, preferredProvider) {
  const result = await query(
    `update auth_users
     set preferred_provider = $2,
         updated_at = now()
     where id = $1
     returning *`,
    [userId, preferredProvider]
  );

  return result.rows[0] ?? null;
}

export async function findUserByEmail(email) {
  const result = await query(
    'select * from auth_users where lower(email) = lower($1) limit 1',
    [email]
  );
  return result.rows[0] ?? null;
}

export async function findUserById(id) {
  const result = await query('select * from auth_users where id = $1 limit 1', [id]);
  return result.rows[0] ?? null;
}

export async function getUserReplicateApiKey(userId) {
  const user = await findUserById(userId);
  if (!user?.replicate_api_key_encrypted) {
    return null;
  }

  return decryptSecret({
    encrypted: user.replicate_api_key_encrypted,
    iv: user.replicate_api_key_iv,
    tag: user.replicate_api_key_tag,
  });
}

export async function getUserMuapiApiKey(userId) {
  const user = await findUserById(userId);
  if (!user?.muapi_api_key_encrypted) {
    return null;
  }

  return decryptSecret({
    encrypted: user.muapi_api_key_encrypted,
    iv: user.muapi_api_key_iv,
    tag: user.muapi_api_key_tag,
  });
}

export function toSafeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    provider: user.preferred_provider || 'replicate',
    preferredProvider: user.preferred_provider || 'replicate',
    hasReplicateApiKey: Boolean(user.replicate_api_key_encrypted),
    hasMuapiApiKey: Boolean(user.muapi_api_key_encrypted),
  };
}
