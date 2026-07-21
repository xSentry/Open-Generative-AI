import { PROVIDER_FEATURES, PROVIDER_ID_PATTERN, PROVIDER_MODES } from './contracts.js';

export function validateProviderManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('Provider manifest must be an object.');
  if (!PROVIDER_ID_PATTERN.test(manifest.id || '')) throw new TypeError(`Invalid provider id "${manifest.id || ''}".`);
  if (!String(manifest.label || '').trim()) throw new TypeError(`Provider "${manifest.id}" must have a label.`);
  if (!String(manifest.credential?.label || '').trim()) throw new TypeError(`Provider "${manifest.id}" must have a credential label.`);

  for (const [feature, enabled] of Object.entries(manifest.features || {})) {
    if (!PROVIDER_FEATURES.includes(feature)) throw new TypeError(`Provider "${manifest.id}" declares unknown feature "${feature}".`);
    if (typeof enabled !== 'boolean') throw new TypeError(`Provider feature "${feature}" must be boolean.`);
  }
  for (const mode of manifest.modes || []) {
    if (!PROVIDER_MODES.includes(mode)) throw new TypeError(`Provider "${manifest.id}" declares unknown mode "${mode}".`);
  }
  return manifest;
}

export function publicManifest(manifest) {
  return Object.freeze(validateProviderManifest({
    ...manifest,
    credential: Object.freeze({ ...manifest.credential }),
    features: Object.freeze({ ...manifest.features }),
    modes: Object.freeze([...(manifest.modes || [])]),
  }));
}

