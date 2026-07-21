import { ProviderError } from '../core/errors.js';

function defaultLogger(fields) {
  if (process.env.PROVIDER_OPERATION_LOGGING === 'false') return;
  console.info(JSON.stringify({ event: 'provider_operation', ...fields }));
}

export async function observeProviderOperation(meta, operation, { logger = defaultLogger } = {}) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    logger({
      provider: meta.provider,
      operation: meta.operation,
      feature: meta.feature || null,
      mode: meta.mode || null,
      model_id: meta.modelId || null,
      provider_ref: result?.providerRef || null,
      duration_ms: Date.now() - startedAt,
      status: 'succeeded',
      error_code: null,
    });
    return result;
  } catch (error) {
    const typed = error?.code
      ? error
      : new ProviderError(
        'provider_request_failed',
        error?.message || `Provider ${meta.provider} operation failed.`,
        { provider: meta.provider, operation: meta.operation },
        { cause: error },
      );
    logger({
      provider: meta.provider,
      operation: meta.operation,
      feature: meta.feature || null,
      mode: meta.mode || null,
      model_id: meta.modelId || null,
      provider_ref: null,
      duration_ms: Date.now() - startedAt,
      status: 'failed',
      error_code: typed.code || 'provider_request_failed',
    });
    throw typed;
  }
}

export function instrumentProviderAdapter(adapter, options = {}) {
  const instrument = (group, name, feature) => {
    const fn = adapter[group]?.[name];
    if (typeof fn !== 'function') return fn;
    return (input, ...rest) => observeProviderOperation({
      provider: adapter.id,
      operation: `${group}.${name}`,
      feature,
      mode: input?.mode || null,
      modelId: input?.model?.id || input?.modelId || null,
    }, () => fn.call(adapter[group], input, ...rest), options);
  };

  const catalog = adapter.catalog ? {
    ...adapter.catalog,
    getModelLists: typeof adapter.catalog.getModelLists === 'function'
      ? () => observeProviderOperation({
        provider: adapter.id,
        operation: 'catalog.getModelLists',
        feature: 'catalog',
      }, () => adapter.catalog.getModelLists(), options)
      : undefined,
    getModel: typeof adapter.catalog.getModel === 'function'
      ? (mode, modelId) => observeProviderOperation({
        provider: adapter.id,
        operation: 'catalog.getModel',
        feature: 'catalog',
        mode,
        modelId,
      }, () => adapter.catalog.getModel(mode, modelId), options)
      : undefined,
    getModelById: typeof adapter.catalog.getModelById === 'function'
      ? (modelId, context = {}) => observeProviderOperation({
        provider: adapter.id,
        operation: 'catalog.getModelById',
        feature: 'catalog',
        mode: context.mode || null,
        modelId,
      }, () => adapter.catalog.getModelById(modelId, context), options)
      : undefined,
  } : undefined;

  return Object.freeze({
    ...adapter,
    catalog,
    credentials: adapter.credentials ? { ...adapter.credentials, validate: instrument('credentials', 'validate', 'credentials') } : undefined,
    predictions: adapter.predictions ? { ...adapter.predictions, run: instrument('predictions', 'run', 'inference') } : undefined,
    planning: adapter.planning ? { ...adapter.planning, createToolPlan: instrument('planning', 'createToolPlan', 'designAgent') } : undefined,
    workflowArchitect: adapter.workflowArchitect ? {
      ...adapter.workflowArchitect,
      generateCreateWorkflowIr: instrument('workflowArchitect', 'generateCreateWorkflowIr', 'workflowArchitect'),
    } : undefined,
  });
}
