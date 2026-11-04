'use strict';

const { resolvePricingCandidate, comparePricingResults } = require('../catalogue-contract/pricing-resolution');
const { resolveModelIdentity } = require('../model-identity');
const { logRequest } = require('../logging');
const { isDeepStrictEqual } = require('node:util');

const MAX_DIAGNOSTICS = 32;
const reported = new Set();

function observePricingSource(capture, name) {
  if (!capture) return undefined;
  capture.sources[name] = null;
  return fact => { capture.sources[name] = fact; };
}

function report(event, differences) {
  const key = `${event}:${differences.join(',')}`;
  if (reported.has(key) || reported.size >= MAX_DIAGNOSTICS) return;
  reported.add(key);
  logRequest('warn', event, {
    mode: 'legacy_authoritative',
    differences,
    reason: event === 'pricing_shadow_error' ? 'candidate_comparison_failed' : 'candidate_difference',
  });
}

function comparePricingShadow(capture, legacy, provider, model) {
  try {
    const scope = provider
      ? { provider, channel: provider === 'copilot' ? 'copilot-api' : 'native-api' } : null;
    const identity = provider
      ? resolveModelIdentity(model, provider, { scope, policy: { providerPrefix: false } }).identity : null;
    const candidate = resolvePricingCandidate({ ...capture, identity, scope });
    const differences = comparePricingResults(legacy, candidate.result);
    if (!isDeepStrictEqual(candidate.scope, scope)) differences.push('scope');
    if (!isDeepStrictEqual(candidate.identity, identity)) differences.push('identity');
    if (candidate.capturedAt !== capture.time) differences.push('capturedAt');
    if (differences.length) report('pricing_shadow_difference', differences);
  } catch {
    // Candidate failures are diagnostic only. Never catch an authoritative
    // resolver/accounting failure, or log exception text containing source data.
    report('pricing_shadow_error', []);
  }
}

function resetPricingShadowForTests() {
  reported.clear();
}

module.exports = { observePricingSource, comparePricingShadow, resetPricingShadowForTests };
