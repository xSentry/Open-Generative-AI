import { unsupportedFeature, unsupportedMode, unknownProvider } from './core/errors.js';
import { validateProviderManifest } from './core/publicManifest.js';
import { muapiManifest } from './muapi/manifest.js';
import { replicateManifest } from './replicate/manifest.js';

export function createPublicRegistry(manifests) {
  const byId = new Map();
  for (const manifest of manifests) {
    validateProviderManifest(manifest);
    if (byId.has(manifest.id)) throw new TypeError(`Duplicate provider id "${manifest.id}".`);
    byId.set(manifest.id, manifest);
  }
  return {
    listProviderManifests: () => [...byId.values()],
    getProviderManifest: (id) => byId.get(id) || null,
    requireProviderManifest(id) {
      const manifest = byId.get(id);
      if (!manifest) throw unknownProvider(id);
      return manifest;
    },
  };
}

const registry = createPublicRegistry([replicateManifest, muapiManifest]);
export const listProviderManifests = registry.listProviderManifests;
export const getProviderManifest = registry.getProviderManifest;
export const requireProviderManifest = registry.requireProviderManifest;

export function requireProviderFeature(providerId, feature) {
  const manifest = requireProviderManifest(providerId);
  if (manifest.features?.[feature] !== true) throw unsupportedFeature(providerId, feature);
  return manifest;
}

export function requireProviderMode(providerId, mode) {
  const manifest = requireProviderManifest(providerId);
  if (!manifest.modes.includes(mode)) throw unsupportedMode(providerId, mode);
  return manifest;
}

