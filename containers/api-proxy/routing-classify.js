'use strict';

const { runClassifierAttempts } = require('./routing-classifier-attempts');
const { assertPlanningRequestSize, validateClassifyResponse } = require('./routing-contract');
const { deepFreezeJson, mapPlannerFailure } = require('./routing-stages');

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

async function classifyRouting({
  conversation, pool, planner, executor, observer, eligibilityRequest,
  callPlanner, signal, deadline, clock, attemptTimeoutMs, maxAttempts, purpose, onAttempt,
}) {
  const sanitizedConversation = sanitizeConversationPayload(conversation);
  const classifyRequest = deepFreezeJson({ conversation: sanitizedConversation, models: pool.choices });
  assertPlanningRequestSize(classifyRequest);

  let classifierPlan;
  try {
    const rawPlan = await callPlanner(({ signal: phaseSignal, timeoutMs }) =>
      planner.classify(classifyRequest, { signal: phaseSignal, timeoutMs }));
    classifierPlan = validateClassifyResponse(rawPlan, pool.choices);
  } catch (error) {
    mapPlannerFailure(error, 'classify');
  }

  return runClassifierAttempts({
    classifierPlan, pool, executor, observer, eligibilityRequest,
    signal, deadline, clock, attemptTimeoutMs, maxAttempts, purpose, onAttempt,
  });
}

module.exports = { classifyRouting };
