'use strict';

const { logRequest } = require('./logging');
const { shouldStripHeader, sanitizeAcceptEncoding } = require('./proxy-utils');
const { maybeStripLearnedHeaderValues } = require('./deprecated-header-tracker');

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
  Object.assign(headers, injectHeaders);

  if (provider === 'anthropic' || provider === 'copilot') {
    maybeStripLearnedHeaderValues(headers, requestId, provider);
  }

  const isCopilotHost =
    targetHost === 'githubcopilot.com' ||
    targetHost.endsWith('.githubcopilot.com');
  if (isCopilotHost && !headers['x-initiator']) {
    headers['x-initiator'] = 'agent';
  }

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
};
