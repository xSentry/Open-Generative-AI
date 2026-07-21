import { query } from '../../db/server/db.js';
import { AuthError } from './errors.js';
import {
  getUserProviderCredential,
  listUserProviderCredentialStates,
  upsertUserProviderCredential,
} from '../../providers/server/credentials.js';

export async function createUser({ email, passwordHash, name }) {
  try {
    const result = await query(
      `insert into auth_users (email, password_hash, name)
      values ($1, $2, $3)
      returning *`,
      [email, passwordHash, name]
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
  if (typeof replicateApiKey !== 'string' || !replicateApiKey.trim()) {
    throw new AuthError('invalid_input', 'Replicate API key is required.');
  }
  await upsertUserProviderCredential(userId, 'replicate', replicateApiKey);
  return findUserById(userId);
}

export async function updateUserMuapiApiKey(userId, muapiApiKey) {
  if (typeof muapiApiKey !== 'string' || !muapiApiKey.trim()) {
    throw new AuthError('invalid_input', 'MuAPI API key is required.');
  }
  await upsertUserProviderCredential(userId, 'muapi', muapiApiKey);
  return findUserById(userId);
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
  return getUserProviderCredential(userId, 'replicate');
}

export async function getUserMuapiApiKey(userId) {
  return getUserProviderCredential(userId, 'muapi');
}

export async function toSafeUser(user) {
  if (!user) {
    return null;
  }

  const providerCredentials = await listUserProviderCredentialStates(user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    provider: user.preferred_provider || 'replicate',
    preferredProvider: user.preferred_provider || 'replicate',
    providerCredentials,
  };
}
