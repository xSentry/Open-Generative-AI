import { SERVER_FEATURE_OPERATIONS } from '../core/contracts.js';
import { requireProviderFeature, requireProviderManifest } from '../publicRegistry.js';
import { muapiAdapter } from '../muapi/server/adapter.js';
import { replicateAdapter } from '../replicate/server/adapter.js';
import { instrumentProviderAdapter } from './operations.js';

export function createServerRegistry(adapters, { manifests = null } = {}) {
  const byId = new Map();
  const diagnostics = new Map();
  const localManifests = manifests ? new Map(manifests.map((manifest) => [manifest.id, manifest])) : null;
  for (const adapter of adapters) {
    if (!adapter?.id) throw new TypeError('Provider adapter must have an id.');
    if (byId.has(adapter.id)) throw new TypeError(`Duplicate provider adapter id "${adapter.id}".`);
    const manifest = localManifests?.get(adapter.id) || requireProviderManifest(adapter.id);
    if (manifest.id !== adapter.id) throw new TypeError(`Provider manifest and adapter ids do not match for "${adapter.id}".`);
    for (const [feature, operations] of Object.entries(SERVER_FEATURE_OPERATIONS)) {
      if (manifest.features?.[feature] !== true) continue;
      for (const operation of operations) {
        if (!adapter[operation]) throw new TypeError(`Provider "${adapter.id}" enables ${feature} without adapter.${operation}.`);
      }
    }
    if (typeof adapter.catalog?.getModelLists !== 'function' || typeof adapter.catalog?.getModelById !== 'function') {
      throw new TypeError(`Provider "${adapter.id}" must implement catalog.getModelLists() and catalog.getModelById().`);
    }
    const needsPredictions = ['studio', 'workflow', 'agents', 'designAgent']
      .some((feature) => manifest.features?.[feature] === true);
    if (needsPredictions && typeof adapter.predictions?.run !== 'function') {
      throw new TypeError(`Provider "${adapter.id}" enables inference features without predictions.run().`);
    }
    if (manifest.features?.workflowArchitect === true
      && typeof adapter.workflowArchitect?.generateCreateWorkflowIr !== 'function') {
      throw new TypeError(`Provider "${adapter.id}" enables workflowArchitect without workflowArchitect.generateCreateWorkflowIr().`);
    }
    let catalogModelCount = null;
    let catalogLoaded = false;
    if (typeof adapter.catalog?.getModelListsSync === 'function') {
      const lists = adapter.catalog.getModelListsSync();
      catalogModelCount = Object.values(lists).reduce((total, models) => total + models.length, 0);
      catalogLoaded = true;
    }
    const registered = instrumentProviderAdapter(adapter);
    byId.set(adapter.id, registered);
    diagnostics.set(adapter.id, Object.freeze({
      provider: adapter.id,
      configurationAvailable: true,
      catalogLoaded,
      catalogModelCount,
      transportReachable: null,
      features: { ...manifest.features },
    }));
  }
  return {
    listProviderAdapters: () => [...byId.values()],
    getProviderAdapter: (id) => byId.get(id) || null,
    listProviderDiagnostics: () => [...diagnostics.values()],
    async refreshProviderDiagnostics() {
      for (const [id, adapter] of byId) {
        const current = diagnostics.get(id);
        try {
          const lists = await adapter.catalog.getModelLists();
          diagnostics.set(id, Object.freeze({
            ...current,
            catalogLoaded: true,
            catalogModelCount: Object.values(lists).reduce((total, models) => total + models.length, 0),
            catalogErrorCode: null,
          }));
        } catch (error) {
          diagnostics.set(id, Object.freeze({ ...current, catalogLoaded: false, catalogErrorCode: error.code || 'provider_catalog_invalid' }));
        }
      }
      return [...diagnostics.values()];
    },
    requireProviderAdapter(id) {
      if (localManifests && !localManifests.has(id)) {
        const error = new Error(`Unknown provider "${id || ''}".`);
        error.code = 'unknown_provider';
        error.status = 400;
        throw error;
      }
      if (!localManifests) requireProviderManifest(id);
      const adapter = byId.get(id);
      if (!adapter) throw new TypeError(`Provider "${id}" has no registered server adapter.`);
      return adapter;
    },
  };
}

const registry = createServerRegistry([replicateAdapter, muapiAdapter]);
export const listProviderAdapters = registry.listProviderAdapters;
export const getProviderAdapter = registry.getProviderAdapter;
export const requireProviderAdapter = registry.requireProviderAdapter;
export const listProviderDiagnostics = registry.listProviderDiagnostics;
export const refreshProviderDiagnostics = registry.refreshProviderDiagnostics;

export function requireProviderOperation(providerId, feature) {
  requireProviderFeature(providerId, feature);
  return requireProviderAdapter(providerId);
}
