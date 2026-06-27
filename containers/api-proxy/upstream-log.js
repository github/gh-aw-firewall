'use strict';

const { COPILOT_PLACEHOLDER_TOKEN } = require('./providers/copilot-byok');
const { stripBearerPrefix } = require('./providers/copilot-auth');

// Paths that represent actual LLM inference calls (should count against maxRuns).
// Non-inference endpoints (e.g., GET /models) are excluded.
const INFERENCE_PATHS = [
  '/v1/chat/completions',
  '/chat/completions',
  '/v1/responses',
  '/responses',
  '/v1/messages',
];

function isInferenceRequest(method, url) {
  if (method !== 'POST') return false;
  const path = url.split('?')[0];
  return INFERENCE_PATHS.some((p) => path === p || path.endsWith(p));
}

function buildCopilotAuthErrorMessage(statusCode, env = process.env) {
  const baseMessage = `Upstream returned ${statusCode}`;
  const byokBaseUrl = (env.COPILOT_PROVIDER_BASE_URL || '').trim();
  const byokKey = stripBearerPrefix(env.COPILOT_PROVIDER_API_KEY);
  const hasByokBaseUrl = Boolean(byokBaseUrl);

  if (hasByokBaseUrl && byokKey === COPILOT_PLACEHOLDER_TOKEN) {
    return `${baseMessage} — COPILOT_PROVIDER_API_KEY is the AWF placeholder sentinel. ` +
      'This indicates an internal credential-isolation misconfiguration (real BYOK key not forwarded to api-proxy).';
  }

  if (hasByokBaseUrl && !byokKey) {
    return `${baseMessage} — BYOK provider request to COPILOT_PROVIDER_BASE_URL failed because COPILOT_PROVIDER_API_KEY is not set.`;
  }

  if (hasByokBaseUrl) {
    return `${baseMessage} — BYOK provider request to COPILOT_PROVIDER_BASE_URL failed. ` +
      'Verify COPILOT_PROVIDER_BASE_URL and COPILOT_PROVIDER_API_KEY.';
  }

  return `${baseMessage} — check that the API key is valid and correctly formatted`;
}

function createLogRequestCompletion({ metrics, logRequest, sanitizeForLog, applyMaxRunsInvocation }) {
  return function logRequestCompletion(statusCode, responseBytes, initiatorSent, billingInfo, {
    startTime, provider, req, requestBytes, targetHost, requestId,
  }) {
    const duration = Date.now() - startTime;
    const sc = metrics.statusClass(statusCode);
    metrics.gaugeDec('active_requests', { provider });
    metrics.increment('requests_total', { provider, method: req.method, status_class: sc });
    metrics.increment('response_bytes_total', { provider }, responseBytes);
    metrics.observe('request_duration_ms', duration, { provider });
    if (statusCode >= 200 && statusCode < 300 && isInferenceRequest(req.method, req.url)) {
      applyMaxRunsInvocation();
    }
    const logFields = {
      request_id: requestId, provider, method: req.method,
      path: sanitizeForLog(req.url), status: statusCode,
      duration_ms: duration, request_bytes: requestBytes,
      response_bytes: responseBytes, upstream_host: targetHost,
    };
    if (initiatorSent) logFields.x_initiator = initiatorSent;
    if (billingInfo) logFields.billing = billingInfo;
    logRequest('info', 'request_complete', logFields);
  };
}

function createLogUpstreamAuthError({
  logRequest,
  sanitizeForLog,
  applyPermissionDenied,
  parseModelNotSupportedFromBody,
}) {
  return function logUpstreamAuthError(statusCode, { requestId, provider, targetHost, req, responseBody }) {
    const authErrorMessage = provider === 'copilot'
      ? buildCopilotAuthErrorMessage(statusCode)
      : `Upstream returned ${statusCode} — check that the API key is valid and correctly formatted`;

    if (statusCode === 401 || statusCode === 403) {
      applyPermissionDenied();
      logRequest('warn', 'upstream_auth_error', {
        request_id: requestId, provider, status: statusCode,
        upstream_host: targetHost, path: sanitizeForLog(req.url),
        message: authErrorMessage,
      });
    } else if (statusCode === 400) {
      // Suppress generic auth-error message when the 400 is a model-not-supported
      // error — that case is handled by the model_unavailable diagnostic.
      if (responseBody && parseModelNotSupportedFromBody(responseBody)) return;
      logRequest('warn', 'upstream_auth_error', {
        request_id: requestId, provider, status: statusCode,
        upstream_host: targetHost, path: sanitizeForLog(req.url),
        message: authErrorMessage,
      });
    }
  };
}

module.exports = {
  createLogRequestCompletion,
  createLogUpstreamAuthError,
  buildCopilotAuthErrorMessage,
  isInferenceRequest,
};
