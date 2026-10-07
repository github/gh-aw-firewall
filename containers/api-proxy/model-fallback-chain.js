'use strict';

/**
 * Ordered model fallback chain for AWF API proxy.
 *
 * When `AWF_FALLBACK_MODELS` is set (an ordered list of concrete model IDs),
 * an upstream request that fails with a *model-specific* failure is re-sent
 * with the `model` rewritten to the next model in the list.
 *
 * Eligible failures:
 *   - any 5xx upstream response (500, 502, 503, 504, ...)
 *   - an upstream connection error/timeout before any response was received
 *   - a 400/404 whose body reports that the model is unknown, unsupported,
 *     not found, or not accessible (e.g. Copilot "model_not_supported")
 *
 * Never eligible: 401/403 (credentials) and 429 (rate limit) — switching models
 * cannot fix those and would only burn quota on the next model.
 *
 * The model is rewritten in the JSON request body `model` field (OpenAI,
 * Anthropic, Copilot) or, when the body carries no model, in the
 * `/models/<model>:<method>` upstream path segment (Gemini).
 *
 * Entries may be provider-qualified (`openai/gpt-5.4`,
 * `anthropic/claude-sonnet-4.6`, `copilot/grok-4.7`). A qualified entry whose
 * provider differs from the listener that received the request switches the
 * upstream provider as well as the model (see cross-provider-fallback.js).
 * Unqualified entries, and entries qualified with the receiving provider,
 * keep the request on the receiving provider.
 */

const { parseBodyAsObject } = require('./body-utils');
const { stripRedundantProviderPrefix } = require('./model-utils');
const { getProviderAliases } = require('./provider-pricing-overlays');

/**
 * Patterns that identify a model-specific 400/404 error body.  Kept narrow so
 * generic validation errors (bad JSON, bad tool schema, context too long) are
 * surfaced to the client instead of silently switching models.
 */
const MODEL_SPECIFIC_ERROR_PATTERNS = [
  /model_not_supported/i,
  /model_not_found/i,
  /the requested model is not supported/i,
  /not accessible via the .+? endpoint/i,
  /\b(?:unknown|invalid|unsupported) model\b/i,
  /\bmodel\b[^"\n]{0,120}?\b(?:does not exist|not found|is not supported|not supported|is not available|not available|has been deprecated|is deprecated|is retired)\b/i,
  /\bmodels\/[^\s"]+ is not found\b/i,
  /"type"\s*:\s*"not_found_error"[^}]*"message"\s*:\s*"model:|"message"\s*:\s*"model:[^}]*"type"\s*:\s*"not_found_error"/i,
];

/**
 * Provider prefixes recognised in fallback entries, mapped to the canonical
 * adapter name. Unknown prefixes are treated as part of the model ID (e.g. an
 * OpenAI-compatible BYOK model such as `meta-llama/llama-3.3-70b`).
 */
const FALLBACK_PROVIDER_PREFIXES = Object.freeze({
  copilot: 'copilot',
  'github-copilot': 'copilot',
  github: 'copilot',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  google: 'gemini',
  vertex: 'vertex',
});

/** Path segment carrying the model for Gemini-style endpoints. */
const PATH_MODEL_PATTERN = /(\/models\/)([^/:?]+)(:[^/?]*)/;

/**
 * Parse an ordered fallback model list from a raw env value.  Accepts either a
 * JSON array of strings or a comma/newline separated list.  Entries are
 * trimmed, empty entries dropped, and case-insensitive duplicates removed while
 * preserving order.
 *
 * @param {string|null|undefined} raw
 * @returns {string[]}
 */
function parseFallbackModels(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const trimmed = raw.trim();
  let entries;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      entries = Array.isArray(parsed) ? parsed.filter(e => typeof e === 'string') : [];
    } catch {
      entries = [];
    }
  } else {
    entries = trimmed.split(/[,\n]/);
  }
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const model = entry.trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

/**
 * Read the configured fallback chain from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function getFallbackModels(env = process.env) {
  return parseFallbackModels(env.AWF_FALLBACK_MODELS);
}

/**
 * @param {Buffer|string|null|undefined} body
 * @returns {boolean} true when the body reports a model-specific failure.
 */
function isModelSpecificErrorBody(body) {
  if (!body || body.length === 0) return false;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  return MODEL_SPECIFIC_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Classify an upstream response as fallback-eligible.
 *
 * @param {number} statusCode
 * @param {Buffer|string|null} [body]
 * @returns {string|null} The fallback reason, or null when not eligible.
 */
function getFallbackReason(statusCode, body) {
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) return null;
  if (statusCode >= 500 && statusCode <= 599) return statusCode === 504 ? 'upstream_timeout' : 'upstream_5xx';
  if ((statusCode === 400 || statusCode === 404) && isModelSpecificErrorBody(body)) return 'model_not_supported';
  return null;
}

/**
 * Locate the model carried by an upstream request.
 *
 * @param {Buffer} body
 * @param {string} upstreamPath
 * @returns {{ model: string, location: 'body'|'path' } | null}
 */
function getRequestModel(body, upstreamPath) {
  const parsed = parseBodyAsObject(body);
  if (parsed && typeof parsed.model === 'string' && parsed.model.trim()) {
    return { model: parsed.model, location: 'body' };
  }
  const match = typeof upstreamPath === 'string' ? upstreamPath.match(PATH_MODEL_PATTERN) : null;
  if (match) {
    let model = match[2];
    try { model = decodeURIComponent(model); } catch { /* keep raw */ }
    return { model, location: 'path' };
  }
  return null;
}

/**
 * Normalize a configured fallback entry for the receiving provider by stripping
 * a redundant "<provider>/" prefix (e.g. "copilot/gpt-5" on the Copilot port).
 *
 * @param {string} model
 * @param {string} provider
 * @returns {string}
 */
function normalizeFallbackModel(model, provider) {
  if (!provider) return model;
  for (const alias of getProviderAliases(String(provider).toLowerCase())) {
    const stripped = stripRedundantProviderPrefix(model, alias);
    if (stripped !== model) return stripped;
  }
  return model;
}

/**
 * Resolve a configured fallback entry against the provider that received the
 * request.
 *
 * @param {string} entry - Configured entry, optionally `<provider>/<model>`
 * @param {string} originProvider - Provider whose listener received the request
 * @returns {{ entry: string, provider: string, model: string, qualified: boolean }}
 */
function resolveFallbackEntry(entry, originProvider) {
  const value = String(entry);
  const slashIdx = value.indexOf('/');
  if (slashIdx > 0) {
    const prefixProvider = FALLBACK_PROVIDER_PREFIXES[value.slice(0, slashIdx).toLowerCase()];
    const model = value.slice(slashIdx + 1);
    if (prefixProvider && model) {
      if (prefixProvider === originProvider) {
        return { entry: value, provider: originProvider, model: normalizeFallbackModel(value, originProvider), qualified: true };
      }
      return { entry: value, provider: prefixProvider, model, qualified: true };
    }
  }
  return { entry: value, provider: originProvider, model: value, qualified: false };
}

/**
 * Normalize a previously attempted model (string or `{ provider, model }`)
 * into an attempt descriptor.
 *
 * @param {string|{provider?: string, model: string}} attempt
 * @param {string} provider - Provider assumed for bare strings
 * @returns {{ provider: string, model: string }}
 */
function toAttempt(attempt, provider) {
  if (attempt && typeof attempt === 'object') {
    return { provider: attempt.provider || provider, model: String(attempt.model) };
  }
  return { provider, model: String(attempt) };
}

function attemptKey(provider, model) {
  return `${String(provider).toLowerCase()}\u0000${String(model).toLowerCase()}`;
}

/**
 * Pick the next candidate from the chain that has not been attempted yet, can
 * be routed, and is permitted by the guards for its *target* provider.
 *
 * Candidates are never invented: only configured entries are returned, in the
 * configured order.
 *
 * @param {string[]} chain - Ordered fallback list
 * @param {Array<string|{provider: string, model: string}>} attempted - Attempts so far
 * @param {string} originProvider - Provider whose listener received the request
 * @param {{
 *   isPermitted?: (model: string, provider: string) => boolean,
 *   getRouteRejection?: (candidate: object) => string|null,
 *   onSkip?: (candidate: object, reason: string) => void,
 *   exclude?: Set<string>,
 * }} [options]
 * @returns {{ entry: string, provider: string, model: string, qualified: boolean } | null}
 */
function selectNextFallbackCandidate(chain, attempted, originProvider, options = {}) {
  const { isPermitted, getRouteRejection, onSkip, exclude } = options;
  const attemptedKeys = new Set((attempted || []).map((a) => {
    const { provider, model } = toAttempt(a, originProvider);
    return attemptKey(provider, normalizeFallbackModel(model, provider));
  }));
  for (const entry of chain || []) {
    const candidate = resolveFallbackEntry(entry, originProvider);
    if (!candidate.model) continue;
    const key = attemptKey(candidate.provider, candidate.model);
    if (attemptedKeys.has(key) || (exclude && exclude.has(key))) continue;
    if (typeof getRouteRejection === 'function') {
      let rejection;
      try {
        rejection = getRouteRejection(candidate);
      } catch {
        rejection = 'route_unavailable';
      }
      if (rejection) {
        onSkip?.(candidate, rejection);
        continue;
      }
    }
    if (typeof isPermitted === 'function') {
      let permitted;
      try {
        permitted = isPermitted(candidate.model, candidate.provider) === true;
      } catch {
        permitted = false;
      }
      if (!permitted) {
        onSkip?.(candidate, 'guard_rejected');
        continue;
      }
    }
    return candidate;
  }
  return null;
}

/**
 * Validate that every provider-qualified fallback entry references a provider
 * that is configured for this run (endpoint plus credentials).
 *
 * @param {string[]} chain
 * @param {(provider: string) => ({ isEnabled: () => boolean } | null | undefined)} getAdapter
 * @returns {string[]} Actionable error messages (empty when valid)
 */
function validateFallbackChain(chain, getAdapter) {
  const errors = [];
  for (const entry of chain || []) {
    const slashIdx = entry.indexOf('/');
    if (slashIdx <= 0) continue;
    const provider = FALLBACK_PROVIDER_PREFIXES[entry.slice(0, slashIdx).toLowerCase()];
    if (!provider) continue;
    if (!entry.slice(slashIdx + 1)) {
      errors.push(`apiProxy.fallbackModels entry "${entry}" names provider "${provider}" but no model.`);
      continue;
    }
    let adapter = null;
    try {
      adapter = typeof getAdapter === 'function' ? getAdapter(provider) : null;
    } catch {
      adapter = null;
    }
    let configured = false;
    try {
      configured = !!adapter && adapter.isEnabled() === true;
      if (!configured && adapter) {
        configured = ['getOidcProvider', 'getAwsOidcProvider']
          .some(getter => typeof adapter[getter] === 'function' && !!adapter[getter]());
      }
    } catch {
      configured = false;
    }
    if (!configured) {
      errors.push(
        `apiProxy.fallbackModels entry "${entry}" targets provider "${provider}", which is not configured ` +
        `for this run (no endpoint credentials). Configure ${PROVIDER_CREDENTIAL_HINTS[provider] || `credentials for ${provider}`} ` +
        'or remove the entry.',
      );
    }
  }
  return errors;
}

const PROVIDER_CREDENTIAL_HINTS = Object.freeze({
  copilot: 'COPILOT_GITHUB_TOKEN (or COPILOT_PROVIDER_API_KEY for a Copilot BYOK provider)',
  openai: 'OPENAI_API_KEY (or OpenAI OIDC auth)',
  anthropic: 'ANTHROPIC_API_KEY (or Anthropic OIDC auth)',
  gemini: 'GEMINI_API_KEY',
  vertex: 'GOOGLE_API_KEY (or Vertex AI OIDC auth)',
});

/**
 * Pick the next model from the chain that has not been attempted yet and is
 * permitted by the caller-supplied predicate.
 *
 * @param {string[]} chain - Ordered fallback list
 * @param {string[]} attemptedModels - Models already sent upstream for this request
 * @param {string} provider
 * @param {(model: string, provider: string) => boolean} [isPermitted]
 * @returns {string|null}
 */
function selectNextFallbackModel(chain, attemptedModels, provider, isPermitted) {
  const attempted = new Set(
    (attemptedModels || []).map(m => normalizeFallbackModel(String(m), provider).toLowerCase())
  );
  for (const entry of chain || []) {
    const model = normalizeFallbackModel(entry, provider);
    if (!model || attempted.has(model.toLowerCase())) continue;
    if (typeof isPermitted === 'function') {
      let permitted;
      try {
        permitted = isPermitted(model, provider) === true;
      } catch {
        permitted = false;
      }
      if (!permitted) continue;
    }
    return model;
  }
  return null;
}

/**
 * Rewrite the model of an upstream request.
 *
 * @param {{ body: Buffer, upstreamPath: string }} request
 * @param {'body'|'path'} location
 * @param {string} nextModel
 * @returns {{ body: Buffer, upstreamPath: string } | null}
 */
function rewriteRequestModel({ body, upstreamPath }, location, nextModel) {
  if (location === 'body') {
    const parsed = parseBodyAsObject(body);
    if (!parsed) return null;
    parsed.model = nextModel;
    return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), upstreamPath };
  }
  if (location === 'path') {
    if (typeof upstreamPath !== 'string' || !PATH_MODEL_PATTERN.test(upstreamPath)) return null;
    return {
      body,
      upstreamPath: upstreamPath.replace(PATH_MODEL_PATTERN, (_m, pre, _old, post) => `${pre}${encodeURIComponent(nextModel)}${post}`),
    };
  }
  return null;
}

module.exports = {
  FALLBACK_PROVIDER_PREFIXES,
  resolveFallbackEntry,
  selectNextFallbackCandidate,
  validateFallbackChain,
  attemptKey,
  toAttempt,
  parseFallbackModels,
  getFallbackModels,
  isModelSpecificErrorBody,
  getFallbackReason,
  getRequestModel,
  normalizeFallbackModel,
  selectNextFallbackModel,
  rewriteRequestModel,
};
