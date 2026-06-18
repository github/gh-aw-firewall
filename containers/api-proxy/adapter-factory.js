/**
 * Adapter factory — credential-injection infrastructure for provider adapters.
 *
 * Exports the two factory functions used by every provider adapter to read
 * API keys from the environment and build the common structural adapter methods
 * (getTargetHost, getBasePath, getValidationProbe, getModelsFetchConfig,
 * getReflectionInfo, participatesInValidation).
 *
 * Isolated from proxy-utils.js so that the security-critical credential path
 * can be reviewed independently of the general-purpose proxy utilities.
 */

'use strict';

const { normalizeApiTarget, normalizeBasePath } = require('./proxy-utils');

/**
 *
 * Every non-Copilot adapter repeats the same three-line pattern to read
 * an API key, normalize a target hostname, and normalize a base path.
 * This helper centralizes that logic so each adapter only specifies env
 * var names and a default target.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {object} opts
 * @param {string} opts.keyEnvVar      - e.g. 'OPENAI_API_KEY'
 * @param {string} opts.targetEnvVar   - e.g. 'OPENAI_API_TARGET'
 * @param {string} opts.basePathEnvVar - e.g. 'OPENAI_API_BASE_PATH'
 * @param {string} opts.defaultTarget  - e.g. 'api.openai.com'
 * @returns {{ apiKey: string|undefined, rawTarget: string, basePath: string }}
 */
function createBaseAdapterConfig(env, { keyEnvVar, targetEnvVar, basePathEnvVar, defaultTarget }) {
  const apiKey = (env[keyEnvVar] || '').trim() || undefined;
  const rawTarget = normalizeApiTarget(env[targetEnvVar]) || defaultTarget;
  const basePath = normalizeBasePath(env[basePathEnvVar]);
  return { apiKey, rawTarget, basePath };
}

/**
 * Build common structural adapter methods with optional provider overrides.
 *
 * @param {object} opts
 * @param {string|undefined} [opts.apiKey]
 * @param {string} opts.rawTarget
 * @param {string} [opts.basePath]
 * @param {string} opts.provider
 * @param {number} opts.port
 * @param {string|null} opts.modelsPath
 * @param {string} [opts.defaultTarget]
 * @param {string} [opts.validationPath]
 * @param {'GET'|'POST'} [opts.validationMethod]
 * @param {Record<string,string>|(() => Record<string,string>)} [opts.validationHeaders]
 * @param {string} [opts.validationBody]
 * @param {() => ({ skip: true, reason: string }|null)} [opts.validationSkip]
 * @param {() => boolean} [opts.skipModelsFetch]
 * @param {Record<string,string>|(() => Record<string,string>)} [opts.modelsFetchHeaders]
 * @param {string|null} [opts.modelsCacheKey]
 * @param {boolean} [opts.participatesInValidation]
 * @param {boolean} [opts.reflectionConfigured]
 * @param {string|null} [opts.reflectionModelsPath]
 * @param {Record<string, unknown>|(() => Record<string, unknown>)} [opts.reflectionExtra]
 * @param {() => ({ url: string, opts: object }|{ skip: true, reason: string }|null)} [opts.getValidationProbe]
 * @param {() => ({ url: string, opts: object, cacheKey: string }|null)} [opts.getModelsFetchConfig]
 * @param {() => object} [opts.getReflectionInfo]
 * @returns {{
 *   getTargetHost: (req?: import('http').IncomingMessage) => string,
 *   getBasePath: (req?: import('http').IncomingMessage) => string,
 *   participatesInValidation: boolean,
 *   getValidationProbe: () => ({ url: string, opts: object }|{ skip: true, reason: string }|null),
 *   getModelsFetchConfig: () => ({ url: string, opts: object, cacheKey: string }|null),
 *   getReflectionInfo: () => object
 * }}
 */
function createAdapterMethods(opts) {
  const {
    apiKey,
    rawTarget,
    basePath = '',
    provider,
    port,
    modelsPath,
    defaultTarget,
    validationPath = modelsPath || '',
    validationMethod = 'GET',
    validationHeaders = {},
    validationBody,
    validationSkip,
    skipModelsFetch,
    modelsFetchHeaders = validationHeaders,
    modelsCacheKey = provider,
    participatesInValidation = !!apiKey,
    reflectionConfigured = !!apiKey,
    reflectionModelsPath = modelsPath,
    reflectionExtra = {},
    getValidationProbe,
    getModelsFetchConfig,
    getReflectionInfo,
  } = opts;

  const resolveValue = (value) => (typeof value === 'function' ? value() : value);

  const builtValidationProbe = getValidationProbe || (() => {
    const skip = validationSkip ? validationSkip() : null;
    if (skip) return skip;
    if (!apiKey) return null;
    if (defaultTarget && rawTarget !== defaultTarget) {
      return { skip: true, reason: `Custom target ${rawTarget}; validation skipped` };
    }
    return {
      url: `https://${rawTarget}${validationPath}`,
      opts: {
        method: validationMethod,
        headers: resolveValue(validationHeaders),
        ...(validationBody !== undefined ? { body: validationBody } : {}),
      },
    };
  });

  const builtModelsFetchConfig = getModelsFetchConfig || (() => {
    if (skipModelsFetch && skipModelsFetch()) return null;
    if (!apiKey || !modelsPath || !modelsCacheKey) return null;
    // Startup model fetch follows provider behavior of honoring explicit basePath
    // prefixes for OpenAI-compatible gateways, while validation probes use the
    // canonical default-target endpoint path.
    const modelsPrefix = basePath === '/' ? '' : basePath;
    const path = modelsPrefix ? `${modelsPrefix}/models` : modelsPath;
    return {
      url: `https://${rawTarget}${path}`,
      opts: { method: 'GET', headers: resolveValue(modelsFetchHeaders) },
      cacheKey: modelsCacheKey,
    };
  });

  const builtReflectionInfo = getReflectionInfo || (() => ({
    provider,
    port,
    base_url: `http://api-proxy:${port}`,
    configured: reflectionConfigured,
    models_cache_key: modelsCacheKey,
    models_url: reflectionModelsPath ? `http://api-proxy:${port}${reflectionModelsPath}` : null,
    ...resolveValue(reflectionExtra),
  }));

  return {
    getTargetHost() { return rawTarget; },
    getBasePath() { return basePath; },
    participatesInValidation,
    getValidationProbe: builtValidationProbe,
    getModelsFetchConfig: builtModelsFetchConfig,
    getReflectionInfo: builtReflectionInfo,
  };
}

/**
 * Assemble a provider adapter object from its constituent parts.
 *
 * Every provider adapter returns the same outer object shape:
 *   { name, port, isManagementPort, alwaysBind, getAuthHeaders, getBodyTransform,
 *     ...adapterMethods, getUnconfiguredResponse?, getUnconfiguredHealthResponse? }
 *
 * This helper centralises that boilerplate so each adapter only needs to supply
 * its provider-specific values and callbacks.  Provider-specific logic (auth
 * header construction, OIDC plumbing, body transforms, introspection fields, etc.)
 * is passed in via the `getAuthHeaders`, `bodyTransform`, and `extra` parameters.
 *
 * @param {object} opts
 * @param {string}  opts.name              - Unique provider slug (e.g. 'openai')
 * @param {number}  opts.port              - Port the adapter listens on
 * @param {boolean} [opts.isManagementPort=false] - True only for port 10000 (OpenAI)
 * @param {boolean} [opts.alwaysBind=true] - Start a stub server even when isEnabled() is false
 * @param {object}  opts.adapterMethods    - Result of createAdapterMethods()
 * @param {(req?: import('http').IncomingMessage) => Record<string,string>} opts.getAuthHeaders - Auth header factory
 * @param {((body: Buffer) => Buffer|null)|null} [opts.bodyTransform=null] - Body transform wrapped into getBodyTransform()
 * @param {(() => boolean)} [opts.isEnabled]                   - Optional isEnabled override (must be provided either here or via `extra`)
 * @param {((url: string) => string)} [opts.transformRequestUrl] - Optional URL transformer
 * @param {(() => import('./providers/index').UnconfiguredResponse)} [opts.getUnconfiguredResponse]       - Optional not-configured response
 * @param {(() => import('./providers/index').UnconfiguredResponse)} [opts.getUnconfiguredHealthResponse] - Optional not-configured /health response
 * @param {object} [opts.extra={}]         - Extra fields spread into the returned object last (e.g. OIDC runtime methods, introspection fields, overrides)
 * @returns {import('./providers/index').ProviderAdapter}
 */
function buildProviderAdapter({
  name,
  port,
  isManagementPort = false,
  alwaysBind = true,
  adapterMethods,
  getAuthHeaders,
  bodyTransform = null,
  isEnabled,
  transformRequestUrl,
  getUnconfiguredResponse,
  getUnconfiguredHealthResponse,
  extra = {},
}) {
  const adapter = {
    name,
    port,
    isManagementPort,
    alwaysBind,
    ...(isEnabled !== undefined ? { isEnabled } : {}),
    getAuthHeaders,
    ...(transformRequestUrl !== undefined ? { transformRequestUrl } : {}),
    getBodyTransform() { return bodyTransform; },
    ...adapterMethods,
    ...(getUnconfiguredResponse !== undefined ? { getUnconfiguredResponse } : {}),
    ...(getUnconfiguredHealthResponse !== undefined ? { getUnconfiguredHealthResponse } : {}),
    ...extra,
  };

  if (typeof adapter.isEnabled !== 'function') {
    throw new TypeError(`Provider adapter "${name}" must define an isEnabled() function`);
  }

  return adapter;
}

module.exports = {
  createBaseAdapterConfig,
  createAdapterMethods,
  buildProviderAdapter,
};
