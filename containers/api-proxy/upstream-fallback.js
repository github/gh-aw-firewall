'use strict';

const { parseBodyAsObject } = require('./body-utils');
const {
  getFallbackUpstreamEndpoint,
  protocolForPath,
  getRequiredResponseFeatures,
} = require('./cross-provider-fallback');
const {
  attemptKey,
  getRequestModel,
  selectNextFallbackModel,
  rewriteRequestModel,
  toAttempt,
} = require('./model-fallback-chain');
const { rebuildBodyFramingHeaders } = require('./upstream-request-utils');
const { carryForwardCodexCompatibility } = require('./codex-compat');
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

function createFallbackRetryHandlers({
  body,
  targetHost,
  upstreamPath,
  req,
  res,
  provider,
  requestId,
  startTime,
  span,
  requestBytes,
  requestSigner,
  hasRetried,
  modelNotSupportedRetryCount,
  targetScheme,
  codexCompatibility,
  wireApiCompatibility,
  wireApiSourceBody,
  wireApiEndpointRetryAttempted,
  attemptedModels,
  origin,
  protocolTranslation,
  requestHeaders,
  cancellation,
  assessCandidate,
  observeDecision,
  sendUpstreamRequest,
  isPermitted,
  onModelFallback,
  logRequest,
}) {
  const onWireApiEndpointRetry = () => {
    if (cancellation.cancelled) return false;
    if (provider !== 'copilot' || !wireApiSourceBody || wireApiEndpointRetryAttempted) return false;
    const requestedEndpoint = endpointForPath(req.url);
    const rejectedEndpoint = endpointForPath(upstreamPath);
    if (!requestedEndpoint || !rejectedEndpoint) return false;
    const alternateEndpoint = rejectedEndpoint === '/responses' ? '/chat/completions' : '/responses';
    const candidate = { provider, model: getRequestModel(body, upstreamPath)?.model };
    if (!candidate.model) return false;
    const assessment = assessCandidate(candidate, alternateEndpoint);
    if (assessment.compatibility.status !== 'compatible') {
      observeDecision(candidate, 'skipped', assessment);
      if (!onModelFallback && !(req.awfModelCandidates?.length > 1)) {
        observeDecision(candidate, 'exhausted', assessment);
      }
      throw new Error('Fallback request compatibility was not established');
    }
    let retryBody = wireApiSourceBody;
    let retryCompatibility = {
      requestedEndpoint,
      upstreamEndpoint: requestedEndpoint,
      passthrough: true,
    };
    if (alternateEndpoint !== requestedEndpoint) {
      const translated = translateCopilotWireApi(wireApiSourceBody, req.url, {
        upstreamEndpoint: alternateEndpoint,
      });
      if (!translated) return false;
      retryBody = translated.body;
      retryCompatibility = translated.compatibility;
    }
    req.awfRouting?.onEndpointTranslation?.(retryCompatibility);
    logRequest?.('warn', 'wire_api_endpoint_retry', {
      request_id: requestId,
      provider,
      rejected_endpoint: rejectedEndpoint,
      upstream_endpoint: alternateEndpoint,
      message: 'Copilot rejected the endpoint; retrying the same model on the other wire API',
    });
    const retryHeaders = rebuildBodyFramingHeaders(requestHeaders, retryBody.length);
    retryHeaders['accept-encoding'] = 'identity';
    observeDecision(candidate, 'accepted', assessment);
    sendUpstreamRequest(retryHeaders, {
      body: retryBody, targetHost,
      upstreamPath: replaceUpstreamEndpoint(upstreamPath, alternateEndpoint),
      req, res, provider, requestId, startTime, span,
      requestBytes: retryBody.length, requestSigner,
      hasRetried, modelNotSupportedRetryCount, targetScheme,
      codexCompatibility, wireApiCompatibility: retryCompatibility,
      wireApiSourceBody, wireApiEndpointRetryAttempted: true, attemptedModels,
      fallbackOrigin: { ...origin, wireApiEndpointRetryAttempted: true },
      protocolTranslation,
    });
    return true;
  };

  const onModelEndpointBlockedRetry = provider !== origin.provider ? null : () => {
    if (cancellation.cancelled) return false;
    const candidates = req.awfModelCandidates;
    if (!Array.isArray(candidates) || candidates.length < 2) return false;

    const parsed = parseBodyAsObject(body);
    const currentModel = parsed && parsed.model;
    if (!currentModel) return false;

    const currentIdx = candidates.indexOf(currentModel);
    if (currentIdx < 0 || currentIdx >= candidates.length - 1) return false;

    const exclude = [currentModel];
    let lastDecision = null;
    const skipped = new Set();
    const permitCandidate = (model, route) => {
      let permitted = false;
      try { permitted = isPermitted(model, route); } catch { /* fail closed */ }
      const key = attemptKey(route, model);
      if (!permitted && !skipped.has(key)) {
        skipped.add(key);
        exclude.push(model);
        const candidate = { provider: route, model: null };
        lastDecision = { candidate, assessment: assessCandidate(candidate, null) };
        observeDecision(candidate, 'skipped', lastDecision.assessment);
      }
      return permitted;
    };
    for (;;) {
      const nextModel = selectNextFallbackModel(candidates.slice(currentIdx + 1), exclude, provider, permitCandidate);
      if (!nextModel) {
        if (lastDecision && !onModelFallback) observeDecision(lastDecision.candidate, 'exhausted', lastDecision.assessment);
        return false;
      }
      exclude.push(nextModel);
      const candidate = { provider, model: nextModel };
      let assessment;
      try {
        assessment = assessCandidate(candidate, provider === 'copilot' && wireApiSourceBody
          ? getFallbackUpstreamEndpoint(provider, nextModel, req.url, false, req.awfRuntimePricing) : upstreamPath);
      } catch {
        assessment = assessCandidate(candidate, null);
      }
      lastDecision = { candidate, assessment };
      if (assessment.compatibility.status !== 'compatible') {
        observeDecision(candidate, 'skipped', assessment);
        continue;
      }
      let wireFallback = null;
      if (provider === 'copilot' && wireApiSourceBody) {
        try {
          wireFallback = rebuildCopilotWireApiFallback(wireApiSourceBody, nextModel, req, upstreamPath);
        } catch {
          lastDecision = { candidate, assessment: assessCandidate(candidate, null) };
          observeDecision(candidate, 'skipped', lastDecision.assessment);
          continue;
        }
      }

      const newParsed = parseBodyAsObject(body);
      if (!newParsed) return false;
      newParsed.model = nextModel;
      const newBody = wireFallback?.body || Buffer.from(JSON.stringify(newParsed), 'utf8');
      const retryPath = wireFallback?.upstreamPath || upstreamPath;
      const retryHeaders = rebuildBodyFramingHeaders(requestHeaders, newBody.length);
      const actualAssessment = assessCandidate(candidate, retryPath);
      if (actualAssessment.compatibility.status !== 'compatible') {
        lastDecision = { candidate, assessment: actualAssessment };
        observeDecision(candidate, 'skipped', actualAssessment);
        continue;
      }
      observeDecision(candidate, 'accepted', actualAssessment);
      req.awfRouting?.onModelFallback?.({
        requested_model: req.awfRequestedModelSelector || currentModel,
        model: nextModel,
        provider,
        from_model: currentModel,
        reason: 'model_endpoint_incompatible',
      });
      sendUpstreamRequest(retryHeaders, {
        body: newBody, targetHost, upstreamPath: retryPath, req, res, provider, requestId, startTime, span,
        requestBytes: newBody.length, requestSigner,
        hasRetried,
        modelNotSupportedRetryCount,
        targetScheme,
        codexCompatibility: carryForwardCodexCompatibility(codexCompatibility),
        wireApiCompatibility: wireFallback
          ? wireFallback.wireApiCompatibility
          : carryForwardWireApiCompatibility(wireApiCompatibility),
        wireApiSourceBody: wireFallback?.wireApiSourceBody || wireApiSourceBody,
        wireApiEndpointRetryAttempted,
        attemptedModels: [
          ...(Array.isArray(attemptedModels) && attemptedModels.length > 0
            ? attemptedModels.map(a => toAttempt(a, provider))
            : [{ provider, model: currentModel }]),
          { provider, model: nextModel },
        ],
        fallbackOrigin: origin,
        protocolTranslation,
      });
      return true;
    }
  };

  return { onWireApiEndpointRetry, onModelEndpointBlockedRetry };
}

module.exports = {
  createFallbackAssessment,
  createFallbackDecisionObserver,
  createFallbackRetryHandlers,
  rebuildCopilotWireApiFallback,
  carryForwardWireApiCompatibility,
  endpointForPath,
  replaceUpstreamEndpoint,
  translateCopilotWireApi,
};
