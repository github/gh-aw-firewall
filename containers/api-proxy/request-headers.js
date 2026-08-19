'use strict';

const { randomUUID } = require('crypto');
const { logRequest } = require('./logging');
const { shouldStripHeader, sanitizeAcceptEncoding } = require('./proxy-utils');
const { maybeStripLearnedHeaderValues } = require('./deprecated-header-tracker');

/** Integration ID used when the caller did not configure one. */
const DEFAULT_COPILOT_INTEGRATION_ID = 'agentic-workflows';

/** Cached per-process interaction ID (minted at most once). */
let cachedInteractionId = null;

/**
 * Return true if id is a safe, non-empty request-ID string.
 * Limits length and character set to prevent log injection.
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidRequestId(id) {
  return typeof id === 'string' && id.length <= 128 && /^[\w\-\.]+$/.test(id);
}

/**
 * Resolve the stable `X-Interaction-Id` value used for Copilot API requests.
 *
 * CAPI keys its prompt cache off `X-Interaction-Id`, so the value must be
 * identical for every request of a single run and different across runs. The
 * value is resolved once and cached for the sidecar's lifetime — minting a
 * fresh UUID per request would defeat the cache entirely.
 *
 * Resolution order:
 *   1. `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` (GitHub Actions)
 *   2. A UUID minted once at first use (non-Actions environments)
 *
 * There is deliberately no dedicated override env var: callers that own a
 * session identity can simply send their own non-empty `X-Interaction-Id`
 * header, which `buildRequestHeaders` preserves.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function resolveCopilotInteractionId(env = process.env) {
  if (cachedInteractionId) return cachedInteractionId;
  const runId = (env.GITHUB_RUN_ID || '').trim();
  const runAttempt = (env.GITHUB_RUN_ATTEMPT || '').trim() || '1';
  const derived = runId ? `${runId}-${runAttempt}` : '';
  cachedInteractionId = isValidRequestId(derived) ? derived : randomUUID();
  return cachedInteractionId;
}

/** @internal Reset the cached interaction ID (tests only). */
function resetCopilotInteractionIdForTests() {
  cachedInteractionId = null;
}

/**
 * Set `headers[name] = value` unless an equivalent header is already present
 * with a non-empty value. Case-variant duplicates (e.g. an inbound
 * `copilot-integration-id` alongside an injected `Copilot-Integration-Id`) are
 * removed so the upstream request carries exactly one instance of the header.
 *
 * @param {Record<string, unknown>} headers
 * @param {string} name - Canonical header name to set when none is present
 * @param {string} value
 */
function ensureHeader(headers, name, value) {
  const lower = name.toLowerCase();
  let kept = null;
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() !== lower) continue;
    const current = headers[existing];
    const isEmpty = typeof current !== 'string' ? current == null : current.trim() === '';
    if (isEmpty || kept !== null) {
      delete headers[existing];
      continue;
    }
    kept = existing;
  }
  if (kept === null) headers[name] = value;
}

function isCopilotHost(targetHost) {
  return targetHost === 'githubcopilot.com' ||
    (typeof targetHost === 'string' && targetHost.endsWith('.githubcopilot.com'));
}

function mergeInjectedHeaders(headers, injectHeaders, targetHost) {
  const copilotHost = isCopilotHost(targetHost);
  for (const [name, value] of Object.entries(injectHeaders)) {
    if (!copilotHost && name.toLowerCase() === 'copilot-integration-id') continue;
    headers[name] = value;
  }
}

function applyCopilotHostHeaders(headers, targetHost) {
  if (!isCopilotHost(targetHost)) return;

  if (!headers['x-initiator']) {
    headers['x-initiator'] = 'agent';
  }
  // CAPI keys its prompt cache off X-Interaction-Id and its quota bucket /
  // model allowlist off Copilot-Integration-Id. Harnesses that are not the
  // Copilot CLI (aider, Pi, ...) often send neither, which kills the prompt
  // cache and drops the traffic into an "unknown" attribution bucket.
  // Scoped to the Copilot host only, so BYOK targets (Azure OpenAI, ...) and
  // other providers never receive these headers.
  ensureHeader(headers, 'x-interaction-id', resolveCopilotInteractionId());
  ensureHeader(
    headers,
    'copilot-integration-id',
    (process.env.COPILOT_INTEGRATION_ID || '').trim() || DEFAULT_COPILOT_INTEGRATION_ID
  );
}

/**
 * Build the headers object for the upstream request.
 * Strips headers matched by `shouldStripHeader()`, merges injected auth
 * headers, sets the request-id, and adjusts content-length when the body was
 * transformed.
 *
 * @param {Buffer} body - Final (possibly transformed) request body
 * @param {number} inboundBytes - Original body size before transforms
 * @param {import('http').IncomingMessage} req
 * @param {{ injectHeaders: object, provider: string, targetHost: string, requestId: string }} opts
 * @returns {object} Headers object for the upstream request
 */
function buildRequestHeaders(body, inboundBytes, req, { injectHeaders, provider, targetHost, requestId }) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!shouldStripHeader(name)) headers[name] = value;
  }
  headers['x-request-id'] = requestId;
  mergeInjectedHeaders(headers, injectHeaders, targetHost);

  if (provider === 'anthropic' || provider === 'copilot') {
    maybeStripLearnedHeaderValues(headers, requestId, provider);
  }

  applyCopilotHostHeaders(headers, targetHost);

  if (body.length !== inboundBytes) {
    headers['content-length'] = String(body.length);
    delete headers['transfer-encoding'];
  }

  // Restrict Accept-Encoding to encodings the token tracker can decompress.
  // Without this, upstream APIs may respond with unsupported encodings (e.g.
  // zstd) that the tracker cannot parse, causing silent token-usage data loss.
  if (headers['accept-encoding']) {
    headers['accept-encoding'] = sanitizeAcceptEncoding(headers['accept-encoding']);
  }

  const injectedKey = Object.entries(injectHeaders).find(([k]) =>
    ['x-api-key', 'authorization', 'x-goog-api-key'].includes(k.toLowerCase())
  )?.[1];
  if (injectedKey) {
    const keyPreview = injectedKey.length > 8
      ? `${injectedKey.substring(0, 8)}...${injectedKey.substring(injectedKey.length - 4)}`
      : '(short)';
    logRequest('debug', 'auth_inject', {
      request_id: requestId, provider,
      key_length: injectedKey.length, key_preview: keyPreview,
      has_anthropic_version: !!headers['anthropic-version'],
    });
  }

  return headers;
}

module.exports = {
  isValidRequestId,
  buildRequestHeaders,
  mergeInjectedHeaders,
  applyCopilotHostHeaders,
  resolveCopilotInteractionId,
  resetCopilotInteractionIdForTests,
  DEFAULT_COPILOT_INTEGRATION_ID,
};
