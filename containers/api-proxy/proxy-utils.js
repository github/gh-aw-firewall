/**
 * Shared proxy utilities — pure functions with no provider-specific logic.
 * Used by both server.js (core) and provider adapters.
 */

'use strict';

const { URL } = require('url');

/**
 * Normalizes an API target value to a bare hostname.
 * Accepts either a hostname or a full URL and extracts only the hostname,
 * discarding any scheme, path, query, fragment, credentials, or port.
 * Path configuration must be provided separately via the existing
 * *_API_BASE_PATH environment variables.
 *
 * @param {string|undefined} value - Raw env var value
 * @returns {string|undefined} Bare hostname, or undefined if input is falsy
 */
function normalizeApiTarget(value) {
  if (!value) return value;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);

    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) {
      const safe = trimmed.replace(/[\x00-\x1f\x7f]/g, '?');
      console.warn(
        `Ignoring unsupported API target URL components in ${safe}; ` +
        'configure path prefixes via the corresponding *_API_BASE_PATH environment variable.'
      );
    }

    return parsed.hostname || undefined;
  } catch (err) {
    const safe = trimmed.replace(/[\x00-\x1f\x7f]/g, '?');
    console.warn(`Invalid API target ${safe}; expected a hostname (e.g. 'api.example.com') or URL`);
    return undefined;
  }
}

/**
 * Normalizes a base path for use as a URL path prefix.
 * Ensures the path starts with '/' (if non-empty) and has no trailing '/'.
 * Returns '' for empty, null, or undefined inputs.
 *
 * @param {string|undefined|null} rawPath - The raw path value from env or config
 * @returns {string} Normalized path prefix (e.g. '/serving-endpoints') or ''
 */
function normalizeBasePath(rawPath) {
  if (!rawPath) return '';
  let p = rawPath.trim();
  if (!p) return '';
  if (!p.startsWith('/')) {
    p = '/' + p;
  }
  if (p !== '/' && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * Build the full upstream path by joining basePath, reqUrl's pathname, and query string.
 * Applies provider-safe defaults and avoids duplicate prefixing when the incoming
 * path already includes the configured base path.
 *
 * Examples:
 *   buildUpstreamPath('/v1/chat/completions', 'api.openai.com', '/v1')
 *     → '/v1/chat/completions'  (no double-prefix)
 *   buildUpstreamPath('/chat/completions', 'api.openai.com', '/v1')
 *     → '/v1/chat/completions'
 *   buildUpstreamPath('/v1/messages?stream=true', 'host.com', '/anthropic')
 *     → '/anthropic/v1/messages?stream=true'
 *
 * @param {string} reqUrl - The incoming request URL (must start with '/' and not '//')
 * @param {string} targetHost - The upstream hostname (used only to parse the URL)
 * @param {string} basePath - Normalized base path prefix (e.g. '/v1' or '')
 * @returns {string} Full upstream path including query string
 */
function buildUpstreamPath(reqUrl, targetHost, basePath) {
  if (typeof reqUrl !== 'string' || !reqUrl.startsWith('/') || reqUrl.startsWith('//')) {
    throw new Error('URL must be a relative origin-form path');
  }

  const targetUrl = new URL(reqUrl, `https://${targetHost}`);
  const pathname = targetUrl.pathname;
  const prefix = basePath === '/' ? '' : basePath;

  if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return pathname + targetUrl.search;
  }

  return prefix + pathname + targetUrl.search;
}

/**
 * Strip all known Gemini API-key query parameters from a request URL.
 *
 * The @google/genai SDK (and older Gemini SDK versions) may append auth params
 * (`?key=`, `?apiKey=`, or `?api_key=`) to every request URL in addition to
 * setting the `x-goog-api-key` header.  The proxy injects the real key via the
 * header, so any placeholder param must be removed before forwarding to Google
 * to prevent API_KEY_INVALID errors.
 *
 * @param {string} reqUrl - The incoming request URL (must start with exactly one '/')
 * @returns {string} URL with all Gemini auth query parameters removed
 */
function stripGeminiKeyParam(reqUrl) {
  if (typeof reqUrl !== 'string' || !reqUrl.startsWith('/') || reqUrl.startsWith('//')) {
    return reqUrl;
  }
  const parsed = new URL(reqUrl, 'http://localhost');
  parsed.searchParams.delete('key');
  parsed.searchParams.delete('apiKey');
  parsed.searchParams.delete('api_key');
  return parsed.pathname + parsed.search;
}

/**
 * Headers that must never be forwarded from the client.
 * The proxy controls authentication — client-supplied auth/proxy headers are stripped.
 */
const STRIPPED_HEADERS = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'forwarded',
  'via',
]);

/** Returns true if the header name should be stripped (case-insensitive). */
function shouldStripHeader(name) {
  const lower = name.toLowerCase();
  return STRIPPED_HEADERS.has(lower) || lower.startsWith('x-forwarded-');
}

/**
 * Compose two body-transform functions into a single transform.
 * Each transform accepts a Buffer and returns a Buffer (modified) or null (no change).
 *
 * Chain semantics:
 *   - If first returns null (no change), pass the original buffer to second.
 *   - If second returns null, return whatever first returned.
 *   - If both return null, return null.
 *
 * @param {((body: Buffer) => (Buffer | null | Promise<Buffer | null>)) | null} first
 * @param {((body: Buffer) => (Buffer | null | Promise<Buffer | null>)) | null} second
 * @returns {((body: Buffer) => (Buffer | null | Promise<Buffer | null>)) | null}
 */
function composeBodyTransforms(first, second) {
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  const isPromise = (v) => v && typeof v.then === 'function';
  return (body) => {
    const a = first(body);
    if (isPromise(a)) {
      return Promise.resolve(a).then((aResolved) => {
        const b = second(aResolved !== null ? aResolved : body);
        if (isPromise(b)) {
          return Promise.resolve(b).then((bResolved) => {
            if (bResolved !== null) return bResolved;
            if (aResolved !== null) return aResolved;
            return null;
          });
        }
        if (b !== null) return b;
        if (aResolved !== null) return aResolved;
        return null;
      });
    }

    const b = second(a !== null ? a : body);
    if (isPromise(b)) {
      return Promise.resolve(b).then((bResolved) => {
        if (bResolved !== null) return bResolved;
        if (a !== null) return a;
        return null;
      });
    }
    if (b !== null) return b;
    if (a !== null) return a;
    return null;
  };
}

/**
 * Build a standard provider-not-configured proxy response payload.
 *
 * @param {string} provider
 * @param {number} port
 * @param {string} message
 * @returns {{ statusCode: number, body: { error: { message: string, type: string, provider: string, port: number } } }}
 */
function makeProviderNotConfiguredResponse(provider, port, message) {
  return {
    statusCode: 503,
    body: {
      error: {
        message,
        type: 'provider_not_configured',
        provider,
        port,
      },
    },
  };
}

/**
 * Validate that a string is a legal HTTP header name.
 * @param {string} name - The header name to validate
 * @returns {boolean} true if valid
 */
function isValidHeaderName(name) {
  try {
    require('http').validateHeaderName(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and validate a custom auth header from an env var.
 * @param {string} envVarName - The environment variable name (for error messages)
 * @param {string|undefined} rawValue - The raw env var value
 * @param {string} [defaultHeader] - Fallback if value is empty
 * @returns {string} The validated header name (or empty string if no value and no default)
 * @throws {Error} If the value is not a valid HTTP header name
 */
function validateAuthHeaderEnv(envVarName, rawValue, defaultHeader) {
  const header = (rawValue || '').trim() || defaultHeader || '';
  if (!header) return '';
  if (!isValidHeaderName(header)) {
    throw new Error(`Invalid ${envVarName} value: expected a valid HTTP header name`);
  }
  return header;
}

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

module.exports = {
  normalizeApiTarget,
  normalizeBasePath,
  buildUpstreamPath,
  stripGeminiKeyParam,
  shouldStripHeader,
  composeBodyTransforms,
  makeProviderNotConfiguredResponse,
  isValidHeaderName,
  validateAuthHeaderEnv,
  createBaseAdapterConfig,
  createAdapterMethods,
};
