'use strict';

const { COPILOT_PLACEHOLDER_TOKEN } = require('./providers/copilot-byok');
const { stripBearerPrefix } = require('./providers/copilot-auth');

const DEFAULT_MAX_ERROR_RESPONSE_CAPTURE_BYTES = 64 * 1024;
const REDACTED = '[REDACTED]';
const OMITTED_RESPONSE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);
const REQUEST_ID_HEADER_PATTERNS = [
  /request-id$/i,
  /requestid$/i,
  /correlation-id$/i,
  /trace-id$/i,
];

// Paths that represent actual LLM inference calls (should count against maxRuns).
// Non-inference endpoints (e.g., GET /models) are excluded.
const INFERENCE_PATHS = [
  '/v1/chat/completions',
  '/chat/completions',
  '/v1/responses',
  '/responses',
  '/v1/messages',
];

// Gemini inference endpoints use method-style suffixes: :generateContent and
// :streamGenerateContent (POST /v1beta/models/<model>:generateContent, etc.)
const INFERENCE_SUFFIXES = [
  ':generateContent',
  ':streamGenerateContent',
];

function isInferenceRequest(method, url) {
  if (typeof method !== 'string' || typeof url !== 'string') return false;
  if (method !== 'POST') return false;
  // Strip query string, fragment, and trailing slashes before matching.
  const path = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  if (INFERENCE_PATHS.some((p) => path === p || path.endsWith(p))) return true;
  if (INFERENCE_SUFFIXES.some((s) => path.endsWith(s))) return true;
  return false;
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

function coerceHeaderValue(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

function sanitizeResponseHeaders(headers, sanitizeForLog) {
  const sanitized = {};
  const source = headers && typeof headers === 'object' ? headers : {};
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (OMITTED_RESPONSE_HEADERS.has(lower)) continue;
    const safeValue = sanitizeForLog(coerceHeaderValue(value), 1024);
    sanitized[lower] = safeValue;
  }
  return sanitized;
}

function extractUpstreamRequestIds(sanitizedHeaders) {
  const ids = {};
  for (const [name, value] of Object.entries(sanitizedHeaders)) {
    if (!value) continue;
    if (REQUEST_ID_HEADER_PATTERNS.some((pattern) => pattern.test(name))) {
      ids[name] = value;
    }
  }
  return ids;
}

function redactSecretsInText(value) {
  if (typeof value !== 'string' || value.length === 0) return value || '';
  return value
    .replace(/\b(Bearer\s+)[^\s",]+/gi, `$1${REDACTED}`)
    .replace(/("(?:api[_-]?key|authorization|proxy-authorization|cookie|set-cookie|token|secret|password)"\s*:\s*")[^"]*"/gi, `$1${REDACTED}"`)
    .replace(/((?:api[_-]?key|authorization|proxy-authorization|cookie|set-cookie|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, `$1${REDACTED}`);
}

function resolveMaxErrorBodyBytes() {
  const raw = Number.parseInt(process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES, 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_MAX_ERROR_RESPONSE_CAPTURE_BYTES;
}

function buildResponseBodyLogFields({
  responseBody,
  responseBodyBytes,
  responseBodyTruncated = false,
  contentEncoding = '',
  sanitizeForLog,
}) {
  const maxBodyBytes = resolveMaxErrorBodyBytes();
  const rawBytes = Number.isFinite(responseBodyBytes) ? responseBodyBytes : (Buffer.isBuffer(responseBody) ? responseBody.length : 0);
  const sourceBody = Buffer.isBuffer(responseBody) ? responseBody : Buffer.alloc(0);
  const captureBytes = Math.min(sourceBody.length, maxBodyBytes);
  const capturedBody = sourceBody.subarray(0, captureBytes);
  const truncated = responseBodyTruncated || sourceBody.length > maxBodyBytes || rawBytes > maxBodyBytes;
  const contentEncodingValue = String(contentEncoding || '').toLowerCase();
  const compressed = !!contentEncodingValue && contentEncodingValue !== 'identity';
  const bodyValue = compressed
    ? capturedBody.toString('base64')
    : capturedBody.toString('utf8');
  const redactedBody = redactSecretsInText(sanitizeForLog(bodyValue, maxBodyBytes * 4));
  return {
    response_body_content_encoding: compressed ? 'base64' : 'utf8',
    response_body: truncated
      ? `${redactedBody}\n[TRUNCATED ${Math.max(rawBytes - captureBytes, 0)} BYTES]`
      : redactedBody,
    response_body_bytes: rawBytes,
    response_body_captured_bytes: captureBytes,
    response_body_truncated: truncated,
    response_compressed: compressed,
  };
}

function createLogUpstreamErrorResponse({
  logRequest,
  sanitizeForLog,
  auditTrack = null,
}) {
  return function logUpstreamErrorResponse(statusCode, {
    requestId, provider, targetHost, req,
    responseHeaders, responseBody, responseBodyBytes,
    responseBodyTruncated = false,
    requestModel = null, transformed = false,
  }) {
    if (statusCode >= 200 && statusCode < 300) return;
    const safeHeaders = sanitizeResponseHeaders(responseHeaders, sanitizeForLog);
    const upstreamRequestIds = extractUpstreamRequestIds(safeHeaders);
    const contentType = safeHeaders['content-type'] || '';
    const isStreaming = contentType.includes('text/event-stream');
    const bodyFields = buildResponseBodyLogFields({
      responseBody,
      responseBodyBytes,
      responseBodyTruncated,
      contentEncoding: safeHeaders['content-encoding'],
      sanitizeForLog,
    });
    const fields = {
      request_id: requestId,
      provider,
      model: typeof requestModel === 'string' && requestModel.length > 0 ? sanitizeForLog(requestModel, 200) : undefined,
      method: req.method,
      endpoint: sanitizeForLog(req.url),
      status: statusCode,
      upstream_host: targetHost,
      upstream_request_ids: upstreamRequestIds,
      response_content_type: contentType,
      response_headers: safeHeaders,
      response_streaming: isStreaming,
      response_transformed: !!transformed,
      ...bodyFields,
    };
    logRequest('warn', 'upstream_error_response', fields);
    if (typeof auditTrack === 'function') {
      auditTrack('UPSTREAM_ERROR_RESPONSE', fields);
    }
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
  createLogUpstreamErrorResponse,
  createLogUpstreamAuthError,
  buildCopilotAuthErrorMessage,
  isInferenceRequest,
  _testing: {
    sanitizeResponseHeaders,
    extractUpstreamRequestIds,
    redactSecretsInText,
    buildResponseBodyLogFields,
  },
};
