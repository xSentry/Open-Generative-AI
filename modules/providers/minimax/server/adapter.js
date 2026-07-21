import { createProviderAdapter } from '../../server/createAdapter.js';
import { createRuntimeSignature } from '../../runtime/server/signature.js';
import { estimatePredictionRuntime } from '../../runtime/server/samples.js';
import { minimaxModelLists } from './catalog.js';
import { runMiniMaxPrediction, validateMiniMaxCredential } from './run.js';

export const minimaxAdapter = createProviderAdapter({
  id: 'minimax',
  modelLists: minimaxModelLists,
  validateCredential: validateMiniMaxCredential,
  runPrediction: runMiniMaxPrediction,
  uploads: { requiresPublicHttps: true, acceptsDataUrls: false, maxBytes: 512_000_000 },
  runtime: {
    estimate({ model, params }) {
      return estimatePredictionRuntime({
        provider: 'minimax',
        model,
        signature: createRuntimeSignature({ model, params }),
      });
    },
  },
});
