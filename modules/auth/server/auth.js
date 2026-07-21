import { hashPassword, verifyPassword } from './password.js';
import {
  createUser,
  findUserByEmail,
  findUserById,
  toSafeUser,
  updateUserAccount,
  updateUserMuapiApiKey,
  updateUserPreferredProvider,
  updateUserReplicateApiKey,
} from './users.js';
import { requireProviderManifest } from '../../providers/publicRegistry.js';
import { upsertUserProviderCredential } from '../../providers/server/credentials.js';
import { readSession } from './session.js';
import { AuthError } from './errors.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function validateEmail(email) {
  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new AuthError('invalid_input', 'A valid email is required.');
  }
}

function validateName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new AuthError('invalid_input', 'Name is required.');
  }
  if (trimmed.length > 120) {
    throw new AuthError('invalid_input', 'Name must be 120 characters or fewer.');
  }
  return trimmed;
}

function validateReplicateApiKey(replicateApiKey) {
  const trimmed = typeof replicateApiKey === 'string' ? replicateApiKey.trim() : '';
  if (!trimmed) {
    throw new AuthError('invalid_input', 'Replicate API key is required.');
  }
  return trimmed;
}

function validateMuapiApiKey(muapiApiKey) {
  const trimmed = typeof muapiApiKey === 'string' ? muapiApiKey.trim() : '';
  if (!trimmed) {
    throw new AuthError('invalid_input', 'MuAPI API key is required.');
  }
  return trimmed;
}

function validateProvider(provider) {
  const normalized = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  requireProviderManifest(normalized);
  return normalized;
}

function validateCredential(credential, manifest) {
  const trimmed = typeof credential === 'string' ? credential.trim() : '';
  if (!trimmed) throw new AuthError('invalid_input', `${manifest.credential.label} is required.`);
  return trimmed;
}

export async function register({ email, password, name }) {
  const normalizedEmail = normalizeEmail(email);
  validateEmail(normalizedEmail);
  const trimmedName = validateName(name);

  const passwordHash = await hashPassword(password);
  const user = await createUser({
    email: normalizedEmail,
    passwordHash,
    name: trimmedName,
  });

  return toSafeUser(user);
}

export async function login({ email, password }) {
  const normalizedEmail = normalizeEmail(email);
  validateEmail(normalizedEmail);

  if (typeof password !== 'string' || password.length === 0) {
    throw new AuthError('invalid_input', 'Password is required.');
  }

  const user = await findUserByEmail(normalizedEmail);
  const passwordMatches = await verifyPassword(password, user?.password_hash);

  if (!user || !passwordMatches) {
    throw new AuthError('invalid_credentials', 'Invalid email or password.', 401);
  }

  return toSafeUser(user);
}

export async function getCurrentUser(request) {
  const session = await readSession(request);
  if (!session?.userId) {
    return null;
  }

  return toSafeUser(await findUserById(session.userId));
}

export async function requireUser(request) {
  const user = await getCurrentUser(request);
  if (!user) {
    throw new AuthError('unauthorized', 'Authentication is required.', 401);
  }

  return user;
}

export async function updateAccount(request, input) {
  const user = await requireUser(request);
  const normalizedEmail = normalizeEmail(input?.email);
  validateEmail(normalizedEmail);
  const trimmedName = validateName(input?.name);

  return toSafeUser(await updateUserAccount(user.id, {
    name: trimmedName,
    email: normalizedEmail,
  }));
}

export async function updateReplicateApiKey(request, input) {
  const user = await requireUser(request);
  const replicateApiKey = validateReplicateApiKey(input?.replicateApiKey);
  const updatedUser = await updateUserReplicateApiKey(user.id, replicateApiKey);

  return {
    hasReplicateApiKey: Boolean(updatedUser),
  };
}

export async function updateProviderSettings(request, input) {
  const user = await requireUser(request);
  const preferredProvider = validateProvider(input?.provider ?? input?.preferredProvider);
  const manifest = requireProviderManifest(preferredProvider);
  let updatedUser = await updateUserPreferredProvider(user.id, preferredProvider);

  if (Object.prototype.hasOwnProperty.call(input ?? {}, 'credential')) {
    await upsertUserProviderCredential(
      user.id,
      preferredProvider,
      validateCredential(input.credential, manifest),
    );
    updatedUser = await findUserById(user.id);
  }

  if (Object.prototype.hasOwnProperty.call(input ?? {}, 'replicateApiKey')) {
    const replicateApiKey = validateReplicateApiKey(input.replicateApiKey);
    updatedUser = await updateUserReplicateApiKey(user.id, replicateApiKey);
  }

  if (Object.prototype.hasOwnProperty.call(input ?? {}, 'muapiApiKey')) {
    const muapiApiKey = validateMuapiApiKey(input.muapiApiKey);
    updatedUser = await updateUserMuapiApiKey(user.id, muapiApiKey);
  }

  return toSafeUser(updatedUser);
}
