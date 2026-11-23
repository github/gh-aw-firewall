'use strict';

const { validateReasoningEffort } = require('./reasoning-effort-validation');
const { sanitizeForLog } = require('./logging');

function rejectInvalidReasoningEffort({
  body, provider, upstreamPath, req, res, targetHost, targetScheme, requestId, startTime, span,
}, { metrics, otel, logRequest }) {
  try {
    validateReasoningEffort(body, provider, upstreamPath, req.awfRuntimePricing, req, { targetHost, targetScheme });
  } catch (err) {
    if (err.code !== 'unsupported_reasoning_effort') throw err;
    if (res.headersSent) return true;

    const statusCode = err.statusCode || 400;
    const duration = Date.now() - startTime;
    metrics.gaugeDec('active_requests', { provider });
    metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
    logRequest?.('warn', 'request_validation_failed', {
      request_id: requestId,
      provider,
      method: req.method,
      path: sanitizeForLog(req.url),
      status: statusCode,
      duration_ms: duration,
      error_code: err.code,
    });
    otel.endSpan(span, statusCode);
    if (req.awfRouting) {
      req.awfRouting.localError = { code: err.code, type: err.type || 'invalid_request_error' };
    }
    res.writeHead(statusCode, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
    res.end(JSON.stringify({
      error: {
        message: err.message,
        type: err.type || 'invalid_request_error',
        code: err.code,
      },
    }));
    return true;
  }
  return false;
}

function rejectEnclaveBudgetAttempt(budgetAttempt, {
  req, res, provider, requestId, span,
}, { metrics, otel, logRequest }) {
  if (budgetAttempt.allowed) return false;

  const statusCode = budgetAttempt.reason === 'invalid_capability' ? 403 : 429;
  metrics.gaugeDec('active_requests', { provider });
  metrics.increment('requests_total', {
    provider,
    method: req.method,
    status_class: '4xx',
  });
  logRequest?.('warn', 'enclave_model_budget_rejected', {
    request_id: requestId,
    provider,
    reason: budgetAttempt.reason,
  });
  const capabilityEvent = {
    missing: 'enclave_model_capability_missing',
    scheme: 'enclave_model_capability_scheme',
    format: 'enclave_model_capability_format',
    signature: 'enclave_model_capability_signature',
    claims: 'enclave_model_capability_claims',
    claims_changed: 'enclave_model_capability_claims_changed',
  }[budgetAttempt.capabilityFailure];
  if (budgetAttempt.reason === 'invalid_capability' && capabilityEvent) {
    logRequest?.('warn', capabilityEvent, { status: statusCode });
  }
  if (budgetAttempt.reason === 'token_limit') {
    logRequest?.('warn', 'enclave_model_token_limit', { status: statusCode });
    const tokenEvent = {
      body_missing: 'enclave_model_token_body_missing',
      input_reservation: 'enclave_model_token_input_reservation',
      request_json: 'enclave_model_token_request_json',
      request_shape: 'enclave_model_token_request_shape',
      output_conflict: 'enclave_model_token_output_conflict',
      output_shape: 'enclave_model_token_output_shape',
      stream_options: 'enclave_model_token_stream_options',
      budget_exhausted: 'enclave_model_token_budget_exhausted',
    }[budgetAttempt.tokenFailure];
    if (typeof tokenEvent === 'string') {
      logRequest?.('warn', tokenEvent, { status: statusCode });
    }
  }
  otel.endSpan(span, statusCode);
  if (res.headersSent) {
    res.destroy?.();
    return true;
  }
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
  });
  res.end(JSON.stringify({
    error: {
      message: 'Enclave model budget exhausted or invalid',
      type: 'awf_enclave_model_budget_error',
      code: `awf_enclave_model_budget_${budgetAttempt.reason}`,
    },
  }));
  return true;
}

module.exports = { rejectInvalidReasoningEffort, rejectEnclaveBudgetAttempt };
