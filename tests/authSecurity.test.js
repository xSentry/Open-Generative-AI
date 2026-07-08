import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptSecret, decryptSecret } from '../modules/auth/server/crypto.js';
import { hashPassword, verifyPassword } from '../modules/auth/server/password.js';

process.env.AUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

test('passwords are hashed and verified with bcrypt', async () => {
  const password = 'password123';
  const hash = await hashPassword(password);

  assert.notEqual(hash, password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('provider secrets are encrypted and decrypted without plaintext storage', () => {
  const secret = 'r8_test_secret';
  const encrypted = encryptSecret(secret);

  assert.ok(encrypted.encrypted);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.tag);
  assert.notEqual(encrypted.encrypted, secret);
  assert.equal(decryptSecret(encrypted), secret);
});
