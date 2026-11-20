'use strict';

const { sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');

/** Maximum request body size: 10 MB to prevent DoS via large payloads. */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Create a collector with injected request-error and tracing dependencies.
 *
 * @param {{ handleRequestError: Function, otel: object }} deps
 * @returns {Function}
 */
function createBodyCollector({ handleRequestError, otel }) {
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
  return function collectRequestBody(req, provider, requestId, res, span, startTime, targetHost) {
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
  };
}

module.exports = { createBodyCollector };
