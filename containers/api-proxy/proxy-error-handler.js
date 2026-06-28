'use strict';

/**
 * AWF API Proxy — Request error handling.
 *
 * Extracted from proxy-request.js to isolate error handling and response
 * construction from the main proxy plumbing.
 */

const metrics = require('./metrics');
const { sanitizeForLog, logRequest } = require('./logging');

/**
 * Handle an upstream/proxy request error: log, decrement gauges, and send
 * an error response to the client.
 *
 * @param {Error} err - The error that occurred
 * @param {object} opts
 * @param {import('http').ServerResponse} opts.res - Client response
 * @param {string} opts.requestId - Unique request identifier
 * @param {string} opts.provider - Provider name for metrics
 * @param {import('http').IncomingMessage} opts.req - Client request
 * @param {string} opts.targetHost - Upstream host
 * @param {number} opts.startTime - Request start timestamp (ms)
 * @param {number} opts.statusCode - HTTP status code to return
 * @param {string} opts.clientMessage - Human-readable error message for client
 * @param {function} [opts.extraMetrics] - Optional callback for additional metrics
 * @param {function} [opts.onHeadersSent] - Optional callback when headers already sent
 */
function handleRequestError(err, {
  res,
  requestId,
  provider,
  req,
  targetHost,
  startTime,
  statusCode,
  clientMessage,
  extraMetrics,
  onHeadersSent,
}) {
  const duration = Date.now() - startTime;
  metrics.gaugeDec('active_requests', { provider });
  metrics.increment('requests_errors_total', { provider });
  if (extraMetrics) extraMetrics(duration);
  logRequest('error', 'request_error', {
    request_id: requestId, provider, method: req.method,
    path: sanitizeForLog(req.url), duration_ms: duration,
    error: sanitizeForLog(err.message), upstream_host: targetHost,
  });
  if (res.headersSent) {
    if (onHeadersSent) onHeadersSent(err);
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: clientMessage, message: err.message }));
}

module.exports = { handleRequestError };
