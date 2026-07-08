import bcrypt from 'bcryptjs';
import { AuthError } from './errors.js';

const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_COST = 12;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(
      'invalid_input',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    );
  }

  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password, passwordHash) {
  if (typeof password !== 'string' || !passwordHash) {
    return false;
  }

  return bcrypt.compare(password, passwordHash);
}
