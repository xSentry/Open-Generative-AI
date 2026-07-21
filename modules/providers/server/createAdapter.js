import { normalizeModelLists, resolveCatalogModel, validateModelCatalog } from '../core/catalog.js';
import { invalidCredential } from '../core/errors.js';
import { normalizePredictionResult } from '../core/normalizeResult.js';

export function createProviderAdapter({
  id,
  modelLists = null,
  loadModelLists = null,
  runPrediction,
  validateCredential = null,
  uploads = {},
  transports = {},
  runtime = undefined,
  planning = undefined,
  workflowArchitect = undefined,
}) {
  if (!id || typeof runPrediction !== 'function') {
    throw new TypeError('createProviderAdapter requires id and runPrediction.');
  }
  if (!modelLists && typeof loadModelLists !== 'function') {
    throw new TypeError(`Provider "${id}" requires modelLists or loadModelLists.`);
  }
  let cachedLists = modelLists
    ? validateModelCatalog(id, normalizeModelLists(id, modelLists))
    : null;
  const getLists = async () => {
    if (!cachedLists) cachedLists = validateModelCatalog(id, normalizeModelLists(id, await loadModelLists()));
    return cachedLists;
  };
  const catalog = {
    ...(cachedLists ? { getModelListsSync: () => cachedLists } : {}),
    getModelLists: getLists,
    async getModel(mode, modelId) {
      return resolveCatalogModel(await getLists(), modelId, { mode });
    },
    async getModelById(modelId, context = {}) {
      return resolveCatalogModel(await getLists(), modelId, context);
    },
  };
  return Object.freeze({
    id,
    credentials: {
      async validate(secret) {
        if (typeof secret !== 'string' || !secret.trim()) throw invalidCredential(id);
        return validateCredential ? validateCredential(secret) : true;
      },
    },
    catalog,
    predictions: {
      async run(input) {
        const result = await runPrediction(input);
        return result?.provider === id && 'providerRef' in result
          ? result
          : normalizePredictionResult(id, result);
      },
    },
    uploads: { requiresPublicHttps: true, acceptsDataUrls: false, ...uploads },
    transports: { ...transports },
    ...(runtime ? { runtime } : {}),
    ...(planning ? { planning } : {}),
    ...(workflowArchitect ? { workflowArchitect } : {}),
  });
}

