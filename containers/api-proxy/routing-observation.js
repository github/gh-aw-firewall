'use strict';

const { stripRedundantProviderPrefix } = require('./model-utils');

const MAX_TELEMETRY_VALUE_LENGTH = 200;

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

function telemetryValue(value) {
  return typeof value === 'string' && value ? value.slice(0, MAX_TELEMETRY_VALUE_LENGTH) : null;
}

/** Normalize an inference path to the endpoint name /reflect advertises. */
function endpointFor(pathname) {
  if (/^\/(?:v1\/)?responses$/.test(pathname)) return '/responses';
  if (/^\/(?:v1\/)?chat\/completions$/.test(pathname)) return '/chat/completions';
  if (/^\/(?:v1\/)?messages$/.test(pathname)) return '/v1/messages';
  return null;
}

function selectedEndpointFor(provider, effort) {
  if (provider === 'anthropic') return '/v1/messages';
  return effort === null ? '/chat/completions' : '/responses';
}

/** Extract the effort a request body asks for, in the shape of its endpoint. */
function requestedEffortFor(parsed, endpoint) {
  const effort = endpoint === '/v1/messages'
    ? parsed.output_config?.effort
    : (endpoint === '/responses' ? parsed.reasoning?.effort : parsed.reasoning_effort);
  return telemetryValue(effort);
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
 * drains responses on the selected provider before the host reads final
 * routing status.
 */
function createRoutingObservation({ getSelection, recordFailure, observer }) {
  let draining = false;
  const active = new Set();
  const waiters = new Set();

  function trackResponse(res, state) {
    active.add(res);
    function complete() {
      active.delete(res);
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
    res.once('close', () => {
      if (active.has(res)) {
        complete();
      }
    });
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

  function recordTelemetry(req, pathname, adapter, selection, body) {
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    const selectedProvider = selection.provider || 'copilot';
    const selectedEffort = Object.hasOwn(selection.choice, 'effort') ? selection.choice.effort : null;
    const selectedEndpoint = selectedEndpointFor(selectedProvider, selectedEffort);
    const endpoint = endpointFor(pathname);
    const normalizedRequestedModel = stripRedundantProviderPrefix(parsed.model, adapter.name);
    const requestedModel = telemetryValue(normalizedRequestedModel);
    const requestedEffort = requestedEffortFor(parsed, endpoint);
    const deviations = [];
    if (adapter.name !== selectedProvider) deviations.push('provider');
    if (normalizedRequestedModel !== selection.wire_model) deviations.push('model');
    if (requestedEffort !== selectedEffort) deviations.push('effort');
    if (endpoint !== selectedEndpoint) deviations.push('endpoint');
    safeRecord(observer, {
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
    });
    return deviations;
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
      const state = { selectedModel: false };
      const tracked = adapter.name === (selection.provider || 'copilot');
      let onSseData;
      if (tracked) {
        trackResponse(res, state);
        observeFailure(res, state);
        onSseData = line => {
          if (!state.selectedModel) return;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event?.error || event?.type === 'response.failed' || event?.type === 'error') {
            const error = event.error || event.response?.error || event;
            recordNativeFailure(error.code || error.type);
          }
        };
      }
      // Observes the body the agent sent and never changes it: returning null
      // leaves the adapter's own transform in charge of the request.
      const bodyTransform = body => {
        try {
          const deviations = recordTelemetry(req, pathname, adapter, selection, body);
          state.selectedModel = !deviations.includes('provider') && !deviations.includes('model');
        } catch {
          // Telemetry must not change the live request.
        }
        return null;
      };
      req.awfRouting = { bodyTransform, ...(onSseData ? { onSseData } : {}) };
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
