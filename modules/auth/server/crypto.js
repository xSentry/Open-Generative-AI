import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getEncryptionKey() {
  const encoded = process.env.AUTH_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error('AUTH_ENCRYPTION_KEY is required.');
  }

  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('AUTH_ENCRYPTION_KEY must be a base64 encoded 32 byte key.');
  }

  return key;
}

export function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    return null;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(secret) {
  if (!secret?.encrypted || !secret?.iv || !secret?.tag) {
    return null;
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(secret.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(secret.encrypted, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
