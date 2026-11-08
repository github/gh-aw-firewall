'use strict';

const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');
const {
  MAX_RECENT, RETENTION_SECONDS, endpointFor, modelId, revision, observedAt,
  projectCapturedEligibility,
} = require('./model-decision-diagnostics');

const MAX_LOCAL_RESPONSE_BYTES = 16_384;

/**
 * A bounded projection of local responses and already captured request pins.
 * Routing's existing observer only covers routed runs and persists private
 * logs, not a management-safe decision view. Never read those logs or inspect
 * provider payloads here; never retain a request, body, header, or identifier.
 */
function createModelDecisionObservation({ context = 'unknown', getModels = () => ({}),
  modelPolicy = null, now = Date.now } = {}) {
  const entries = new Map();
  const enabled = context === 'primary-agent';

  function retain(record) {
    const { observedAt: timestamp, ...fields } = record;
    const key = JSON.stringify(fields);
    const previous = entries.get(key);
    const time = now();
    const repeated = previous && time - previous.time <= RETENTION_SECONDS * 1000;
    entries.delete(key);
    entries.set(key, { record: Object.freeze({ ...fields, observedAt: timestamp,
      occurrences: repeated ? Math.min(1000, previous.record.occurrences + 1) : 1 }), time });
    if (entries.size > MAX_RECENT) entries.delete(entries.keys().next().value);
  }

  function capture(req, provider, endpoint, error, publish) {
    if (req.awfRequestContext?.purpose && req.awfRequestContext.purpose !== 'agent') return;
    if (req.awfCaller?.purpose === 'subagent') return;
    if (req.awfEligibilityScope?.deployment !== undefined) return;
    const selected = req.awfAliasEligibilityRejection || req.awfSelectedModelEligibility;
    const expectedChannel = provider === 'copilot' ? 'copilot-api' : 'native-api';
    for (const scope of [selected?.decision?.scope, error?.scope]) {
      if (scope && (scope.provider !== provider || scope.channel !== expectedChannel ||
          scope.deployment !== undefined)) return;
    }
    const pins = {
      provider, endpoint,
      eligibilityRevision: Number.isSafeInteger(req.awfEligibility?.revision) ? req.awfEligibility.revision : null,
      catalogueRevision: revision(req.awfCatalogue?.revision),
      observedAt: observedAt(new Date(now()).toISOString()),
      rejected: true,
    };
    if (error?.code === 'model_harness_incompatible') {
      const captured = selected?.provider === provider ? selected.decision : null;
      const records = projectCapturedEligibility({ ...pins, decision: captured }, context)
        .filter(record => record.reason.startsWith('harness_'));
      if (records.length) {
        for (const record of records) publish({ ...pins, reason: record.reason, model: null });
      } else {
        // The public error conflates incompatibility and absent evidence. Only
        // its structured reasons can distinguish them when no selection exists.
        const reasons = Array.isArray(error.reasons) ? error.reasons.slice(0, 16) : [];
        const allowed = new Set(['harness_incompatible', 'harness_unverified',
          'harness_constraint_invalid', 'harness_selection_invalid', 'harness_observation_invalid']);
        for (const reason of reasons) {
          if (allowed.has(reason?.code)) publish({ ...pins, reason: reason.code, model: null });
        }
        if (!reasons.some(reason => allowed.has(reason?.code))) {
          publish({ ...pins, reason: 'decision_unknown', model: null });
        }
      }
      return;
    }
    const reason = error?.type === 'model_policy_violation' ? 'policy_denied'
      : error?.type === 'pricing_resolution_error' ? 'pricing_resolution_error'
      : ['unsupported_reasoning_effort', 'pricing_resolution_error'].includes(error?.code) ? error.code : null;
    if (!reason) return;
    // A policy-denied model is intentionally never named, even if a later
    // policy/current inventory changes. We explain the rejection, not the rule.
    // The initial selection is not the identity of a later fallback attempt.
    // Only a structured identity on the rejecting response can name it.
    const requestedModel = reason === 'policy_denied' ? null : modelId(error.model);
    const models = getModels()[provider];
    const visible = requestedModel && Array.isArray(models) && models.includes(requestedModel) &&
      isModelPermittedByPolicy(requestedModel, modelPolicy?.allowedModels ?? null,
        modelPolicy?.disallowedModels ?? null, provider);
    publish({ ...pins, reason, model: visible ? requestedModel : null,
      rejected: reason !== 'pricing_resolution_error' });
  }

  function observeRequest(req, res, provider) {
    const pathname = typeof req.url === 'string' ? req.url.split(/[?#]/, 1)[0].replace(/\/+$/, '') : null;
    const endpoint = endpointFor(pathname);
    if (!enabled || req.method !== 'POST' || !endpoint || typeof res.once !== 'function') return;
    let pending = [];
    const originalEnd = res.end;
    res.end = function(chunk, encoding, callback) {
      try {
        if (!res.awfUpstreamResponse && res.statusCode >= 400 &&
            (typeof chunk === 'string' || Buffer.isBuffer(chunk)) &&
            Buffer.byteLength(chunk) <= MAX_LOCAL_RESPONSE_BYTES) {
          const error = JSON.parse(chunk.toString()).error;
          // Capture only our allowlisted decision fields; the parsed response
          // and any message text go out of scope before the original end().
          capture(req, provider, endpoint, error, record => pending.push(record));
        }
      } catch {
        // Diagnostics must never change response bytes, accounting, or errors.
      }
      return originalEnd.call(this, chunk, encoding, callback);
    };
    // No outcome is published for an aborted or unfinished response.
    res.once('finish', () => {
      try {
        if (!res.awfUpstreamResponse) pending.forEach(retain);
      } catch {
        // Observation failure must not change the live response.
      }
      pending = [];
    });
    res.once('close', () => { pending = []; });
  }

  return Object.freeze({
    getRecent() {
      if (!enabled) return null;
      const time = now();
      return [...entries.values()].filter(entry => time - entry.time <= RETENTION_SECONDS * 1000)
        .map(entry => ({ ...entry.record }));
    },
    wrapProxyRequest(proxyRequest) {
      return function(req, res, ...args) {
        observeRequest(req, res, args[2]);
        return proxyRequest(req, res, ...args);
      };
    },
  });
}

module.exports = { createModelDecisionObservation };
