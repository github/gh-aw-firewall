'use strict';

/**
 * AWF API Proxy — HTTP Guard Enforcement.
 *
 * Quota and token guard business logic: evaluates all common security guards
 * for an inbound HTTP request and sends the appropriate blocked response.
 * Separated from proxy-request.js so the guard decision path can be audited
 * and unit-tested in isolation.
 */

const metrics = require('./metrics');
const { logRequest, sanitizeForLog } = require('./logging');
const { writeBlockedRequestDiag } = require('./blocked-request-diagnostics');
const { buildCommonGuardChecks } = require('./guards/common-guard-checks');
const {
  getEffectiveTokenBlockState,
  buildEffectiveTokenLimitError,
} = require('./guards/effective-token-guard');
const {
  getMaxRunsBlockState,
  buildMaxRunsExceededError,
} = require('./guards/max-runs-guard');
const {
  getMaxCacheMissesBlockState,
  buildMaxCacheMissesExceededError,
} = require('./guards/max-cache-misses-guard');
const {
  getPermissionDeniedBlockState,
  buildPermissionDeniedLimitError,
} = require('./guards/max-permission-denied-guard');
const {
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  checkUnknownModelRejection,
} = require('./guards/ai-credits-guard');
const {
  getModelMultiplierCapBlockState,
  buildModelMultiplierCapError,
} = require('./guards/max-model-multiplier-guard');
const {
  getRetiredModelBlockState,
  buildRetiredModelError,
} = require('./guards/retired-model-guard');
const {
  getModelPolicyBlockState,
  buildModelPolicyError,
} = require('./guards/model-policy-guard');

// ── Optional OTEL tracing (graceful degradation when not bundled) ─────────────
let otel;
try {
  otel = require('./otel');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    // No-op shims so callers need no guard checks
    const noop = () => {};
    otel = {
      startRequestSpan:  () => ({}),
      setTokenAttributes: noop,
      setBudgetAttributes: noop,
      endSpan:           noop,
      endSpanError:      noop,
      shutdown:          () => Promise.resolve(),
      isEnabled:         () => false,
    };
  } else {
    throw err;
  }
}

// ── Guard enforcement ─────────────────────────────────────────────────────────

/**
 * Attempt to extract the `model` field from a JSON request body.
 * Returns null for non-JSON bodies, bodies without a string `model` field,
 * or any parse failures.
 *
 * @param {Buffer} body
 * @returns {string|null}
 */
function extractModelFromBody(body) {
  if (!body || body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return typeof parsed.model === 'string' ? parsed.model : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the guard-blocked HTTP response to the client and emit diagnostics.
 *
 * @param {object} block - Guard block descriptor returned by a guard getter
 * @param {{ req: object, res: object, provider: string, requestId: string,
 *           startTime: number, span: object, statusCode: number,
 *           eventName: string, buildError: Function, buildLogFields: Function,
 *           body: Buffer, inboundBytes: number }} ctx
 */
function sendGuardBlockedResponse(block, {
  req,
  res,
  provider,
  requestId,
  startTime,
  span,
  statusCode,
  eventName,
  buildError,
  buildLogFields,
  body,
  inboundBytes,
}) {
  const duration = Date.now() - startTime;
  const guardLogFields = buildLogFields(block);
  metrics.gaugeDec('active_requests', { provider });
  metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
  metrics.observe('request_duration_ms', duration, { provider });
  logRequest('warn', eventName, {
    request_id: requestId,
    provider,
    ...guardLogFields,
  });
  otel.endSpan(span, statusCode);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
  res.end(JSON.stringify(buildError(block)));

  writeBlockedRequestDiag({
    requestId,
    provider,
    path: sanitizeForLog(req.url),
    guardType: eventName,
    guardLogFields,
    body: body || Buffer.alloc(0),
    inboundBytes: inboundBytes || 0,
  });
}

/**
 * Evaluate all common security guards for an inbound HTTP request.
 * Calls sendGuardBlockedResponse and returns true if any guard blocks the
 * request; returns false when all guards pass.
 *
 * @param {{ body: Buffer, provider: string, req: object, res: object,
 *           requestId: string, startTime: number, span: object,
 *           inboundBytes: number }} ctx
 * @returns {boolean}
 */
function enforceGuards({ body, provider, req, res, requestId, startTime, span, inboundBytes }) {
  const checkModelMultiplier = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
  const model = checkModelMultiplier ? extractModelFromBody(body) : null;

  const guardChecks = buildCommonGuardChecks({
    getEffectiveTokenBlockState,
    buildEffectiveTokenLimitError,
    getMaxRunsBlockState,
    buildMaxRunsExceededError,
    getMaxCacheMissesBlockState,
    buildMaxCacheMissesExceededError,
    getPermissionDeniedBlockState,
    buildPermissionDeniedLimitError,
    getAiCreditsBlockState,
    buildAiCreditsLimitError,
    getModelMultiplierCapBlockState,
    buildModelMultiplierCapError,
    getRetiredModelBlockState,
    buildRetiredModelError,
    checkUnknownModelRejection,
    getModelPolicyBlockState,
    buildModelPolicyError,
  }, model);

  for (const guard of guardChecks) {
    if (!guard.isBlocked(guard.block)) continue;
    sendGuardBlockedResponse(guard.block, {
      req,
      res,
      provider,
      requestId,
      startTime,
      span,
      statusCode: guard.statusCode,
      eventName: guard.eventName,
      buildError: guard.buildError,
      buildLogFields: guard.buildLogFields,
      body,
      inboundBytes,
    });
    return true;
  }

  return false;
}

module.exports = {
  sendGuardBlockedResponse,
  enforceGuards,
};
