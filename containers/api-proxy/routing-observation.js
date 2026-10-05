'use strict';

const { stripRedundantProviderPrefix } = require('./model-utils');

const MAX_TELEMETRY_VALUE_LENGTH = 200;
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
function createRoutingObservation({ getSelection, recordFailure, observer }) {
  let draining = false;
  const active = new Set();
  const waiters = new Set();

  function trackResponse(req, res, state) {
    active.add(res);
    function complete() {
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
    res.once('finish', complete);
    res.once('close', complete);
  }

  function observeFailure(res, state) {
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
      if (res.statusCode >= 400 && state.selectedModel) {
        let code;
        try {
          const error = bytes <= 16_384 ? JSON.parse(Buffer.concat(chunks).toString('utf8')).error : null;
          code = error?.code || error?.type;
        } catch {}
        recordNativeFailure(code);
      }
      return originalEnd.call(this, chunk, encoding, callback);
    };
  }

  function recordNativeFailure(code) {
    recordFailure(typeof code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : 'provider_unavailable');
  }

  function requestTelemetry(req, pathname, adapter, selection, body) {
    let parsed;
    try {
      parsed = JSON.parse(body?.toString('utf8'));
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
    if (adapter.name !== selectedProvider) deviations.push('provider');
    if (normalizedRequestedModel !== selection.wire_model) deviations.push('model');
    if (normalizedRequestedEffort !== selectedEffort) deviations.push('effort');
    if (endpoint !== selectedEndpoint) deviations.push('endpoint');
    return {
      stage: 'request',
      routed: deviations.length === 0 ? 'as_selected' : 'deviated',
      deviations,
      method: req.method,
      pathname,
      provider: adapter.name,
      requested_model: requestedModel,
      requested_effort: requestedEffort,
      selected_provider: selectedProvider,
      selected_model: selection.wire_model,
      selected_effort: selectedEffort,
      selected_endpoint: selectedEndpoint,
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
      // Upstream failures count as routing failures only for a request that
      // used the selected provider and model; a deviating request is the
      // agent's own choice and never ends the routed run.
      const state = {
        selectedModel: false,
        sseFailed: false,
        telemetry: requestTelemetry(req, pathname, adapter, selection),
      };
      trackResponse(req, res, state);
      if (adapter.name === (selection.provider || 'copilot')) {
        observeFailure(res, state);
      }
      const onSseData = line => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event?.error || event?.type === 'response.failed' || event?.type === 'error') {
          state.sseFailed = true;
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
      req.awfRouting = { bodyTransform, onSseData };
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
