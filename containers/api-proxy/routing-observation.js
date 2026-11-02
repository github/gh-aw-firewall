'use strict';

const zlib = require('zlib');
const { stripRedundantProviderPrefix } = require('./model-utils');
const { isValidRequestId } = require('./request-headers');
const { generateRequestId } = require('./logging');
const { extractProviderErrorFields } = require('./provider-error-fields');
const { callerRecordFields } = require('./caller-header');

const MAX_TELEMETRY_VALUE_LENGTH = 200;
const MAX_ERROR_INSPECTION_BYTES = 16_384;
const TELEMETRY_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// Protocol-level terminal success events: Responses `response.completed` and
// Messages `message_stop`. Chat Completions ends with the `[DONE]` sentinel.
const TERMINAL_SUCCESS_EVENTS = new Set(['response.completed', 'message_stop']);

// A /responses request served by a Chat-only model is translated back to the
// client by createChatToResponsesSseTransform(), which emits
// `response.completed` on the upstream usage-only chunk, before `[DONE]`.
function isTranslatedResponses(telemetry) {
  return telemetry.requested_endpoint === '/responses' && telemetry.upstream_endpoint === '/chat/completions';
}

// Mirrors the condition under which that translator emits `response.completed`
// for a parsed upstream Chat Completions chunk.
function isChatUsageOnlyChunk(event) {
  return !!event && !event.error && !event.choices?.[0] && !!event.usage;
}

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
  recordRecovery,
  observer,
  generateRequestId: makeRequestId = generateRequestId,
}) {
  let draining = false;
  const active = new Set();
  const waiters = new Set();
  // Requests are numbered as they start. A selected-model success proves
  // recovery only for failures recorded before that request started.
  let requestSequence = 0;
  let lastFailureSequence = 0;

  // A failure on the selected provider and model. Recoverable failures are
  // upstream errors that a later successful request on the selected model can
  // supersede; the runtime decides once observed requests have drained.
  function fail(code, { recoverable = true } = {}) {
    lastFailureSequence = requestSequence;
    recordFailure(code, { recoverable });
  }

  function trackResponse(req, res, state) {
    active.add(res);
    function finalize() {
      if (!active.has(res)) return;
      active.delete(res);
      res.removeListener('finish', complete);
      res.removeListener('close', complete);
      // A client may close its connection once it has read the terminal
      // success event, before AWF finishes writing (Codex stops reading at
      // response.completed). That is not a provider failure; any other early
      // close still is.
      const clientClosed = !res.writableFinished && state.upstreamCompleted && !state.sseFailed
        && res.statusCode >= 200 && res.statusCode < 300;
      const outcome = clientClosed ? 'client_closed'
        : !res.writableFinished ? 'aborted'
        : req.awfRouting.rejected ? 'rejected'
          : res.statusCode >= 400 || state.sseFailed ? 'failed' : 'completed';
      safeRecord(observer, {
        ...state.telemetry,
        request_id: req.awfRouting.requestId || res.getHeader?.('X-Request-ID') || null,
        outcome,
        status: res.statusCode,
        ...(outcome === 'failed' ? requestErrorFields(req.awfRouting.localError, state.errorFields) : {}),
      });
      // A client that abandons an unfinished request (for example a
      // background call at shutdown) is not a provider failure. An early
      // close is one only when AWF itself tore the response down or an
      // upstream error was observed for this request.
      if (outcome === 'aborted' && state.selectedModel
        && (state.serverAborted || state.sseFailed || res.statusCode >= 400)) {
        fail('provider_unavailable');
      }
      // A selected-model request that started after the latest failure and
      // reached protocol-level success shows the provider recovered. A stream
      // must also have delivered its terminal success event.
      if ((outcome === 'completed' || outcome === 'client_closed') && state.selectedModel
        && state.sequence > lastFailureSequence && (!state.streamed || state.upstreamCompleted)) {
        recordRecovery?.();
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
    res.once('close', () => { state.closed = true; });
    // AWF destroys the downstream response when the upstream fails after
    // headers were sent. A destroy after the client already closed is only
    // cleanup of that client close.
    if (typeof res.destroy === 'function') {
      const originalDestroy = res.destroy;
      res.destroy = function(...args) {
        if (!state.closed && !this.destroyed) state.serverAborted = true;
        return originalDestroy.apply(this, args);
      };
    }
    return {
      sseInspectionStart() {
        state.streamed = true;
        state.sseInspectionPending = true;
      },
      sseInspectionComplete() {
        state.sseInspectionPending = false;
        if (state.responseComplete) finalize();
      },
    };
  }

  function observeFailure(req, res, state, recordsRoutingFailure) {
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
          // A policy rejection is reported as before: it ends the routed run.
          recordNativeFailure(error?.code || error?.type, { recoverable: !req.awfRouting?.rejected });
        }
      }
      return originalEnd.call(this, chunk, encoding, callback);
    };
  }

  function recordNativeFailure(code, options) {
    fail(typeof code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : 'provider_unavailable', options);
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
      // Same attribution fields as the token record for this request_id.
      ...callerRecordFields(req.awfRequestContext?.purpose, req.awfCaller),
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
        sequence: ++requestSequence,
        selectedModel: false,
        sseFailed: false,
        upstreamCompleted: false,
        telemetry: requestTelemetry(req, pathname, adapter, selection),
      };
      const responseHooks = trackResponse(req, res, state);
      observeFailure(req, res, state, adapter.name === (selection.provider || 'copilot'));
      const onSseData = line => {
        if (line === '[DONE]') {
          if (state.telemetry.upstream_endpoint === '/chat/completions') state.upstreamCompleted = true;
          return;
        }
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (TERMINAL_SUCCESS_EVENTS.has(event?.type)
          || (isTranslatedResponses(state.telemetry) && isChatUsageOnlyChunk(event))) {
          state.upstreamCompleted = true;
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
        onModelFallback(fallback) {
          state.selectedModel = false;
          state.telemetry = {
            ...state.telemetry,
            model_fallback: {
              requested_model: telemetryModel(fallback.requested_model),
              model: telemetryModel(fallback.model),
              provider: fallback.provider,
              from_model: telemetryModel(fallback.from_model),
              reason: fallback.reason,
            },
          };
        },
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
