'use strict';

const { selectNextFallbackCandidate } = require('./model-fallback-chain');
const { getCrossProviderRejection } = require('./cross-provider-fallback');
const { MAX_AUTOMATIC_RECOVERIES, getAutomaticRecoveryCandidates } = require('./model-recovery');

function getRouteRejection(candidate, { provider, origin, getProviderAdapter }) {
  if (candidate.provider === provider || candidate.provider === origin.provider) return null;
  return getCrossProviderRejection({
    protocol: origin.protocol,
    targetProvider: candidate.provider,
    adapter: typeof getProviderAdapter === 'function' ? getProviderAdapter(candidate.provider) : null,
  });
}

function selectFallbackCandidate(candidates, {
  origin, provider, attempted, isPermitted, getProviderAdapter, exclude, onSkip,
}) {
  return selectNextFallbackCandidate(candidates, attempted, origin.provider, {
    isPermitted,
    getRouteRejection: candidate => getRouteRejection(candidate, { provider, origin, getProviderAdapter }),
    exclude,
    onSkip,
  });
}

function buildFallbackCandidates({
  chain, automaticRecovery, reason, req, attempted, provider, origin, isPermitted,
}) {
  const automaticModels = automaticRecovery &&
    ['model_not_supported', 'model_endpoint_incompatible'].includes(reason) &&
    (req.awfAutomaticRecoveryCount || (req.awfRecoveryAttempts ? 1 : 0)) < MAX_AUTOMATIC_RECOVERIES
    ? getAutomaticRecoveryCandidates({
      model: attempted[0].model, provider,
      body: origin.sourceBody, url: req.url, req, isPermitted,
    }).map(model => `${provider}/${model}`)
    : [];
  return [...chain, ...automaticModels];
}

module.exports = { getRouteRejection, selectFallbackCandidate, buildFallbackCandidates };
