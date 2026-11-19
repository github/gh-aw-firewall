'use strict';

const { rebuildBodyFramingHeaders } = require('./upstream-request-utils');
const {
  rebuildCopilotWireApiFallback,
  carryForwardWireApiCompatibility,
} = require('./upstream-fallback');
const { carryForwardCodexCompatibility } = require('./codex-compat');
const { getRequestModel, rewriteRequestModel } = require('./model-fallback-chain');
const {
  buildCrossProviderRequest,
  getFallbackUpstreamEndpoint,
  TARGET_ENDPOINTS,
} = require('./cross-provider-fallback');

/**
 * Build retries without dispatching them until the recovery policy accepts
 * their compatibility assessment.
 */
function createProtocolTranslation({
  body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestSigner,
  hasRetried, modelNotSupportedRetryCount, targetScheme, codexCompatibility,
  wireApiCompatibility, wireApiSourceBody, wireApiEndpointRetryAttempted,
  protocolTranslation, requestHeaders, current, origin, chain, nextAttempts, nextOrigin,
}, { assessCandidate, sendUpstreamRequest, getProviderAdapter }) {
  // Same provider as the failed attempt: rewrite the model in place.
  const buildSameProviderAttempt = (candidate) => {
    const rewritten = rewriteRequestModel({ body, upstreamPath }, current.location, candidate.model);
    if (!rewritten) return null;
    const assessment = assessCandidate(candidate, provider === 'copilot' && wireApiSourceBody
      ? getFallbackUpstreamEndpoint(provider, candidate.model, req.url, !chain.includes(candidate.entry), req.awfRuntimePricing)
      : rewritten.upstreamPath);
    if (assessment.compatibility.status !== 'compatible') return { assessment };
    let wireFallback = null;
    if (provider === 'copilot' && wireApiSourceBody) {
      wireFallback = rebuildCopilotWireApiFallback(
        wireApiSourceBody, candidate.model, req, upstreamPath, !chain.includes(candidate.entry),
      );
    }
    const retryBody = wireFallback?.body || rewritten.body;
    const retryPath = wireFallback?.upstreamPath || rewritten.upstreamPath;
    return { assessment: assessCandidate(candidate, retryPath), dispatch: () => sendUpstreamRequest(
      retryBody === body ? requestHeaders : rebuildBodyFramingHeaders(requestHeaders, retryBody.length),
      {
        body: retryBody, targetHost, upstreamPath: retryPath,
        req, res, provider, requestId, startTime, span, requestBytes: retryBody.length, requestSigner,
        hasRetried,
        modelNotSupportedRetryCount,
        targetScheme,
        codexCompatibility: retryBody === body
          ? codexCompatibility
          : carryForwardCodexCompatibility(codexCompatibility),
        wireApiCompatibility: wireFallback
          ? wireFallback.wireApiCompatibility
          : carryForwardWireApiCompatibility(wireApiCompatibility),
        wireApiSourceBody: wireFallback?.wireApiSourceBody || wireApiSourceBody,
        wireApiEndpointRetryAttempted,
        attemptedModels: nextAttempts(candidate),
        fallbackOrigin: nextOrigin,
        protocolTranslation,
      },
    ) };
  };

  // Back to the receiving provider after a cross-provider attempt:
  // rebuild from the original upstream request.
  const buildOriginAttempt = (candidate) => {
    const located = getRequestModel(origin.body, origin.upstreamPath);
    const rewritten = located
      ? rewriteRequestModel({ body: origin.body, upstreamPath: origin.upstreamPath }, located.location, candidate.model)
      : null;
    if (!rewritten) return null;
    const assessment = assessCandidate(candidate, origin.provider === 'copilot' && origin.wireApiSourceBody
      ? getFallbackUpstreamEndpoint(origin.provider, candidate.model, req.url, !chain.includes(candidate.entry), req.awfRuntimePricing)
      : rewritten.upstreamPath, origin.targetHost, origin.targetScheme);
    if (assessment.compatibility.status !== 'compatible') return { assessment };
    let wireFallback = null;
    if (origin.provider === 'copilot' && origin.wireApiSourceBody) {
      wireFallback = rebuildCopilotWireApiFallback(
        origin.wireApiSourceBody, candidate.model, req, origin.upstreamPath, !chain.includes(candidate.entry),
      );
    }
    const retryBody = wireFallback?.body || rewritten.body;
    const retryPath = wireFallback?.upstreamPath || rewritten.upstreamPath;
    return { assessment: assessCandidate(candidate, retryPath, origin.targetHost, origin.targetScheme),
      dispatch: () => sendUpstreamRequest(rebuildBodyFramingHeaders(origin.requestHeaders, retryBody.length), {
      body: retryBody, targetHost: origin.targetHost,
      upstreamPath: retryPath,
      req, res, provider: origin.provider, requestId, startTime, span, requestBytes: retryBody.length,
      requestSigner: origin.requestSigner,
      hasRetried: false,
      modelNotSupportedRetryCount: 0,
      targetScheme: origin.targetScheme,
      codexCompatibility: carryForwardCodexCompatibility(origin.codexCompatibility),
      wireApiCompatibility: wireFallback
        ? wireFallback.wireApiCompatibility
        : carryForwardWireApiCompatibility(origin.wireApiCompatibility),
      wireApiSourceBody: wireFallback?.wireApiSourceBody || origin.wireApiSourceBody,
      wireApiEndpointRetryAttempted: origin.wireApiEndpointRetryAttempted,
      attemptedModels: nextAttempts(candidate),
      fallbackOrigin: nextOrigin,
      protocolTranslation: null,
    }) };
  };

  const buildCrossProviderAttempt = (candidate, assessCompatibility) => buildCrossProviderRequest({
    sourceBody: origin.sourceBody,
    protocol: origin.protocol,
    originProvider: origin.provider,
    targetProvider: candidate.provider,
    model: candidate.model,
    adapter: getProviderAdapter(candidate.provider),
    req,
    requestId,
    codexCompatibility: !!origin.codexCompatibility,
    assessCompatibility,
  });

  const dispatchCrossProviderAttempt = (built, candidate) => sendUpstreamRequest(built.headers, {
      body: built.body, targetHost: built.targetHost, upstreamPath: built.upstreamPath,
      req, res, provider: candidate.provider, requestId, startTime, span,
      requestBytes: built.body.length, requestSigner: built.requestSigner,
      hasRetried: false,
      modelNotSupportedRetryCount: 0,
      targetScheme: built.targetScheme,
      codexCompatibility: carryForwardCodexCompatibility(origin.codexCompatibility),
      wireApiCompatibility: built.wireApiCompatibility,
      wireApiSourceBody: built.wireApiSourceBody,
      wireApiEndpointRetryAttempted,
      attemptedModels: nextAttempts(candidate),
      fallbackOrigin: nextOrigin,
      protocolTranslation: built.protocolTranslation,
  });

  return { buildSameProviderAttempt, buildOriginAttempt, buildCrossProviderAttempt, dispatchCrossProviderAttempt };
}

function assessCrossProviderFailure(candidate, err, assessment, { origin, req, getProviderAdapter, assessCandidate }) {
  if (!assessment) {
    const adapter = getProviderAdapter(candidate.provider);
    try {
      assessment = assessCandidate(candidate,
        err?.code === 'unsupported_protocol_feature' || err?.code === 'unsupported_wire_api_feature'
          ? TARGET_ENDPOINTS[candidate.provider]?.[origin.protocol] || null : null,
        adapter?.getTargetHost?.(req), adapter?.getTargetScheme?.(req) || 'https');
    } catch {
      assessment = assessCandidate(candidate, null);
    }
  }
  if (assessment.compatibility.status === 'compatible') {
    assessment = { ...assessment, compatibility: {
      ...assessment.compatibility,
      status: 'unverified',
      features: [...new Set([...assessment.compatibility.features, 'unknown_fields'])],
      reasons: [...assessment.compatibility.reasons,
        { feature: 'unknown_fields', code: 'request_build_failed' }],
    } };
  }
  return assessment;
}

module.exports = { createProtocolTranslation, assessCrossProviderFailure };
