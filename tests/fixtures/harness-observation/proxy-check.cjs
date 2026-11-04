'use strict';

// Executed in a separate, networkless container against the real read-only
// report mount. No filesystem/ownership stubs or provider traffic are involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pinHarnessObservation, readHarnessObservation } = require('./proxy/harness-observation');
const { createEligibilityStore } = require('./proxy/catalogue-contract/eligibility');
const { identity } = require('./proxy/catalogue-contract/identity');
const options = JSON.parse(process.argv[2]);
const scope = { provider: 'copilot', channel: 'copilot-api', deployment: 'fixture' };
const model = identity('copilot', 'fixture-model');
const requirement = {
  scope, name: process.env.AWF_SELECTED_HARNESS, scheme: 'semver', minimum: '9.0.0',
  reason: 'Test-only incompatible requirement', provenance: { authority: 'maintained' },
};
const input = { identity: model, scope, discovery: { status: 'available', authoritative: true } };
const store = createEligibilityStore({ models: [{ identity: model, harnesses: [requirement] }] });
const pin = pinHarnessObservation(store.pin());
const first = pin.evaluate(input);
const report = readHarnessObservation();
assert.equal(report.status, options.status);
if (options.reason) assert.equal(report.reason, options.reason);
assert.equal(first.admitted, false);
assert.equal(first.harness, report.status === 'observed' ? 'incompatible' : 'unverified');
assert.equal(pinHarnessObservation(createEligibilityStore().pin()).evaluate(input).admitted, true);
assert(Object.isFrozen(pin));
assert(Object.isFrozen(first));

// Replacing the report after pinning must not change this request's evidence.
// The host replaces it only after this process acknowledges the first read.
if (options.pinAcrossReplacement) {
  fs.writeFileSync('/exchange/pinned', 'ready\n');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync('/exchange/replaced') && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert(fs.existsSync('/exchange/replaced'), 'host did not replace report within bound');
  assert.deepEqual(pin.evaluate(input), first);
  assert.equal(pinHarnessObservation(store.pin()).evaluate(input).harness, 'unverified');
}
process.stdout.write(JSON.stringify({ status: report.status, harness: first.harness, pinned: true }));
