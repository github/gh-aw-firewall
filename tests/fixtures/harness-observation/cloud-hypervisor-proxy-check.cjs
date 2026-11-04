'use strict';

// Runs networkless against the API-proxy image's actual consumer modules and
// fixed read-only report mount. Only planner/provider responses are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  proxyEligibilityStore, pinRequestEligibility, evaluateModelEligibility,
} = require('/app/model-eligibility');
const { createRoutingController } = require('/app/routing-controller');
const { resolveModelIdentity } = require('/app/model-identity');
const { readHarnessObservation } = require('/app/harness-observation');

const scope = { provider: 'copilot', channel: 'copilot-api' };
const ids = ['awf-harness-fixture', 'awf-harness-fixture-next'];
const models = ids.map(id => ({
  id, efforts: ['low'], protocols: ['responses'], contextWindow: 128000,
}));
function request() {
  return {
    awfEligibilityScope: { ...scope },
    awfRuntimePricing: { copilot: models },
    awfModelCatalogAuthoritative: true,
  };
}
function evaluate(req, model = ids[0]) {
  return evaluateModelEligibility(model, 'copilot', req);
}
async function replacementBarrier() {
  fs.writeFileSync('/exchange/pinned', 'ready\n');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync('/exchange/replaced') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(fs.existsSync('/exchange/replaced'), 'report replacement rendezvous expired');
}
async function main(options) {
  proxyEligibilityStore.replaceTrustedEvidence({});
  const legacyRequest = request();
  const legacyPin = pinRequestEligibility(legacyRequest);
  const legacy = evaluate(legacyRequest);
  assert.equal(legacy.admitted, true);
  assert.equal(legacy.harness, 'unconstrained');
  assert.notEqual(legacy.harness, 'compatible');
  const legacyEvidence = { legacyAdmitted: true, legacyHarness: 'unconstrained' };
  proxyEligibilityStore.replaceTrustedEvidence({
    models: ids.map(id => ({
      identity: resolveModelIdentity(id, 'copilot').identity,
      harnesses: [{
        scope, name: process.env.AWF_SELECTED_HARNESS || 'copilot-cli', minimum: '1.0.0', scheme: 'semver',
        reason: 'Test-owned compatible consumer constraint', provenance: { authority: 'maintained' },
      }],
    })),
  });
  try {
    assert.equal(pinRequestEligibility(legacyRequest), legacyPin);
    assert.deepEqual(evaluate(legacyRequest), legacy);
    const observed = readHarnessObservation();
    if (options.absent) {
      assert.equal(observed, undefined);
      assert.equal(evaluate(request()).harness, 'unverified');
      return { pinned: true, request: true, enclaveEvidenceAbsent: true, ...legacyEvidence };
    }
    assert.equal(observed.status, options.status);
    if (options.reason) assert.equal(observed.reason, options.reason);
    const req = request();
    const pin = pinRequestEligibility(req);
    const first = evaluate(req);
    assert.equal(pinRequestEligibility(req), pin);
    assert(Object.isFrozen(pin));
    assert(Object.isFrozen(req.awfEligibilityScope));
    assert.equal(first.harness, observed.status === 'observed' ? 'compatible' : 'unverified');
    assert.equal(first.admitted, observed.status === 'observed');
    if (!options.pinAcrossReplacement) return { pinned: true, request: true, ...legacyEvidence };

    // createRoutingController pins production eligibility before awaiting
    // discovery. Replace the report while that real asynchronous boundary is
    // active; classifier retries and final admission must retain the old pin.
    let catalogueCalls = 0;
    const executions = [];
    const checks = [];
    const classification = {
      labels: { task_type: 'implement', scope: 'local', task_complexity: 'easy' },
      mode: 'balanced',
    };
    const controller = createRoutingController({
      config: {
        provider: 'copilot', objective: { goal: 'cost', mode: 'balanced' },
        task: { conversationFile: '/fixture/unused-conversation.json' },
      },
      eligibilityScope: scope,
      catalogue: { async getSnapshot() {
        catalogueCalls++;
        await replacementBarrier();
        return { provider: 'copilot', configured: true, discovery: 'complete', models };
      } },
      loadConversation: async () => [{ role: 'user', parts: [{ text: 'fixture task' }] }],
      planner: {
        health: async () => 204,
        capabilities: async () => ({
          name: 'gh-aw-router', version: '1.0.0',
          routing_profiles: [{ goal: 'cost', mode: 'balanced' }],
          execution_catalogue: { models: [] },
        }),
        classify: async body => ({
          system_prompt: 'fixture classification', prompt: 'fixture task',
          ranked_choices: body.models.map(choice => ({ ...choice })),
        }),
        route: async body => ({
          ranked_choices: body.models.map(choice => ({
            id: choice.id, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}),
          })),
        }),
      },
      executor: {
        async execute(classifierRequest) {
          executions.push(classifierRequest);
          assert.equal(evaluate(classifierRequest).harness, 'compatible');
          return executions.length === 1 ? { statusCode: 503 } : {
            statusCode: 200, body: Buffer.from(JSON.stringify({ output_text: JSON.stringify(classification) })),
          };
        },
        async checkBeforePrimary(primaryRequest) {
          checks.push(primaryRequest);
          assert.equal(evaluate(primaryRequest).harness, 'compatible');
        },
      },
    });
    const result = await controller.run();
    assert.equal(result.ok, true);
    assert.equal(await controller.run(), result);
    assert(Object.isFrozen(result.selection));
    assert.equal(catalogueCalls, 1);
    assert.equal(executions.length, 2);
    assert.equal(checks.length, 1);
    const routingPin = executions[0].awfEligibility;
    assert(Object.isFrozen(routingPin));
    assert.equal(executions[1].awfEligibility, routingPin);
    assert.equal(checks[0].awfEligibility, routingPin);
    assert.equal(executions[1].awfEligibilityScope, executions[0].awfEligibilityScope);
    assert.equal(checks[0].awfEligibilityScope, executions[0].awfEligibilityScope);
    assert(Object.isFrozen(executions[0].awfEligibilityScope));
    assert.deepEqual(evaluate(req), first);
    assert.equal(pinRequestEligibility(req), pin);
    assert.equal(readHarnessObservation().reason, 'observation_environment_mismatch');
    assert.equal(evaluate(request()).harness, 'unverified');
    return { pinned: true, request: true, routing: true, classifierAttempts: executions.length, ...legacyEvidence };
  } finally { proxyEligibilityStore.replaceTrustedEvidence({}); }
}
module.exports = { main };
if (require.main === module) {
  main(JSON.parse(process.argv[2])).then(result => process.stdout.write(JSON.stringify(result))).catch(() => {
    // Never print a report, arbitrary metadata, provider response or raw error.
    process.stderr.write('consumer-acceptance-failed\n');
    process.exitCode = 1;
  });
}
