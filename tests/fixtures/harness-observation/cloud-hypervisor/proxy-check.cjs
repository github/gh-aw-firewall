'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, process, Buffer */

// Runs via docker exec inside the real sidecar against its existing report mount.
// Only this test process gets test-owned requirements; the server catalogue is unchanged.
async function checkProxy(options) {
  const assert = require('node:assert/strict');
  const { readHarnessObservation } = require('/app/harness-observation');
  const { createProxyEligibilityStore, pinRequestEligibility } = require('/app/model-eligibility');
  const { createRoutingController } = require('/app/routing-controller');
  const { identity } = require('/app/catalogue-contract/identity');
  const scope = { provider: 'copilot', channel: 'copilot-api', deployment: 'fixture' };
  const model = identity('copilot', 'fixture-model');
  const input = { identity: model, scope, discovery: { status: 'available', authoritative: true } };
  const report = readHarnessObservation();
  assert.equal(report.status, options.status);
  assert.equal(report.environment, options.environment);
  assert.equal(report.reason, options.reason);
  const evidence = minimum => ({ models: [{
    identity: model, harnesses: [{
      scope, name: process.env.AWF_SELECTED_HARNESS, scheme: 'semver', minimum,
      reason: 'Cloud Hypervisor test-only floor', provenance: { authority: 'maintained' },
    }],
  }] });
  const pin = minimum => createProxyEligibilityStore(evidence(minimum)).pin();
  const matching = pin('0.0.1');
  const request = { awfEligibility: matching, awfEligibilityScope: scope };
  assert.equal(pinRequestEligibility(request), matching);
  const first = matching.evaluate(input);
  assert.equal(first.harness, report.status === 'observed' ? 'compatible' : 'unverified');
  assert.equal(first.admitted, report.status === 'observed');
  assert.equal(pin('99.0.0').evaluate(input).harness,
    report.status === 'observed' ? 'incompatible' : 'unverified');
  assert.equal(pin('99.0.0').evaluate(input).admitted, false);
  assert.deepEqual(matching.evaluate(input), first);
  const legacy = createProxyEligibilityStore().pin().evaluate(input);
  assert.equal(legacy.admitted, true);
  assert.equal(legacy.harness, 'unconstrained');
  assert(Object.isFrozen(matching));
  assert(Object.isFrozen(first));

  // A new consumer cannot reuse evidence bound to another run or harness.
  // The already pinned consumer must retain its original immutable decision.
  const saved = { ...process.env };
  for (const [key, value, reason] of [
    ['AWF_HARNESS_ENVIRONMENT', `${options.environment}:other`, 'observation_environment_mismatch'],
    ['AWF_SELECTED_HARNESS', 'other-harness', 'observation_harness_mismatch'],
    ['AWF_HARNESS_BINARY', '/other/copilot', 'observation_harness_mismatch'],
  ]) {
    process.env[key] = value;
    assert.equal(readHarnessObservation().reason, reason);
    assert.equal(pin('0.0.1').evaluate(input).admitted, false);
    assert.equal(pinRequestEligibility(request), matching);
    assert.deepEqual(matching.evaluate(input), first);
    process.env[key] = saved[key];
  }
  delete process.env.AWF_HARNESS_ENVIRONMENT;
  assert.equal(readHarnessObservation(), undefined);
  process.env.AWF_HARNESS_ENVIRONMENT = saved.AWF_HARNESS_ENVIRONMENT;
  let routingPin = false;
  if (report.status === 'observed') {
    const store = createProxyEligibilityStore(evidence('0.0.1'));
    const calls = [];
    let pins = 0;
    const controller = createRoutingController({
      config: {
        provider: 'copilot', objective: { goal: 'cost', mode: 'balanced' },
        task: { conversationFile: '/fixture-conversation-not-read' },
      },
      eligibilityStore: { pin() { pins++; return store.pin(); } },
      eligibilityScope: scope,
      catalogue: { async getSnapshot() {
        // The routing run already pinned the real published report. Later
        // consumers see the changed binding; classifier and final preflight
        // must continue to use that first immutable pin.
        process.env.AWF_HARNESS_ENVIRONMENT = `${saved.AWF_HARNESS_ENVIRONMENT}:later`;
        assert.equal(store.pin().evaluate(input).harness, 'unverified');
        return {
          provider: 'copilot', configured: true, discovery: 'complete',
          models: [{ id: 'fixture-model', efforts: ['low'], protocols: ['responses'], contextWindow: 128000 }],
        };
      } },
      loadConversation: async () => [{ role: 'user', parts: [{ text: 'fixture task' }] }],
      planner: {
        health: async () => 204,
        capabilities: async () => ({
          name: 'gh-aw-router', version: '1.0.0',
          routing_profiles: [{ goal: 'cost', mode: 'balanced' }],
          execution_catalogue: { models: [] },
        }),
        classify: async request => ({
          system_prompt: 'fixture classification', prompt: 'fixture task', ranked_choices: request.models,
        }),
        route: async request => ({ ranked_choices: request.models.map(({ id, model, effort }) => ({ id, model, effort })) }),
      },
      executor: {
        async execute(request) {
          calls.push(request.awfEligibility);
          assert.equal(request.awfEligibility.evaluate(input).harness, 'compatible');
          return {
            statusCode: 200,
            body: Buffer.from(JSON.stringify({ output_text: JSON.stringify({
              labels: { task_type: 'implement', scope: 'local', task_complexity: 'easy' }, mode: 'balanced',
            }) })),
          };
        },
        async checkBeforePrimary(request) { calls.push(request.awfEligibility); },
      },
      observer: { record() {} },
    });
    try {
      assert.equal((await controller.run()).ok, true);
      assert.equal(pins, 1);
      assert.equal(calls.length, 2);
      assert.equal(calls[0], calls[1]);
      assert.equal(calls[1].evaluate(input).harness, 'compatible');
      routingPin = true;
    } finally {
      process.env.AWF_HARNESS_ENVIRONMENT = saved.AWF_HARNESS_ENVIRONMENT;
    }
  }
  return { mountedReport: true, requestPin: true, routingPin, runIsolation: true, harnessIsolation: true };
}

module.exports = { checkProxy };
