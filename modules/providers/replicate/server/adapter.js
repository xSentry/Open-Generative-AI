import { ProviderError, invalidCredential } from '../../core/errors.js';
import { normalizeModelLists, resolveCatalogModel, validateModelCatalog } from '../../core/catalog.js';
import { normalizePredictionResult } from '../../core/normalizeResult.js';
import { createRuntimeSignature } from '../../runtime/server/signature.js';
import { estimatePredictionRuntime } from '../../runtime/server/samples.js';
import {
  getReplicateModelById,
  getReplicateModelsForMode,
  getSerializableReplicateModelLists,
} from './catalog.js';
import { runReplicatePrediction } from './run.js';

function parseJsonText(text) {
  try { return JSON.parse(text); } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function requireModel(mode, modelId) {
  const model = resolveCatalogModel(modelLists(), modelId, { mode });
  if (!model) throw new ProviderError('provider_mode_unsupported', `Model "${modelId}" is not available for Replicate in mode "${mode}".`, { provider: 'replicate', mode, modelId });
  return model;
}

function modelLists() {
  return validateModelCatalog('replicate', normalizeModelLists('replicate', getSerializableReplicateModelLists()));
}

export const replicateAdapter = Object.freeze({
  id: 'replicate',
  credentials: {
    async validate(apiKey) {
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw invalidCredential('replicate', 'A Replicate API token is required.');
      return true;
    },
  },
  catalog: {
    getModelListsSync: modelLists,
    async getModelLists() { return modelLists(); },
    async getModel(mode, modelId) { return requireModel(mode, modelId); },
    async getModelById(modelId, context = {}) { return resolveCatalogModel(modelLists(), modelId, context); },
  },
  predictions: {
    async run(options) {
      const result = await runReplicatePrediction(options);
      return normalizePredictionResult('replicate', result);
    },
  },
  planning: {
    async createToolPlan({ apiKey, modelId, prompt }) {
      const model = getReplicateModelById(modelId);
      if (!model) throw new ProviderError('provider_mode_unsupported', `Unknown Replicate planner model "${modelId}".`);
      const result = await runReplicatePrediction({ apiKey, model, params: { prompt }, mode: 't2t', maxAttempts: 180, interval: 1000 });
      return parseJsonText(result.text || result.outputs?.join('') || '');
    },
  },
  workflowArchitect: {
    async generateCreateWorkflowIr(args) {
      const { generateCreateWorkflowIr } = await import('../../../workflow-architect/infrastructure/models/replicateStructuredModel.js');
      return generateCreateWorkflowIr(args);
    },
  },
  runtime: {
    async estimate({ model, params }) {
      return estimatePredictionRuntime({
        provider: 'replicate', model,
        signature: createRuntimeSignature({ model, params }),
      });
    },
  },
  uploads: { requiresPublicHttps: true, acceptsDataUrls: false, maxBytes: 250_000_000 },
  transports: { workflowProxy: null, agentsProxy: null, designAgentProxy: null },
});
