import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getUserProviderCredential,
  listUserProviderCredentialStates,
  upsertUserProviderCredential,
} from '../modules/providers/server/credentials.js';

test('generic credentials encrypt round-trip and stay isolated by user and provider', async () => {
  const previousKey = process.env.AUTH_ENCRYPTION_KEY;
  process.env.AUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const rows = new Map();
  const query = async (sql, params) => {
    if (sql.includes('insert into user_provider_credentials')) {
      rows.set(`${params[0]}:${params[1]}`, { secret_encrypted: params[2], secret_iv: params[3], secret_tag: params[4] });
      return { rows: [{ user_id: params[0], provider: params[1] }], rowCount: 1 };
    }
    if (sql.includes('from user_provider_credentials')) {
      const row = rows.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [{}], rowCount: 1 };
  };

  try {
    await upsertUserProviderCredential('user-a', 'replicate', 'r8_alpha', { query });
    await upsertUserProviderCredential('user-a', 'muapi', 'mu_beta', { query });
    assert.equal(await getUserProviderCredential('user-a', 'replicate', { query }), 'r8_alpha');
    assert.equal(await getUserProviderCredential('user-a', 'muapi', { query }), 'mu_beta');
    assert.equal(await getUserProviderCredential('user-b', 'replicate', { query }), null);
    assert.doesNotMatch(JSON.stringify([...rows.values()]), /r8_alpha|mu_beta/);
  } finally {
    if (previousKey === undefined) delete process.env.AUTH_ENCRYPTION_KEY;
    else process.env.AUTH_ENCRYPTION_KEY = previousKey;
  }
});

test('credential reads and status checks use only user_provider_credentials', async () => {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('select provider from user_provider_credentials')) {
      return { rows: [{ provider: 'replicate' }], rowCount: 1 };
    }
    if (sql.includes('from user_provider_credentials')) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected credential query: ${sql}`);
  };

  assert.equal(await getUserProviderCredential('user-a', 'replicate', { query }), null);
  const states = await listUserProviderCredentialStates('user-a', { query });
  assert.equal(states.replicate.hasCredential, true);
  assert.equal(states.muapi.hasCredential, false);
  assert.equal(queries.some(({ sql }) => sql.includes('from auth_users')), false);
});
