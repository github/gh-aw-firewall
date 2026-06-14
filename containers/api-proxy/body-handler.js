'use strict';

/**
 * AWF API Proxy — Request body I/O and transformation.
 *
 * Responsibilities:
 *   1. collectRequestBody  — stream the inbound HTTP body, enforce the 10 MB
 *                            size limit, and surface 400/413 errors inline.
 *   2. transformRequestBody — apply the sequential body-transform pipeline
 *                             (caller transform → null-tool-call sanitisation →
 *                             steering injection → stream_options injection).
 *
 * Both functions are returned by `createBodyHandler(deps)` so that callers
 * (proxy-request.js) can inject `handleRequestError` and `otel` without
 * creating a circular-module dependency.
 *
 * The `_sleep` indirection (and its test setters) lives here because it is
 * the module most tightly coupled to async timing in the request pipeline.
 * proxy-request.js imports `sleep` from this module and uses it for the
 * model-not-supported retry backoff.
 */

const { sanitizeNullToolCallTypes, injectSteeringMessage, injectStreamOptions } = require('./body-transform');
const { sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');
const { getAndClearPendingSteeringMessage } = require('./guards/effective-token-guard');
const { getAndClearPendingTimeoutSteeringMessage } = require('./guards/timeout-steering');

/** Maximum request body size: 10 MB to prevent DoS via large payloads. */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/** When false, token-budget warnings are never injected into request bodies. */
const isSteeringEnabled = () => process.env.AWF_ENABLE_TOKEN_STEERING === 'true';

// ── Sleep abstraction (overridable in tests to avoid real setTimeout delays) ──

/** Resolves after `ms` milliseconds (overridable in tests via module-level setter). */
let _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Thin indirection used by proxy-request.js so that replacing `_sleep` via
 * `_setSleepForTests` is reflected in all callers without them needing to
 * re-import the variable.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => _sleep(ms);

/** @internal Test-only: replace the sleep implementation so retries are instant. */
function _setSleepForTests(fn) { _sleep = fn; }
/** @internal Test-only: restore the real sleep implementation. */
function _resetSleepForTests() { _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)); }

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the body-handler functions with injected dependencies.
 *
 * @param {{ handleRequestError: Function, otel: object }} deps
 * @returns {{ collectRequestBody: Function, transformRequestBody: Function }}
 */
function createBodyHandler({ handleRequestError, otel }) {
  /**
   * Collect the full request body from the inbound stream, enforcing the 10 MB
   * size limit. Sends a 413 response inline when the limit is exceeded, and
   * handles client stream errors with a 400 response.
   *
   * @param {import('http').IncomingMessage} req
   * @param {string} provider
   * @param {string} requestId
   * @param {import('http').ServerResponse} res
   * @param {object} span - OTEL span (or no-op shim)
   * @param {number} startTime - Request start timestamp (ms)
   * @param {string} targetHost - Upstream hostname (used in log fields)
   * @returns {Promise<Buffer|null>} Collected body, or null if the request was
   *   already rejected (413) or errored before the body was fully received.
   */
  function collectRequestBody(req, provider, requestId, res, span, startTime, targetHost) {
    return new Promise((resolve) => {
      const chunks = [];
      let totalBytes = 0;
      let settled = false;

      function settle(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }

      req.on('close', () => {
        if (settled || req.complete) return;
        const duration = Date.now() - startTime;
        metrics.gaugeDec('active_requests', { provider });
        logRequest('warn', 'request_aborted', {
          request_id: requestId, provider, method: req.method,
          path: sanitizeForLog(req.url), duration_ms: duration,
          upstream_host: targetHost,
        });
        otel.endSpan(span, 0);
        settle(null);
      });

      req.on('error', (err) => {
        if (settled) return;
        otel.endSpanError(span, err, 400);
        handleRequestError(err, {
          res, requestId, provider, req, targetHost,
          startTime, statusCode: 400, clientMessage: 'Client error',
        });
        settle(null);
      });

      req.on('data', (chunk) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_SIZE) {
          const duration = Date.now() - startTime;
          metrics.gaugeDec('active_requests', { provider });
          metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
          logRequest('warn', 'request_complete', {
            request_id: requestId, provider, method: req.method,
            path: sanitizeForLog(req.url), status: 413, duration_ms: duration,
            request_bytes: totalBytes, upstream_host: targetHost,
          });
          otel.endSpan(span, 413);
          if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload Too Large', message: 'Request body exceeds 10 MB limit' }));
          settle(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        settle(Buffer.concat(chunks));
      });
    });
  }

  /**
   * Apply the sequential body-transform pipeline to the raw inbound body.
   *
   * Transforms applied in order:
   *   1. `bodyTransform` — optional caller-supplied transform
   *   2. `sanitizeNullToolCallTypes` — strips/normalizes null tool-call types
   *   3. `injectSteeringMessage` — timeout + token-budget steering (when enabled)
   *   4. `injectStreamOptions` — adds `stream_options.include_usage`
   *
   * @param {Buffer} body
   * @param {string} provider
   * @param {import('http').IncomingMessage} req
   * @param {string} requestId
   * @param {((body: Buffer) => (Buffer | null | Promise<Buffer | null>)) | null} bodyTransform
   * @returns {Promise<Buffer>}
   */
  async function transformRequestBody(body, provider, req, requestId, bodyTransform) {
    if (bodyTransform && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
      const transformed = await bodyTransform(body);
      if (transformed) body = transformed;
    }

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const sanitized = sanitizeNullToolCallTypes(body);
      if (sanitized) {
        body = sanitized.body;
        logRequest('info', 'request_sanitized', {
          request_id: requestId,
          provider,
          normalized_tool_calls: sanitized.normalizedCount,
          dropped_tool_calls: sanitized.droppedCount,
        });
      }
    }

    if (isSteeringEnabled() && (req.method === 'POST' || req.method === 'PUT')) {
      const steeringMessages = [
        { type: 'timeout', message: getAndClearPendingTimeoutSteeringMessage() },
        { type: 'token', message: getAndClearPendingSteeringMessage() },
      ];
      for (const { type, message } of steeringMessages) {
        if (!message) continue;
        const steered = injectSteeringMessage(body, provider, message);
        if (steered) {
          body = steered;
          logRequest('info', `${type}_steering`, {
            request_id: requestId,
            provider,
            message,
          });
        }
      }
    }

    // Inject stream_options.include_usage so streaming responses include token data
    if (req.method === 'POST') {
      const streamOpts = injectStreamOptions(body, provider, req.url);
      if (streamOpts) {
        body = streamOpts.body;
      }
    }

    return body;
  }

  return { collectRequestBody, transformRequestBody };
}

module.exports = { createBodyHandler, sleep, _setSleepForTests, _resetSleepForTests };
