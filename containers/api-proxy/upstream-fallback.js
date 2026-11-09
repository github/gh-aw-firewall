'use strict';

const { parseBodyAsObject } = require('./body-utils');
const {
  getFallbackUpstreamEndpoint,
  protocolForPath,
  getRequiredResponseFeatures,
} = require('./cross-provider-fallback');
const { rewriteRequestModel, getRequestModel } = require('./model-fallback-chain');
const { assessRequestCompatibility } = require('./protocol-compatibility/assessment');
const { getRequestReasoning } = require('./model-reasoning');
const {
  carryForwardWireApiCompatibility,
  endpointForPath,
  replaceUpstreamEndpoint,
  translateCopilotWireApi,
} = require('./wire-api-compat');

const ASSESSMENT_PROTOCOLS = Object.freeze({
  chat: 'chat_completions', responses: 'responses', messages: 'anthropic_messages',
});

function createFallbackAssessment({ origin, req }) {
  const requiredResponseFeatures = getRequiredResponseFeatures(origin.sourceBody, origin.protocol);
  return (candidate, path, host = origin.targetHost, scheme = origin.targetScheme) => {
    const nativePassthrough = ['gemini', 'vertex'].includes(origin.provider) &&
      candidate.provider === origin.provider && host === origin.targetHost && scheme === origin.targetScheme &&
      getRequestModel(origin.body, origin.upstreamPath)?.location === 'path' &&
      /\/models\/[^/:?]+:(?:generateContent|streamGenerateContent)(?:\?|$)/.test(origin.upstreamPath) &&
      rewriteRequestModel({ body: origin.body, upstreamPath: origin.upstreamPath }, 'path', candidate.model)
        ?.upstreamPath === path;
    const reasoning = path && typeof candidate.model === 'string'
      ? getRequestReasoning(candidate.model, candidate.provider, req.awfRuntimePricing, req, {
        targetHost: host, targetScheme: scheme,
      }) : null;
    return {
      compatibility: assessRequestCompatibility({
        body: origin.sourceBody,
        source: ASSESSMENT_PROTOCOLS[origin.protocol] || null,
        target: ASSESSMENT_PROTOCOLS[protocolForPath(path)] || null,
        candidate: { provider: candidate.provider, model: candidate.model },
        pins: { eligibilityRevision: req.awfEligibility?.revision, catalogueRevision: req.awfCatalogue?.revision },
        reasoning, requiredResponseFeatures, nativePassthrough,
      }),
      reasoning,
    };
  };
}

function createFallbackDecisionObserver({ req, origin }) {
  return (candidate, outcome, assessment) => {
    if (typeof req.awfObserveModelDecision !== 'function') return;
    try {
      req.awfObserveModelDecision({
        provider: candidate.provider, model: outcome === 'exhausted' ? null : candidate.model,
        endpoint: origin.endpoint, originProvider: origin.provider, originModel: origin.model,
        outcome, compatibility: assessment.compatibility,
        reason: outcome === 'exhausted' ? 'fallback_exhausted'
          : `fallback_${assessment.compatibility.status}`,
        eligibilityRevision: req.awfEligibility?.revision, catalogueRevision: req.awfCatalogue?.revision,
        reasoning: assessment.reasoning,
      });
    } catch {
      // Optional diagnostics cannot affect inference admission.
    }
  };
}

function rebuildCopilotWireApiFallback(sourceBody, nextModel, req, upstreamPath, preserveEndpoint = false) {
  const requestedEndpoint = endpointForPath(req?.url);
  const parsed = parseBodyAsObject(sourceBody);
  if (!requestedEndpoint || !parsed || typeof parsed.model !== 'string') return null;

  parsed.model = nextModel;
  const nextSourceBody = Buffer.from(JSON.stringify(parsed), 'utf8');
  const plannedEndpoint = endpointForPath(getFallbackUpstreamEndpoint(
    'copilot', nextModel, req.url, preserveEndpoint, req.awfRuntimePricing,
  )) || requestedEndpoint;
  const translated = plannedEndpoint === requestedEndpoint ? null
    : translateCopilotWireApi(nextSourceBody, req.url, { upstreamEndpoint: plannedEndpoint });
  const compatibility = translated?.compatibility || {
    requestedEndpoint,
    upstreamEndpoint: requestedEndpoint,
    passthrough: true,
  };
  req.awfRouting?.onEndpointTranslation?.(compatibility);
  return {
    body: translated?.body || nextSourceBody,
    upstreamPath: replaceUpstreamEndpoint(
      upstreamPath,
      compatibility.upstreamEndpoint,
    ),
    wireApiCompatibility: compatibility,
    wireApiSourceBody: nextSourceBody,
  };
}

module.exports = {
  createFallbackAssessment,
  createFallbackDecisionObserver,
  rebuildCopilotWireApiFallback,
  carryForwardWireApiCompatibility,
  endpointForPath,
  replaceUpstreamEndpoint,
  translateCopilotWireApi,
};
