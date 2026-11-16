'use strict';

const { isDeepStrictEqual } = require('node:util');

const MAX_EVENTS = 13;
const errorReasons = ['unsupported_reasoning_effort', 'model_policy_violation',
  'fixture_task_mismatch', 'fixture_request_limit'];
const decisionReasons = ['unsupported_reasoning_effort', 'policy_denied'];

function boundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function requestShape(event, state) {
  const body = event.body;
  const expected = effort => ({
    model: state.model, reasoning: { effort }, input: state.nonce, stream: false,
  });
  return {
    methodMatches: event.method === 'POST',
    pathMatches: event.path === '/responses',
    modelMatches: typeof state.model === 'string' && body?.model === state.model,
    initialEffortMatches: body?.reasoning?.effort === 'max',
    supportedEffortMatches: ['low', 'high'].includes(state.effort) && body?.reasoning?.effort === state.effort,
    inputMatches: typeof state.nonce === 'string' && body?.input === state.nonce,
    streamMatches: body?.stream === false,
    exactInitialMatches: isDeepStrictEqual(body, expected('max')),
    exactCorrectedMatches: isDeepStrictEqual(body, expected(state.effort)),
  };
}

function trace(events, state) {
  if (!Array.isArray(events)) return [];
  return events.slice(0, MAX_EVENTS).map(event => {
    const decisions = event.reflection?.recent?.decisions;
    return {
      sequence: boundedInteger(event.sequence, 0, MAX_EVENTS - 1),
      method: ['GET', 'POST'].includes(event.method) ? event.method : 'unexpected',
      path: ['/responses', '/reflect'].includes(event.path) ? event.path : 'unexpected',
      status: boundedInteger(event.status, 100, 599),
      reason: errorReasons.includes(event.error) ? event.error : null,
      diagnosticReasons: decisionReasons.filter(reason =>
        Array.isArray(decisions) && decisions.some(item => item?.reason === reason)),
      ...(event.method === 'GET' && event.path === '/reflect' ? {} : { requestShape: requestShape(event, state) }),
    };
  });
}

module.exports = { trace, boundedInteger };
