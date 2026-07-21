const STATUS_BY_CODE = {
  unknown_provider: 400,
  provider_feature_unsupported: 400,
  provider_mode_unsupported: 400,
  provider_catalog_invalid: 500,
  provider_credential_missing: 401,
  provider_credential_invalid: 401,
  provider_request_failed: 502,
};

export class ProviderError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'ProviderError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 500;
    this.details = details;
  }
}

export function unknownProvider(provider) {
  return new ProviderError('unknown_provider', `Unknown provider "${provider || ''}".`, { provider });
}

export function unsupportedFeature(provider, feature) {
  return new ProviderError(
    'provider_feature_unsupported',
    `Provider "${provider}" does not support ${feature}.`,
    { provider, feature },
  );
}

export function unsupportedMode(provider, mode) {
  return new ProviderError(
    'provider_mode_unsupported',
    `Provider "${provider}" does not support mode "${mode}".`,
    { provider, mode },
  );
}

export function missingCredential(provider, label = 'credential') {
  return new ProviderError(
    'provider_credential_missing',
    `A ${label} is required for ${provider}.`,
    { provider },
  );
}

export function invalidCredential(provider, message) {
  return new ProviderError(
    'provider_credential_invalid',
    message || `${provider} rejected the stored credential.`,
    { provider },
  );
}

