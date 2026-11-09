'use strict';

const { createBaseAdapterConfig, createAdapterMethods, buildProviderAdapter } = require('../adapter-factory');
const { FOUNDRY_ENV } = require('../provider-env-constants');

function createFoundryAdapter(env, deps = {}) {
  const { apiKey, rawTarget, basePath } = createBaseAdapterConfig(env, {
    keyEnvVar: FOUNDRY_ENV.KEY,
    targetEnvVar: FOUNDRY_ENV.TARGET,
    basePathEnvVar: FOUNDRY_ENV.BASE_PATH,
    defaultTarget: '',
  });
  const entraToken = (env[FOUNDRY_ENV.ENTRA_TOKEN] || '').trim();
  const configured = !!rawTarget && !!(entraToken || apiKey);

  return buildProviderAdapter({
    name: 'foundry',
    port: 10005,
    alwaysBind: false,
    isEnabled: () => configured,
    getAuthHeaders: () => entraToken
      ? { Authorization: ['Bearer', entraToken].join(' ') }
      : { 'api-key': apiKey },
    bodyTransform: deps.bodyTransform || null,
    adapterMethods: createAdapterMethods({
      provider: 'foundry',
      port: 10005,
      rawTarget,
      basePath,
      credentialConfigured: configured,
      reflectionConfigured: configured,
      modelsPath: null,
      modelsCacheKey: null,
      // Decision deployments do not expose a models endpoint; never issue a billable startup probe.
      getValidationProbe: () => configured
        ? { skip: true, reason: 'Foundry deployment; validation skipped' }
        : null,
      reflectionExtra: { auth_type: entraToken ? 'entra-token' : 'static-key' },
    }),
  });
}

module.exports = { createFoundryAdapter };
