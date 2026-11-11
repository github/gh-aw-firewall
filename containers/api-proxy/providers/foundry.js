'use strict';

const { createBaseAdapterConfig, createAdapterMethods, buildProviderAdapter } = require('../adapter-factory');
const { FOUNDRY_ENV } = require('../provider-env-constants');
const { providerKeyHeaders } = require('./auth-headers');

function createFoundryAdapter(env, deps = {}) {
  const { apiKey, rawTarget, basePath } = createBaseAdapterConfig(env, {
    keyEnvVar: FOUNDRY_ENV.KEY,
    targetEnvVar: FOUNDRY_ENV.TARGET,
    basePathEnvVar: FOUNDRY_ENV.BASE_PATH,
    defaultTarget: '',
  });
  const configured = !!rawTarget && !!apiKey;
  const inferencePath = '(?:chat/completions|completions|embeddings|responses)';
  const prefixes = new Set(['', '/v1', '/openai', '/openai/v1', basePath === '/' ? '' : basePath]);
  const allowedRequestPaths = [
    /^\/providers\/microsoft\/v1\/systemone$/,
    ...Array.from(prefixes, prefix => {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escaped}/(?:deployments/[A-Za-z0-9_-]+/)?${inferencePath}$`);
    }),
  ];

  return buildProviderAdapter({
    name: 'foundry',
    port: 10005,
    alwaysBind: false,
    isEnabled: () => configured,
    getAuthHeaders: () => configured ? providerKeyHeaders('api-key', apiKey) : {},
    bodyTransform: deps.bodyTransform || null,
    adapterMethods: createAdapterMethods({
      provider: 'foundry',
      port: 10005,
      rawTarget,
      basePath,
      allowedRequestPaths,
      credentialConfigured: configured,
      reflectionConfigured: configured,
      modelsPath: null,
      modelsCacheKey: null,
      // Decision deployments do not expose a models endpoint; never issue a billable startup probe.
      getValidationProbe: () => configured
        ? { skip: true, reason: 'Foundry deployment; validation skipped' }
        : null,
      reflectionExtra: { auth_type: configured ? 'static-key' : null },
    }),
  });
}

module.exports = { createFoundryAdapter };
