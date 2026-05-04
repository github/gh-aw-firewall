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
 * @param {((body: Buffer) => Buffer | null) | null} first
 * @param {((body: Buffer) => Buffer | null) | null} second
 * @returns {((body: Buffer) => Buffer | null) | null}
 */
function composeBodyTransforms(first, second) {
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return (body) => {
    const a = first(body);
    const b = second(a !== null ? a : body);
    if (b !== null) return b;
    if (a !== null) return a;
    return null;
  };
}

/**
 * Extract common adapter configuration from environment variables.
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

module.exports = {
  normalizeApiTarget,
  normalizeBasePath,
  buildUpstreamPath,
  stripGeminiKeyParam,
  shouldStripHeader,
  composeBodyTransforms,
  createBaseAdapterConfig,
};
