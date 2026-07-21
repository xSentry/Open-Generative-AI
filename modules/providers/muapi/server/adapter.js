import { ProviderError, invalidCredential } from '../../core/errors.js';
import { normalizeModelLists, validateModelCatalog } from '../../core/catalog.js';
import { normalizePredictionResult } from '../../core/normalizeResult.js';
import {
  getSerializableStudioModelLists,
  getStudioModel,
  STUDIO_MODEL_LISTS,
} from '../../../studio/server/studioCatalog.js';
import { runMuapiPrediction } from './run.js';
import { proxyToMuapi } from './workflowProxy.js';
import { proxyMuapiAgents, proxyMuapiApp, proxyMuapiDesignAgent } from './proxies.js';

function modelById(modelId) {
  for (const models of Object.values(STUDIO_MODEL_LISTS)) {
    const model = models.find((entry) => entry.id === modelId);
    if (model) return model;
  }
  return null;
}

function modelLists() {
  return validateModelCatalog('muapi', normalizeModelLists('muapi', getSerializableStudioModelLists()));
}

export const muapiAdapter = Object.freeze({
  id: 'muapi',
  credentials: {
    async validate(apiKey) {
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw invalidCredential('muapi', 'A MuAPI API key is required.');
      return true;
    },
  },
  catalog: {
    getModelListsSync: modelLists,
    async getModelLists() { return modelLists(); },
    async getModel(mode, modelId) {
      const model = getStudioModel(mode, modelId);
      if (!model) throw new ProviderError('provider_mode_unsupported', `Model "${modelId}" is not available for MuAPI in mode "${mode}".`, { provider: 'muapi', mode, modelId });
      return model;
    },
    async getModelById(modelId) { return modelById(modelId); },
  },
  predictions: {
    async run({ apiKey, model, params, ...options }) {
      const result = await runMuapiPrediction({
        apiKey,
        endpoint: model.endpoint || model.id,
        params,
        ...options,
      });
      return normalizePredictionResult('muapi', result);
    },
  },
  uploads: { requiresPublicHttps: false, acceptsDataUrls: true, maxBytes: 250_000_000, usesProviderUploadProxy: true },
  transports: {
    workflowProxy: proxyToMuapi,
    agentsProxy: proxyMuapiAgents,
    designAgentProxy: proxyMuapiDesignAgent,
    appProxy: proxyMuapiApp,
  },
});
