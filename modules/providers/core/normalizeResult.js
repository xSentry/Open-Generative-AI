function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function collectOutput(value) {
  if (isUrl(value)) return { outputs: [value], text: null };
  if (typeof value === 'string') return { outputs: [], text: value };
  if (Array.isArray(value)) {
    const outputs = value.map((item) => isUrl(item) ? item : isUrl(item?.url) ? item.url : null).filter(Boolean);
    const text = outputs.length ? null : value.map((item) => typeof item === 'string' ? item : item?.text || item?.content || '').join('') || null;
    return { outputs, text };
  }
  if (value && typeof value === 'object') {
    if (isUrl(value.url)) return { outputs: [value.url], text: null };
    if (typeof value.text === 'string') return { outputs: [], text: value.text };
  }
  return { outputs: [], text: null };
}

export function normalizePredictionResult(provider, nativeResult = {}, { includeRaw = false } = {}) {
  const source = nativeResult.output ?? nativeResult.outputs ?? nativeResult.url ?? nativeResult.text ?? null;
  const normalized = collectOutput(source);
  const explicitOutputs = Array.isArray(nativeResult.outputs)
    ? nativeResult.outputs.map((item) => isUrl(item) ? item : isUrl(item?.url) ? item.url : null).filter(Boolean)
    : [];
  const outputs = explicitOutputs.length ? explicitOutputs : normalized.outputs;
  const result = {
    provider,
    providerRef: nativeResult.providerRef ?? nativeResult.replicateId ?? nativeResult.request_id ?? nativeResult.id ?? null,
    createdAt: nativeResult.createdAt ?? nativeResult.created_at ?? null,
    status: 'succeeded',
    url: nativeResult.url ?? outputs[0] ?? null,
    outputs,
    text: nativeResult.text ?? normalized.text ?? null,
    metrics: nativeResult.metrics ?? null,
  };
  if (includeRaw) result.raw = nativeResult;
  return result;
}

