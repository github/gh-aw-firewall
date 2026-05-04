'use strict';

/**
 * Anthropic provider adapter.
 *
 * Port: 10001
 * Auth: x-api-key header, plus optional anthropic-version and anthropic-beta headers
 * Credentials: ANTHROPIC_API_KEY
 * Target: ANTHROPIC_API_TARGET  (default: api.anthropic.com)
 * Base path: ANTHROPIC_API_BASE_PATH
 * Body transforms: model alias rewriting + optional prompt-cache optimisations
 */

const { normalizeApiTarget, normalizeBasePath, composeBodyTransforms, createBaseAdapterConfig } = require('../proxy-utils');

let makeAnthropicTransform, loadCustomTransform, EXTENDED_CACHE_BETA;
try {
  ({ makeAnthropicTransform, loadCustomTransform, EXTENDED_CACHE_BETA } = require('../anthropic-transforms'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    makeAnthropicTransform = () => () => null;
    loadCustomTransform = () => null;
    EXTENDED_CACHE_BETA = undefined;
  } else {
    throw err;
  }
}

/**
 * Create the Anthropic provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createAnthropicAdapter(env, deps = {}) {
  const { apiKey, rawTarget, basePath } = createBaseAdapterConfig(env, {
    keyEnvVar: 'ANTHROPIC_API_KEY',
    targetEnvVar: 'ANTHROPIC_API_TARGET',
    basePathEnvVar: 'ANTHROPIC_API_BASE_PATH',
    defaultTarget: 'api.anthropic.com',
  });

  // ── Anthropic-specific optimisations ──────────────────────────────────────
  const autoCache = (env.AWF_ANTHROPIC_AUTO_CACHE === '1' || env.AWF_ANTHROPIC_AUTO_CACHE === 'true');
  const cacheTailTtl = (() => {
    const raw = (env.AWF_ANTHROPIC_CACHE_TAIL_TTL || '').trim();
    return (raw === '1h' || raw === '5m') ? raw : '5m';
  })();
  const dropTools = (() => {
    const raw = (env.AWF_ANTHROPIC_DROP_TOOLS || '').trim();
    return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  })();
  const stripAnsi = (env.AWF_ANTHROPIC_STRIP_ANSI === '1' || env.AWF_ANTHROPIC_STRIP_ANSI === 'true');
  const transformFile = (env.AWF_ANTHROPIC_TRANSFORM_FILE || '').trim() || undefined;

  const customTransform = loadCustomTransform(transformFile);
  const optimisationsTransform = makeAnthropicTransform({
    autoCache,
    tailTtl: cacheTailTtl,
    dropTools,
    stripAnsiCodes: stripAnsi,
    customTransform,
  });

  const bodyTransform = deps.bodyTransform || null;

  // Build the composed transform once at construction time to avoid
  // re-allocating the wrapper function on every request.
  const composedBodyTransform = composeBodyTransforms(bodyTransform, optimisationsTransform);

  return {
    name: 'anthropic',
    port: 10001,
    isManagementPort: false,
    alwaysBind: false,
    get participatesInValidation() { return this.isEnabled(); },

    isEnabled() { return !!apiKey; },
    getTargetHost() { return rawTarget; },
    getBasePath() { return basePath; },

    /**
     * Build Anthropic auth headers for this request.
     * Merges in the anthropic-version default and anthropic-beta (for auto-cache)
     * as needed, without overwriting values already set by the client.
     *
     * @param {import('http').IncomingMessage} req
     * @returns {Record<string, string>}
     */
    getAuthHeaders(req) {
      const headers = { 'x-api-key': apiKey };

      if (!req.headers['anthropic-version']) {
        headers['anthropic-version'] = '2023-06-01';
      }

      if (autoCache) {
        const existing = req.headers['anthropic-beta'];
        if (!existing) {
          headers['anthropic-beta'] = EXTENDED_CACHE_BETA;
        } else {
          const normalizedExisting = Array.isArray(existing) ? existing.join(',') : existing;
          const existingBetas = normalizedExisting.split(',').map(s => s.trim()).filter(Boolean);
          if (!existingBetas.includes(EXTENDED_CACHE_BETA)) {
            headers['anthropic-beta'] = `${normalizedExisting},${EXTENDED_CACHE_BETA}`;
          }
        }
      }

      return headers;
    },

    getBodyTransform() { return composedBodyTransform; },

    getValidationProbe() {
      if (!apiKey) return null;
      if (rawTarget !== 'api.anthropic.com') {
        return { skip: true, reason: `Custom target ${rawTarget}; validation skipped` };
      }
      // POST /v1/messages with an empty body: 400 = key valid (bad body), 401 = key invalid
      return {
        url: `https://${rawTarget}/v1/messages`,
        opts: {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: '{}',
        },
      };
    },

    getModelsFetchConfig() {
      if (!apiKey) return null;
      // Use the configured base path so Anthropic-compatible endpoints with a
      // path prefix populate /reflect and models.json correctly.
      const modelsPath = basePath ? `${basePath}/models` : '/v1/models';
      return {
        url: `https://${rawTarget}${modelsPath}`,
        opts: {
          method: 'GET',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        },
        cacheKey: 'anthropic',
      };
    },

    getReflectionInfo() {
      return {
        provider: 'anthropic',
        port: 10001,
        base_url: 'http://api-proxy:10001',
        configured: !!apiKey,
        models_cache_key: 'anthropic',
        models_url: 'http://api-proxy:10001/v1/models',
      };
    },

    // Exposed for introspection (logging, tests)
    _autoCache: autoCache,
    _cacheTailTtl: cacheTailTtl,
    _dropTools: dropTools,
    _stripAnsi: stripAnsi,
    _transformFile: transformFile,
    _customTransformLoaded: !!customTransform,
    _optimisationsTransform: optimisationsTransform,
  };
}

module.exports = { createAnthropicAdapter };
