// Server-side catalog for Replicate models.
//
// Mirrors modules/studio/server/studioCatalog.js (which serves the muapi
// models.js) but sources everything from the generated
// modules/providers/replicate/replicateModels.js. Used only when the active
// provider is "replicate".

import {
  replicateModelsByMode,
  allReplicateModels,
  getReplicateModelById,
  getReplicateModelsForMode,
  getReplicateModelByRef,
} from '../replicateModels.js';

export {
  replicateModelsByMode,
  allReplicateModels,
  getReplicateModelById,
  getReplicateModelsForMode,
  getReplicateModelByRef,
};

// Look up a model within a specific Studio mode (mirrors getStudioModel).
export function getReplicateStudioModel(mode, id) {
  return getReplicateModelsForMode(mode).find((model) => model.id === id) || null;
}

// Match a model by its endpoint/id, used by the /api/api/v1 compat proxy
// (mirrors findStudioModelByEndpoint).
export function findReplicateModelByEndpoint(endpoint) {
  for (const [mode, models] of Object.entries(replicateModelsByMode)) {
    const match = models.find((model) => (model.endpoint || model.id) === endpoint || model.id === endpoint);
    if (match) {
      return { mode, model: match };
    }
  }

  return null;
}

// The client renders form controls directly from each model's `inputs`, so we
// hand back the full model objects per mode (mirrors
// getSerializableStudioModelLists).
export function getSerializableReplicateModelLists() {
  return Object.fromEntries(
    Object.entries(replicateModelsByMode).map(([mode, models]) => [mode, models.map((model) => ({ ...model }))])
  );
}

// No "unavailable" concept in the new approach; kept for API-shape parity.
export function getReplicateUnavailableCounts() {
  return {};
}

