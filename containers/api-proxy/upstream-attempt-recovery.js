'use strict';

const { buildFallbackOrigin } = require('./fallback-origin');
const { selectFallbackCandidate, buildFallbackCandidates } = require('./fallback-candidate-selection');
const { createFallbackAssessment, createFallbackDecisionObserver } = require('./upstream-fallback');
const { isModelEligible } = require('./model-eligibility');
const {
  attemptKey, getRequestModel, toAttempt,
} = require('./model-fallback-chain');
const { sanitizeForLog } = require('./logging');
const {
  isAutomaticRecoveryEnabled, recoveryRecords, protocolForUrl,
} = require('./model-recovery');
const { createProtocolTranslation, assessCrossProviderFailure } = require('./upstream-protocol-translation');

function createAttemptRecovery({
  body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestSigner,
  hasRetried, modelNotSupportedRetryCount, targetScheme, codexCompatibility,
  wireApiCompatibility, wireApiSourceBody, wireApiEndpointRetryAttempted,
  attemptedModels, fallbackOrigin, protocolTranslation, requestHeaders, cancellation,
}, {
  getBody, getRequestHeaders, getFallbackModels, getProviderAdapter, isFallbackModelPermitted,
  sendUpstreamRequest, failBrokerAuth, metrics, otel, logRequest,
}) {
  const isPermitted = (model, route) =>
    isModelEligible(model, route, req, { inputMode: 'native' }) &&
    (!isFallbackModelPermitted || isFallbackModelPermitted(model, route, req));
  const isRoutingClassifier = req.awfRequestContext?.purpose === 'routing_classification';

  const origin = buildFallbackOrigin({
    body, targetHost, upstreamPath, req, provider, requestSigner, targetScheme,
    codexCompatibility, wireApiCompatibility, wireApiSourceBody,
    wireApiEndpointRetryAttempted, requestHeaders, fallbackOrigin,
  });
  const assessCandidate = createFallbackAssessment({ origin, req, targetHost, targetScheme });
  const observeDecision = createFallbackDecisionObserver({ req, origin });

  // Evaluate candidates only after an eligible failure so skipped-entry
  // evidence is retained even when no candidate is usable.
  let onModelFallback = null;
  if (!isRoutingClassifier && !req.awfScopedAuto && !req.awfTrustedService) {
    const chain = getFallbackModels();
    const automaticRecovery = isAutomaticRecoveryEnabled(provider, req) &&
      protocolForUrl(req.url) &&
      recoveryRecords(provider, req).length > 0;
    const current = chain.length > 0 || automaticRecovery ? getRequestModel(body, upstreamPath) : null;
    if (current) {
      const attempted = Array.isArray(attemptedModels) && attemptedModels.length > 0
        ? attemptedModels.map(a => toAttempt(a, provider))
        : req.awfRecoveryAttempts || [{ provider, model: current.model }];
      let fallbackTriggered = false;
      onModelFallback = ({ statusCode = null, reason = 'upstream_error', abandon = null } = {}) => {
        if (cancellation.cancelled || fallbackTriggered || res.headersSent) return false;
        fallbackTriggered = true;
        const failure = {
          provider,
          model: current.model,
          reason,
          ...(statusCode !== null ? { status: statusCode } : {}),
        };
        const failures = [...origin.failures, failure];
        const candidates = buildFallbackCandidates({
          chain, automaticRecovery, reason, req, attempted, provider, origin, isPermitted,
        });
        const exclude = new Set();
        let lastDecision = null;
        let exhausted = false;
        const recordExhaustion = () => {
          if (exhausted || !lastDecision) return;
          exhausted = true;
          observeDecision(lastDecision.candidate, 'exhausted', lastDecision.assessment);
        };
        const logSkip = (candidate, skipReason, assessment = null) => {
          exclude.add(attemptKey(candidate.provider, candidate.model));
          const observedCandidate = skipReason === 'guard_rejected'
            ? { provider: candidate.provider, model: null } : candidate;
          assessment ||= assessCandidate(observedCandidate, null);
          lastDecision = { candidate: observedCandidate, assessment };
          observeDecision(observedCandidate, 'skipped', assessment);
          logRequest?.('warn', 'model_fallback_skipped', {
            request_id: requestId,
            provider: origin.provider,
            entry: candidate.entry,
            candidate_provider: candidate.provider,
            candidate_model: candidate.model,
            reason: skipReason,
            message: `Fallback entry "${candidate.entry}" skipped: ${skipReason}`,
          });
        };

        const recordFallback = (candidate) => {
          const requested = attempted[0];
          const attempt = attempted.length;
          if (!chain.includes(candidate.entry)) {
            req.awfAutomaticRecoveryCount = (req.awfAutomaticRecoveryCount ||
              (req.awfRecoveryAttempts ? 1 : 0)) + 1;
          }
          req.awfModelFallback = {
            requested_model: sanitizeForLog(req.awfRequestedModelSelector || requested.model),
            requested_provider: requested.provider,
            model: candidate.model,
            provider: candidate.provider,
            attempt,
            reason,
            ...(statusCode !== null ? { status: statusCode } : {}),
            from_model: current.model,
            from_provider: provider,
            failures,
          };
          req.awfRouting?.onModelFallback?.(req.awfModelFallback);
          if (typeof logRequest === 'function') {
            logRequest('warn', 'model_fallback', {
              request_id: requestId,
              provider,
              from_model: sanitizeForLog(current.model),
              to_model: sanitizeForLog(candidate.model),
              from_provider: provider,
              to_provider: candidate.provider,
              requested_model: sanitizeForLog(req.awfRequestedModelSelector || requested.model),
              requested_provider: requested.provider,
              attempt,
              reason,
              ...(statusCode !== null ? { status: statusCode } : {}),
              message: `Upstream ${statusCode !== null ? `returned ${statusCode}` : 'request failed'} for model "${current.model}"` +
                `${candidate.provider !== provider ? ` on ${provider}` : ''}; falling back to "${candidate.model}"` +
                `${candidate.provider !== provider ? ` on ${candidate.provider}` : ''}`,
            });
          }
          if (candidate.provider !== provider) {
            // Active-request accounting follows the serving provider.
            metrics.gaugeDec('active_requests', { provider });
            metrics.gaugeInc('active_requests', { provider: candidate.provider });
          }
        };
        const nextAttempts = (candidate) => [...attempted, { provider: candidate.provider, model: candidate.model }];
        const nextOrigin = { ...origin, failures };
        let cancellationFinalized = false;
        const finalizeCancellation = () => {
          if (cancellationFinalized || cancellation.finalized) return;
          cancellationFinalized = true;
          cancellation.cancel();
          if (cancellation.responseStarted) otel.endSpan(span, 0);
        };
        // Same-provider retries must read the live, budget-rewritten body and
        // headers, while origin retains the pre-budget request above.
        const {
          buildSameProviderAttempt, buildOriginAttempt, buildCrossProviderAttempt, dispatchCrossProviderAttempt,
        } = createProtocolTranslation({
          body: getBody(), requestHeaders: getRequestHeaders(),
          targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestSigner,
          hasRetried, modelNotSupportedRetryCount, targetScheme, codexCompatibility,
          wireApiCompatibility, wireApiSourceBody, wireApiEndpointRetryAttempted,
          protocolTranslation, current, origin, chain, nextAttempts, nextOrigin,
        }, { assessCandidate, sendUpstreamRequest, getProviderAdapter });

        const giveUp = () => {
          recordExhaustion();
          if (!(automaticRecovery && reason === 'model_not_supported') && typeof abandon === 'function') {
            abandon();
            return;
          }
          if (res.headersSent) return;
          const duration = Date.now() - startTime;
          metrics.gaugeDec('active_requests', { provider });
          metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
          logRequest?.('error', 'model_fallback_exhausted', {
            request_id: requestId, provider, status: 502, duration_ms: duration,
          });
          otel.endSpan(span, 502);
          if (req.awfRouting) {
            req.awfRouting.localError = { code: 'model_fallback_exhausted', type: 'model_fallback_exhausted' };
          }
          res.writeHead(502, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
          res.end(JSON.stringify({
            error: {
              message: 'Upstream request failed and no fallback model could be dispatched',
              type: 'model_fallback_exhausted',
              code: 'model_fallback_exhausted',
            },
          }));
        };

        const tryCandidates = () => {
          for (;;) {
            if (cancellation.cancelled) return false;
            const candidate = selectFallbackCandidate(candidates, {
              origin, provider, attempted, isPermitted, getProviderAdapter, exclude, onSkip: logSkip,
            });
            if (!candidate) return false;
            const key = attemptKey(candidate.provider, candidate.model);
            if (candidate.provider === provider || candidate.provider === origin.provider) {
              let built = null;
              try {
                built = candidate.provider === provider
                  ? buildSameProviderAttempt(candidate)
                  : buildOriginAttempt(candidate);
              } catch {
                built = null;
              }
              if (!built) {
                exclude.add(key);
                logSkip(candidate, 'request_rewrite_failed');
                continue;
              }
              if (built.assessment.compatibility.status !== 'compatible') {
                logSkip(candidate, `fallback_${built.assessment.compatibility.status}`, built.assessment);
                continue;
              }
              observeDecision(candidate, 'accepted', built.assessment);
              recordFallback(candidate);
              built.dispatch();
              return true;
            }

            // Asynchronous target transforms finish before accepting a
            // cross-provider candidate; failed builds continue in chain order.
            let crossAssessment = null;
            buildCrossProviderAttempt(candidate, ({ upstreamPath: path, targetHost: host, targetScheme: scheme }) => {
              crossAssessment = assessCandidate(candidate, path, host, scheme);
              return crossAssessment.compatibility;
            }).then((built) => {
              if (cancellation.cancelled || res.headersSent || res.destroyed || res.writableEnded) {
                finalizeCancellation();
                return;
              }
              if (built.substitutedModel) {
                logRequest?.('warn', 'model_fallback_substitution_blocked', {
                  request_id: requestId,
                  provider: candidate.provider,
                  model: candidate.model,
                  substituted_model: built.substitutedModel,
                  message: `Provider body transform tried to substitute "${built.substitutedModel}"; kept configured fallback "${candidate.model}"`,
                });
              }
              observeDecision(candidate, 'accepted', crossAssessment);
              recordFallback(candidate);
              dispatchCrossProviderAttempt(built, candidate);
            }, (err) => {
              if (cancellation.cancelled) {
                finalizeCancellation();
                return;
              }
              if (err?.code === 'token_broker_unavailable') {
                failBrokerAuth({ res, req, provider, span });
                return;
              }
              crossAssessment = assessCrossProviderFailure(candidate, err, crossAssessment, {
                origin, req, getProviderAdapter, assessCandidate,
              });
              logSkip(candidate, crossAssessment.compatibility.status !== 'compatible'
                ? `fallback_${crossAssessment.compatibility.status}` : 'request_build_failed', crossAssessment);
              if (res.headersSent || res.destroyed || res.writableEnded) {
                finalizeCancellation();
                return;
              }
              if (!tryCandidates()) giveUp();
            });
            return true;
          }
        };

        if (tryCandidates()) return true;
        if (automaticRecovery && reason === 'model_not_supported') {
          giveUp();
          return true;
        }
        recordExhaustion();
        return false;
      };
    }
  }
  return { origin, assessCandidate, observeDecision, isPermitted, onModelFallback };
}

module.exports = { createAttemptRecovery };
