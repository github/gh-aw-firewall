'use strict';

const zlib = require('zlib');
const { stripRedundantProviderPrefix } = require('./model-utils');
const { isValidRequestId } = require('./request-headers');
const { generateRequestId } = require('./logging');
const { extractProviderErrorFields } = require('./provider-error-fields');

const MAX_TELEMETRY_VALUE_LENGTH = 200;
const MAX_ERROR_INSPECTION_BYTES = 16_384;
const TELEMETRY_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Record a per-request routing observation. Never throws: observability must
 * not change the live request or response.
 *
 * @param {{ record: (record: object) => void }} [observer]
 * @param {object} record
 */
function safeRecord(observer, record) {
  try {
    observer?.record?.(Object.freeze(record));
  } catch {
    // Observability must not change the live request or response.
  }
}

function telemetryModel(value) {
  return typeof value === 'string' && value && !/[^A-Za-z0-9_.:/-]/.test(value)
    ? value.slice(0, MAX_TELEMETRY_VALUE_LENGTH) : null;
}

/** Normalize an inference path to the endpoint name /reflect advertises. */
function endpointFor(pathname) {
  if (/^\/(?:v1\/)?responses$/.test(pathname)) return '/responses';
  if (/^\/(?:v1\/)?chat\/completions$/.test(pathname)) return '/chat/completions';
  if (/^\/(?:v1\/)?messages$/.test(pathname)) return '/v1/messages';
  return null;
}

function selectedEndpointFor(selection, provider, effort) {
  if (typeof selection.endpoint === 'string') return selection.endpoint;
  if (provider === 'anthropic') return '/v1/messages';
  return effort === null ? '/chat/completions' : '/responses';
}

/**
 * Error identifiers for a failed request record. AWF's own rejection of the
 * attempt wins over anything observed in the response body, because the
 * provider never saw that attempt.
 */
function requestErrorFields(localError, upstreamFields) {
  const local = localError ? extractProviderErrorFields({ error: localError }) : {};
  const [source, fields] = local.error_code || local.error_type
    ? ['awf', local]
    : ['upstream', upstreamFields || {}];
  const result = {};
  if (fields.error_code) result.error_code = fields.error_code;
  if (fields.error_type) result.error_type = fields.error_type;
  if (Object.keys(result).length > 0) result.error_source = source;
  return result;
}

/**
 * Parse a bounded, decoded copy of an error body. Only gzip, deflate, and
 * Brotli are decoded, and decoding stops at MAX_ERROR_INSPECTION_BYTES.
 * Throws when the body cannot be decoded or parsed.
 */
function parseEncodedErrorBody(buffer, contentEncoding) {
  const encoding = typeof contentEncoding === 'string' ? contentEncoding.trim().toLowerCase() : '';
  const options = { maxOutputLength: MAX_ERROR_INSPECTION_BYTES };
  let decoded;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoded = zlib.gunzipSync(buffer, options);
  else if (encoding === 'deflate') decoded = zlib.inflateSync(buffer, options);
  else if (encoding === 'br') decoded = zlib.brotliDecompressSync(buffer, options);
  else return null;
  return JSON.parse(decoded.toString('utf8'));
}

/** Keep the first set of provider error fields observed for a request. */
function rememberErrorFields(state, value) {
  if (state.errorFields) return;
  const fields = extractProviderErrorFields(value);
  if (fields.error_code || fields.error_type) state.errorFields = fields;
}

/** Extract the effort a request body asks for, in the shape of its endpoint. */
function requestedEffortFor(parsed, endpoint) {
  const effort = endpoint === '/v1/messages'
    ? parsed.output_config?.effort
    : (endpoint === '/responses' ? parsed.reasoning?.effort : parsed.reasoning_effort);
  return typeof effort === 'string' && effort ? effort : null;
}

/**
 * Observe routed execution at the primary HTTP boundary.
 *
 * The routing selection is advisory: the agent is seeded with it through
 * /reflect, but may send any model that model policy permits. Nothing here
 * rejects or rewrites a request. For each inference request this records
 * deviation telemetry (requested vs. routed model, effort, endpoint, and
 * provider), observes genuine upstream failures for requests that used the
 * selected provider and model without changing native response bytes, and
 * drains all observed responses before the host reads final
 * routing status.
 */
function createRoutingObservation({
  getSelection,
  recordFailure,
  observer,
  generateRequestId: makeRequestId = generateRequestId,
}) {
  let draining = false;
  const active = new Set();
  const waiters = new Set();

  function trackResponse(req, res, state) {
    active.add(res);
    function finalize() {
      if (!active.has(res)) return;
      active.delete(res);
      res.removeListener('finish', complete);
      res.removeListener('close', complete);
      const outcome = !res.writableFinished ? 'aborted'
        : req.awfRouting.rejected ? 'rejected'
          : res.statusCode >= 400 || state.sseFailed ? 'failed' : 'completed';
      safeRecord(observer, {
        ...state.telemetry,
        request_id: req.awfRouting.requestId || res.getHeader?.('X-Request-ID') || null,
        outcome,
        status: res.statusCode,
        ...(outcome === 'failed' ? requestErrorFields(req.awfRouting.localError, state.errorFields) : {}),
      });
      if (!res.writableFinished && state.selectedModel) {
        recordFailure('provider_unavailable');
      }
      if (active.size === 0) {
        for (const resolve of waiters) {
          resolve();
        }
        waiters.clear();
      }
    }
    function complete() {
      if (!active.has(res)) return;
      if (state.sseInspectionPending) {
        state.responseComplete = true;
        return;
      }
      finalize();
    }
    res.once('finish', complete);
    res.once('close', complete);
    return {
      sseInspectionStart() {
        state.sseInspectionPending = true;
      },
      sseInspectionComplete() {
        state.sseInspectionPending = false;
        if (state.responseComplete) finalize();
      },
    };
  }

  function observeFailure(res, state, recordsRoutingFailure) {
    const originalWrite = res.write;
    const originalEnd = res.end;
    const chunks = [];
    let bytes = 0;
    function collect(chunk, encoding) {
      if (res.statusCode < 400 || !chunk || bytes > 16_384) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      bytes += buffer.length;
      if (bytes <= 16_384) {
        chunks.push(buffer);
      }
    }
    res.write = function(chunk, encoding, callback) {
      collect(chunk, encoding);
      return originalWrite.call(this, chunk, encoding, callback);
    };
    res.end = function(chunk, encoding, callback) {
      collect(chunk, encoding);
      if (res.statusCode >= 400) {
        let parsed = null;
        try {
          parsed = bytes <= 16_384 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        } catch {}
        try {
          // The client receives the bytes unchanged; a compressed upstream
          // body is inspected only through a bounded, decoded copy.
          rememberErrorFields(state, parsed ?? (bytes <= MAX_ERROR_INSPECTION_BYTES
            ? parseEncodedErrorBody(Buffer.concat(chunks), state.upstreamContentEncoding) : null));
        } catch {
          // Observability must not change the live response.
        }
        if (recordsRoutingFailure && state.selectedModel) {
          const error = parsed?.error;
          recordNativeFailure(error?.code || error?.type);
        }
      }
      return originalEnd.call(this, chunk, encoding, callback);
    };
  }

  function recordNativeFailure(code) {
    recordFailure(typeof code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : 'provider_unavailable');
  }

  function requestTelemetry(req, pathname, adapter, selection, body) {
    const bodyObserved = body !== undefined;
    let parsed;
    try {
      parsed = bodyObserved ? JSON.parse(body?.toString('utf8')) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    const selectedProvider = selection.provider || 'copilot';
    const selectedEffort = Object.hasOwn(selection.choice, 'effort') ? selection.choice.effort : null;
    const selectedEndpoint = selectedEndpointFor(selection, selectedProvider, selectedEffort);
    const endpoint = endpointFor(pathname);
    const normalizedRequestedModel = stripRedundantProviderPrefix(parsed.model, adapter.name);
    const requestedModel = telemetryModel(normalizedRequestedModel);
    const normalizedRequestedEffort = requestedEffortFor(parsed, endpoint);
    const requestedEffort = TELEMETRY_EFFORTS.has(normalizedRequestedEffort) ? normalizedRequestedEffort : null;
    const deviations = [];
    const unavailable = bodyObserved ? [] : ['model', 'effort'];
    if (adapter.name !== selectedProvider) deviations.push('provider');
    if (bodyObserved && normalizedRequestedModel !== selection.wire_model) deviations.push('model');
    if (bodyObserved && normalizedRequestedEffort !== selectedEffort) deviations.push('effort');
    if (endpoint !== selectedEndpoint) deviations.push('endpoint');
    const routingDeviations = deviations.filter(deviation => deviation !== 'endpoint');
    return {
      stage: 'request',
      routed: routingDeviations.length > 0 ? 'deviated' : unavailable.length > 0 ? 'unobserved' : 'as_selected',
      deviations,
      unavailable,
      method: req.method,
      pathname,
      provider: adapter.name,
      requested_model: requestedModel,
      requested_effort: requestedEffort,
      selected_provider: selectedProvider,
      selected_model: selection.wire_model,
      selected_effort: selectedEffort,
      selected_endpoint: selectedEndpoint,
      requested_endpoint: endpoint,
      upstream_endpoint: endpoint,
    };
  }

  return Object.freeze({
    /**
     * Attach advisory routing observation to an inference request. Never
     * rejects: the request continues through the normal proxy pipeline, and
     * model policy remains the only model enforcement surface.
     */
    observeRequest(req, res, adapter) {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        return;
      }
      const selection = getSelection();
      if (draining || !selection || req.method !== 'POST' || !endpointFor(pathname)) return;
      const clientRequestId = req.headers?.['x-request-id'];
      const requestId = isValidRequestId(clientRequestId) ? clientRequestId : makeRequestId();
      // Upstream failures count as routing failures only for a request that
      // used the selected provider and model; a deviating request is the
      // agent's own choice and never ends the routed run.
      const state = {
        selectedModel: false,
        sseFailed: false,
        telemetry: requestTelemetry(req, pathname, adapter, selection),
      };
      const responseHooks = trackResponse(req, res, state);
      observeFailure(res, state, adapter.name === (selection.provider || 'copilot'));
      const onSseData = line => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event?.error || event?.type === 'response.failed' || event?.type === 'error') {
          state.sseFailed = true;
          rememberErrorFields(state, event);
          if (state.selectedModel) {
            const error = event.error || event.response?.error || event;
            recordNativeFailure(error.code || error.type);
          }
        }
      };
      // Observes the body the agent sent and never changes it: returning null
      // leaves the adapter's own transform in charge of the request.
      const bodyTransform = body => {
        try {
          state.telemetry = requestTelemetry(req, pathname, adapter, selection, body);
          const { deviations } = state.telemetry;
          state.selectedModel = !deviations.includes('provider') && !deviations.includes('model');
        } catch {
          // Telemetry must not change the live request.
        }
        return null;
      };
      req.awfRouting = {
        requestId,
        bodyTransform,
        onModelSelectorResolution: bodyTransform,
        onEndpointTranslation(compatibility) {
          if (!compatibility || compatibility.requestedEndpoint !== state.telemetry.requested_endpoint) return;
          state.telemetry = {
            ...state.telemetry,
            upstream_endpoint: compatibility.upstreamEndpoint,
          };
        },
        onUpstreamResponseHeaders(headers) {
          state.upstreamContentEncoding = headers?.['content-encoding'];
        },
        onSseData,
        onSseInspectionStart: responseHooks.sseInspectionStart,
        onSseInspectionComplete: responseHooks.sseInspectionComplete,
      };
    },
    async drain() {
      draining = true;
      if (active.size) {
        await new Promise(resolve => waiters.add(resolve));
      }
    },
  });
}

module.exports = { createRoutingObservation };
