'use strict';

const { getModelReasoning } = require('./model-reasoning');
const { extractClassifierOutput, preflightClassifierRequest } = require('./routing-classifier');
const { assertPlanningRequestSize, validateClassifierOutput, validateClassifyResponse } = require('./routing-contract');
const { createRoutingError, RoutingError } = require('./routing-errors');
const { recordClassifierAttempt } = require('./routing-observation-records');
const { runBoundedOperation } = require('./routing-planner');
const { deepFreezeJson, mapPlannerFailure } = require('./routing-stages');

function isClassifierAvailabilityFailure(result) {
  return result?.availabilityFailure === true ||
    (Number.isInteger(result?.statusCode) && result.statusCode >= 500);
}

function sanitizeConversationString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/(\bBearer\s+)[^\s,;'"{}\[\]<>]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:api[_-]?key|password|token|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;'"{}\[\]<>]+)/gi, '$1[REDACTED]')
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?![A-Za-z0-9_-])/g, '[REDACTED_TOKEN]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[REDACTED_TOKEN]');
}

function sanitizeConversationPayload(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeConversationString(value);
  if (Array.isArray(value)) return value.map(sanitizeConversationPayload);
  if (typeof value === 'object') {
    const sanitized = {};
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = typeof item === 'string' &&
        /^(?:api[_-]?key|password|token|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token)$/i.test(key)
        ? '[REDACTED]' : sanitizeConversationPayload(item);
    }
    return sanitized;
  }
  return value;
}

function classifierTimeoutError() {
  const error = new Error('Classifier request timed out');
  error.code = 'ETIMEDOUT';
  return error;
}

async function classifyRouting({
  conversation, pool, planner, executor, observer, eligibilityRequest,
  callPlanner, signal, deadline, clock, attemptTimeoutMs, maxAttempts, purpose, onAttempt,
}) {
  const sanitizedConversation = sanitizeConversationPayload(conversation);
  const classifyRequest = deepFreezeJson({ conversation: sanitizedConversation, models: pool.choices });
  assertPlanningRequestSize(classifyRequest);

  let classification = null;
  let successfulClassifier = null;
  let degradedReason = null;
  let classifierPlan;
  try {
    const rawPlan = await callPlanner(({ signal: phaseSignal, timeoutMs }) =>
      planner.classify(classifyRequest, { signal: phaseSignal, timeoutMs }));
    classifierPlan = validateClassifyResponse(rawPlan, pool.choices);
  } catch (error) {
    mapPlannerFailure(error, 'classify');
  }

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

module.exports = { classifyRouting };
