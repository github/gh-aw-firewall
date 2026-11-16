'use strict';

const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

const failures = new WeakMap();
function check(id, condition) {
  if (condition) return;
  const error = new Error(id);
  failures.set(error, id);
  throw error;
}
function equal(id, actual, expected) {
  check(id, isDeepStrictEqual(actual, expected));
}
function failureId(error) {
  return failures.get(error) || null;
}

function grade(state, report, exitCode) {
  equal('agent_exit', exitCode, 0);
  equal('evidence_version', state.version, 1);
  equal('fixture_complete', state.complete, true);
  check('scenario', ['recover', 'deny'].includes(state.scenario));
  const events = state.events;
  check('request_count', Array.isArray(events) && events.length >= 2 && events.length <= 5);
  events.forEach((event, index) => {
    equal('request_sequence', event.sequence, index);
    check('request_status', Number.isInteger(event.status));
    equal('response_finished', event.finished, true);
    check('request_json', !event.malformed && !event.nonJson);
    check('endpoint_method', (event.method === 'GET' && event.path === '/reflect') ||
      (event.method === 'POST' && event.path === '/responses'));
  });
  const attempts = events.filter(event => event.method === 'POST');
  const first = attempts[0];
  check('initial_before_reflect', events[0] === first);
  equal('initial_request_exact', first.body, {
    model: state.model, reasoning: { effort: 'max' }, input: state.nonce, stream: false,
  });
  const denied = state.scenario === 'deny';
  const reason = denied ? 'policy_denied' : 'unsupported_reasoning_effort';
  equal('initial_rejection_status', first.status, denied ? 403 : 400);
  equal('initial_rejection_reason', first.error, denied ? 'model_policy_violation' : reason);
  const reflection = events.find(event => event.method === 'GET' && event.sequence > first.sequence);
  check('reflect_get_success', reflection && reflection.status === 200);
  equal('reflect_schema', reflection.reflection?.schema, 'awf-model-decision-diagnostics/v1');
  const decisions = reflection.reflection.recent?.decisions;
  check('reflect_rejection', Array.isArray(decisions) && decisions.some(decision =>
    decision?.reason === reason && decision.status === 'rejected' &&
    decision.action?.retry === 'do_not_repeat'));
  if (denied) {
    equal('denial_attempt_count', attempts.length, 1);
    equal('denial_upstream_empty', state.upstream, []);
    equal('denial_report', report, { status: 'blocked', reason: 'model_policy_violation', retry: false });
  } else {
    equal('recovery_attempt_count', attempts.length, 2);
    const corrected = attempts[1];
    check('correction_after_reflect', corrected.sequence > reflection.sequence);
    equal('correction_status', corrected.status, 200);
    equal('corrected_request_exact', corrected.body, {
      model: state.model, reasoning: { effort: state.effort }, input: state.nonce, stream: false,
    });
    equal('recovery_upstream_exact', state.upstream.map(({ method, path, body }) => ({ method, path, body })), [{
      method: 'POST', path: '/responses', body: corrected.body,
    }]);
    equal('recovery_report', report, { status: 'completed', result: state.result });
  }
  return { scenario: state.scenario, status: 'pass', requests: events.length, attempts: attempts.length,
    reflectRead: true, upstreamRequests: state.upstream.length, taskOutcome: denied ? 'blocked' : 'completed',
    resultVerified: !denied };
}

if (require.main === module) {
  try {
    const [evidence, report, status] = process.argv.slice(2);
    console.log(JSON.stringify(grade(JSON.parse(fs.readFileSync(evidence)),
      JSON.parse(fs.readFileSync(report)), Number(status))));
  } catch (error) {
    console.error(`Reflect smoke failed: ${failureId(error) || 'unclassified_contract_failure'}`);
    process.exitCode = 1;
  }
}
module.exports = { grade, failureId };
