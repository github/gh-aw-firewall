'use strict';

const { logRequest } = require('./logging');
const { normalizeUsage } = require('./token-parsers');
const {
  writeTokenUsage,
  buildTokenUsageRecord,
  incrementTokenMetrics,
  diag,
  auditTrack,
} = require('./token-persistence');
const { warnCacheReadRollupMismatch, mergeBudgetFields } = require('./token-tracker-shared');
const {
  extractUsageFromTrackedState,
  hasCompleteModelUsage,
  reportUnsupportedCursorAccounting,
} = require('./token-usage-extraction');

function notifyObserver(callback, ...args) {
  try {
    return callback?.(...args);
  } catch {
    // best-effort callback
  }
}

/**
 * Build a token usage record and persist it.
 *
 * Bundles record assembly (`buildTokenUsageRecord`), budget-field merging
 * (`mergeBudgetFields`), billing/initiator decorators, `writeTokenUsage`,
 * and the `logRequest` summary — pure persistence/reporting with no quota
 * logic.
 *
 * @param {object} normalized - Normalized usage object
 * @param {object} params
 * @param {string} params.requestId
 * @param {string} params.provider
 * @param {string} params.model
 * @param {string} params.reqPath
 * @param {number} params.status
 * @param {boolean} params.streaming
 * @param {number} params.duration
 * @param {number} params.responseBytes
 * @param {object|null} params.billingInfo
 * @param {string|null} params.initiatorSent
 * @param {object|undefined} params.budgetResult
 * @param {{ type: string, threshold: number }|undefined} [params.steering]
 * @param {object|null} [params.caller] - Parsed x-awf-caller (req.awfCaller)
 * @param {object|undefined} [params.modelFallback] - Ordered-fallback details when the request was served by a fallback model
 */
function buildAndWriteTokenRecord(normalized, { requestId, provider, model, reqPath, status, streaming, duration, responseBytes, billingInfo, initiatorSent, budgetResult, purpose, caller, steering, modelFallback, requestedEndpoint, upstreamEndpoint }) {
  const record = buildTokenUsageRecord(normalized, {
    requestId,
    provider,
    model,
    reqPath,
    status,
    streaming,
    duration,
    responseBytes,
    purpose,
    caller,
    steering,
    requestedEndpoint,
    upstreamEndpoint,
  });

  // Include billing/quota info when available (Copilot PRU tracking)
  if (initiatorSent) record.x_initiator = initiatorSent;
  if (billingInfo) record.billing = billingInfo;
  // Record which model actually served the request when the ordered fallback
  // chain switched away from the requested model.
  if (modelFallback) record.model_fallback = modelFallback;

  // Include AI credit budget fields when computed
  mergeBudgetFields(record, budgetResult);

  // Write to JSONL log file
  writeTokenUsage(record);

  // Log summary to stdout
  logRequest('info', 'token_usage', {
    request_id: requestId,
    provider,
    model: model || 'unknown',
    input_tokens: normalized.input_tokens,
    output_tokens: normalized.output_tokens,
    cache_read_tokens: normalized.cache_read_tokens,
    cache_write_tokens: normalized.cache_write_tokens,
    streaming,
    ...(modelFallback ? { requested_model: modelFallback.requested_model, model_fallback_attempt: modelFallback.attempt } : {}),
  });
}

function skipUnsuccessfulResponse(proxyRes, opts) {
  const { requestId, provider } = opts;
  notifyObserver(() => opts.onUsageMissing?.());
  auditTrack('TRACK_END', { rid: requestId, result: 'skip_status', status: proxyRes.statusCode });
  logRequest('debug', 'token_track_skip_status', {
    request_id: requestId,
    provider,
    status: proxyRes.statusCode,
  });
  diag('HTTP_TRACK_SKIP_STATUS', { request_id: requestId, provider, status: proxyRes.statusCode });
}

function handleMissingUsage(state, proxyRes, opts) {
  if (reportUnsupportedCursorAccounting(state, proxyRes, opts)) {
    notifyObserver(() => opts.onUsageMissing?.());
    return false;
  }

  const { requestId, provider, path: reqPath } = opts;
  const { streaming, contentEncoding } = state;
  auditTrack('TRACK_END', { rid: requestId, result: 'no_usage', streaming, bytes: state.totalBytes, overflow: state.overflow, ct: state.contentType, ce: contentEncoding });
  // Log at info level so failed extraction is visible in CI without debug mode
  logRequest('info', 'token_track_no_usage', {
    request_id: requestId,
    provider,
    path: reqPath,
    streaming,
    total_bytes: state.totalBytes,
    overflow: state.overflow,
    content_encoding: contentEncoding,
    content_type: state.contentType,
    message: 'No token usage extracted from 2xx response',
  });
  return true;
}

function recordUsage(state, proxyRes, opts, usage, normalized, model, duration) {
  const {
    requestId, provider, path: reqPath, metrics: metricsRef, billingInfo, initiatorSent,
    requestModel, onUsage, purpose, caller, modelFallback, requestedEndpoint, upstreamEndpoint,
    steering,
  } = opts;
  const { streaming } = state;

  auditTrack('TRACK_END', { rid: requestId, result: 'ok', streaming, model: model || requestModel, input: normalized.input_tokens, output: normalized.output_tokens, cache_read: normalized.cache_read_tokens });

  if (state.observedCacheReadTokens > 0 && normalized.cache_read_tokens === 0) {
    warnCacheReadRollupMismatch({ logRequest, diag, requestId, provider, model, observedCacheReadTokens: state.observedCacheReadTokens, normalizedCacheReadTokens: normalized.cache_read_tokens, streaming });
  }

  if (!hasCompleteModelUsage(usage)) {
    notifyObserver(() => opts.onUsageMissing?.());
  }
  const budgetResult = typeof onUsage === 'function'
    ? notifyObserver(onUsage, normalized, model || requestModel || provider || 'unknown')
    : undefined;

  // Update metrics only after the budget callback.
  incrementTokenMetrics(metricsRef, provider, normalized);

  // Build log record and persist
  buildAndWriteTokenRecord(normalized, {
    requestId,
    provider,
    model: model || requestModel || provider,
    reqPath,
    status: proxyRes.statusCode,
    streaming,
    duration,
    responseBytes: state.totalBytes,
    billingInfo,
    initiatorSent,
    budgetResult,
    purpose,
    caller,
    steering,
    modelFallback,
    requestedEndpoint,
    upstreamEndpoint,
  });
}

/**
 * Finalize token tracking for an HTTP response.
 *
 * Orchestrates usage extraction, normalization, quota callback, metrics
 * update, and record persistence. Accepts explicit state instead of relying
 * on a closure, making it independently unit-testable.
 *
 * @param {object} state - Mutable tracking state from initHttpState
 * @param {object} proxyRes - Upstream response (only statusCode is read)
 * @param {object} opts - Original options passed to trackTokenUsage
 */
function finalizeHttpTracking(state, proxyRes, opts) {
  const { onSpanEnd } = opts;
  let missingUsageAfterSpan = false;
  if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
    skipUnsuccessfulResponse(proxyRes, opts);
  } else {
    const { requestId, provider, startTime } = opts;
    const { streaming, compressed, contentEncoding } = state;
    const duration = Date.now() - startTime;
    const { usage, model } = extractUsageFromTrackedState(state);

    logRequest('debug', 'token_track_end', {
      request_id: requestId,
      provider,
      streaming,
      total_bytes: state.totalBytes,
      overflow: state.overflow,
      has_usage: !!usage,
      usage_keys: usage ? Object.keys(usage) : [],
      model,
      compressed,
    });
    diag('HTTP_TRACK_END', { request_id: requestId, provider, streaming, total_bytes: state.totalBytes, overflow: state.overflow, has_usage: !!usage, usage_keys: usage ? Object.keys(usage) : [], model, compressed, content_encoding: contentEncoding });

    const normalized = normalizeUsage(usage);
    if (!normalized) {
      missingUsageAfterSpan = handleMissingUsage(state, proxyRes, opts);
    } else {
      recordUsage(state, proxyRes, opts, usage, normalized, model, duration);
    }
  }

  if (typeof onSpanEnd === 'function') onSpanEnd(proxyRes.statusCode);
  // Preserve the ordinary no-usage path's span-before-enforcement ordering.
  if (missingUsageAfterSpan) notifyObserver(() => opts.onUsageMissing?.());
}

function finalizeUnsupportedEncoding(state, proxyRes, opts, completeSseInspection) {
  const { requestId, provider, path: reqPath } = opts;
  const { contentEncoding } = state;
  auditTrack('TRACK_SKIP_ENCODING', { rid: requestId, ce: contentEncoding });
  logRequest('warn', 'token_track_unsupported_encoding', {
    request_id: requestId,
    provider,
    path: reqPath,
    content_encoding: contentEncoding,
    message: `Cannot decompress ${contentEncoding} responses; token usage will not be extracted. ` +
      'The Accept-Encoding sanitizer should have prevented this — check if the client bypassed the proxy header rewrite.',
  });
  diag('HTTP_TRACK_UNSUPPORTED_ENCODING', { request_id: requestId, provider, path: reqPath, content_encoding: contentEncoding });
  reportUnsupportedCursorAccounting(
    state,
    proxyRes,
    opts,
    `unsupported_content_encoding_${contentEncoding}`,
    contentEncoding,
  );
  completeSseInspection();
  notifyObserver(() => opts.onUsageMissing?.());
  if (typeof opts.onSpanEnd === 'function') opts.onSpanEnd(proxyRes.statusCode);
}

module.exports = {
  finalizeHttpTracking,
  finalizeUnsupportedEncoding,
  buildAndWriteTokenRecord,
  notifyObserver,
};
