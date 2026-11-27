'use strict';

const { getModelReasoning } = require('./model-reasoning');
const { extractClassifierOutput, preflightClassifierRequest } = require('./routing-classifier');
const { validateClassifierOutput } = require('./routing-contract');
const { createRoutingError, RoutingError } = require('./routing-errors');
const { recordClassifierAttempt } = require('./routing-observation-records');
const { runBoundedOperation } = require('./routing-planner');

const ROUTER_PHASE_RESERVE_MS = 5_000;
const CLASSIFIER_ATTEMPT_TIMEOUT_MS = 30_000;
const CLASSIFIER_MAX_ATTEMPTS = 2;
const PURPOSE = 'routing_classification';

function computeRouterDeadline(now, deadline) {
  const remaining = Math.max(0, deadline - now);
  if (remaining <= 1) return deadline;
  const reserve = Math.min(ROUTER_PHASE_RESERVE_MS, Math.max(1, Math.floor(remaining / 4)));
  return Math.max(now + 1, deadline - reserve);
}

function isClassifierAvailabilityFailure(result) {
  return result?.availabilityFailure === true ||
    (Number.isInteger(result?.statusCode) && result.statusCode >= 500);
}

function classifierTimeoutError() {
  const error = new Error('Classifier request timed out');
  error.code = 'ETIMEDOUT';
  return error;
}

async function runClassifierAttempts({
  classifierPlan, pool, executor, observer, eligibilityRequest,
  signal, deadline, clock, attemptTimeoutMs, maxAttempts, purpose, onAttempt,
}) {
  let classification = null;
  let successfulClassifier = null;
  let degradedReason = null;
  let actualAttempts = 0;
  let capacityExclusions = 0;
  for (const choice of classifierPlan.ranked_choices) {
    if (actualAttempts >= maxAttempts) break;
    const mapping = pool.byId[choice.id];
    if (!Number.isInteger(mapping.contextWindow) || mapping.contextWindow <= 0) {
      capacityExclusions++;
      continue;
    }
    const preflight = preflightClassifierRequest(mapping, classifierPlan);
    if (!preflight.eligible) {
      capacityExclusions++;
      continue;
    }

    actualAttempts++;
    onAttempt?.(actualAttempts);
    recordClassifierAttempt(observer, { purpose, attempt: actualAttempts, mapping });
    let result;
    try {
      result = await runBoundedOperation(
        ({ signal: phaseSignal, timeoutMs }) => executor.execute({
          path: preflight.request.path,
          body: preflight.request.body,
          purpose,
          provider: mapping.provider,
          awfEligibility: eligibilityRequest.awfEligibility,
          awfEligibilityScope: eligibilityRequest.awfEligibilityScope,
          awfReasoning: getModelReasoning(mapping, mapping.provider),
        }, { signal: phaseSignal, timeoutMs }),
        {
          signal, deadline, clock, timeoutMs: attemptTimeoutMs, timeoutError: classifierTimeoutError,
        },
      );
    } catch (error) {
      if (error instanceof RoutingError) throw error;
      if (error?.code === 'ETIMEDOUT') continue;
      throw createRoutingError('provider_unavailable', 'Classifier execution was rejected by the provider path');
    }

    if (result?.terminal) {
      throw createRoutingError(
        result.terminal.code,
        result.terminal.detail || 'Classifier execution was rejected by a native guard',
      );
    }
    if (isClassifierAvailabilityFailure(result)) continue;
    if (!Number.isInteger(result?.statusCode) || result.statusCode < 200 || result.statusCode >= 300) {
      throw createRoutingError('provider_unavailable', 'Classifier execution failed in the provider path');
    }

    const rawOutput = extractClassifierOutput(mapping.protocol, result.body);
    classification = rawOutput === null ? null : validateClassifierOutput(rawOutput);
    if (classification !== null) {
      successfulClassifier = { model: mapping.choice.model, effort: mapping.effort ?? null };
    }
    if (classification === null) degradedReason = 'invalid_classifier_output';
    break;
  }

  if (classification === null && degradedReason === null) {
    degradedReason = actualAttempts === 0 && capacityExclusions > 0
      ? 'classifier_capacity_exhausted'
      : 'classifier_attempts_exhausted';
  }
  return { classification, successfulClassifier, degradedReason, actualAttempts };
}

module.exports = {
  CLASSIFIER_ATTEMPT_TIMEOUT_MS,
  CLASSIFIER_MAX_ATTEMPTS,
  PURPOSE,
  ROUTER_PHASE_RESERVE_MS,
  computeRouterDeadline,
  runClassifierAttempts,
};
