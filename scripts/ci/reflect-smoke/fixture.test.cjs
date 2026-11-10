'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { grade, failureId } = require('./grade.cjs');
const { collect } = require('./collect.cjs');

async function fixture(t, scenario) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-reflect-test-'));
  const child = fork(path.join(__dirname, 'fixture.cjs'), [], {
    env: { PATH: process.env.PATH, HOME: directory, FIXTURE_DIRECTORY: directory,
      PROXY_DIRECTORY: path.resolve(__dirname, '../../../containers/api-proxy'),
      FIXTURE_PORT: '0', SCENARIO: scenario },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  t.after(() => clearTimeout(timeout));
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(() => { throw new Error(`Fixture failed to start: ${logs}`); }),
  ]);
  const task = JSON.parse(fs.readFileSync(path.join(directory, 'task.json')));
  const request = async (method, endpoint, body) => {
    const res = await fetch(`http://127.0.0.1:${ready.port}${endpoint}`, {
      method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
      signal: AbortSignal.timeout(3000),
    });
    return { status: res.status, body: await res.json() };
  };
  return { task, request, directory, async finish() {
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, logs);
    return JSON.parse(fs.readFileSync(path.join(directory, 'evidence.json')));
  } };
}

for (const scenario of ['recover', 'deny']) {
  test(`real production ${scenario} path and fail-closed grader`, { timeout: 20000 }, async t => {
    const f = await fixture(t, scenario);
    const rejected = await f.request('POST', '/responses', f.task.request);
    assert.equal(rejected.status, scenario === 'recover' ? 400 : 403);
    const reflected = await f.request('GET', '/reflect');
    assert.equal(reflected.status, 200);
    const diagnostics = reflected.body.model_decision_diagnostics;
    assert.ok(diagnostics.recent.decisions.length > 0);
    let report;
    if (scenario === 'recover') {
      const current = diagnostics.current.decisions.find(item =>
        item.identity?.model_id === f.task.request.model && item.effort?.supported_values?.length);
      assert.ok(current, 'Actual /reflect must supply exact-model effort evidence');
      const corrected = structuredClone(f.task.request);
      corrected.reasoning.effort = current.effort.supported_values[0];
      const response = await f.request('POST', '/responses', corrected);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      report = { status: 'completed', result: response.body.output[0].content[0].text };
    } else {
      assert.deepEqual(reflected.body.endpoints.flatMap(item => item.models || []), []);
      report = { status: 'blocked', reason: 'model_policy_violation', retry: false };
    }
    const evidence = await f.finish();
    assert.equal(grade(evidence, report, 0).status, 'pass');
    const reportFile = path.join(f.directory, 'report.json');
    const summaryFile = path.join(f.directory, 'summary.json');
    fs.writeFileSync(reportFile, JSON.stringify(report));
    assert.equal(collect(path.join(f.directory, 'evidence.json'), reportFile, 0, summaryFile), true);
    const summaryText = fs.readFileSync(summaryFile, 'utf8');
    const summary = JSON.parse(summaryText);
    assert.equal(summary.reflectRead, true);
    assert.equal(summary.failedAssertion, null);
    assert.equal(summary.upstreamRequests, scenario === 'recover' ? 1 : 0);
    assert.equal(summary.trace[0].requestShape.exactInitialMatches, true);
    assert.equal(summary.trace[0].requestShape.supportedEffortMatches, false);
    if (scenario === 'recover') {
      assert.equal(summary.trace[2].requestShape.exactCorrectedMatches, true);
      assert.equal(summary.upstream[0].requestShape.exactCorrectedMatches, true);
    }
    assert.ok(!summaryText.includes(evidence.nonce) && !summaryText.includes(evidence.result));
    const bad = (mutate, expectedId) => {
      const copy = structuredClone(evidence);
      mutate(copy);
      assert.throws(() => grade(copy, report, 0), error => {
        assert.ok(failureId(error));
        if (expectedId) assert.equal(failureId(error), expectedId);
        return true;
      });
    };
    bad(copy => { copy.complete = false; });
    bad(copy => { copy.events = []; });
    bad(copy => { copy.events[0].status = 200; }, 'initial_rejection_status');
    bad(copy => { copy.events[0].body.model = 'other-model'; }, 'initial_request_exact');
    bad(copy => { delete copy.events[0].status; });
    bad(copy => { delete copy.events[0].finished; });
    bad(copy => { copy.events[1].reflection.recent.decisions = []; }, 'reflect_rejection');
    bad(copy => { delete copy.events[1].reflection.recent; }, 'reflect_rejection');
    bad(copy => { copy.events[1].reflection.schema = 'other'; }, 'reflect_schema');
    bad(copy => { copy.events[1].reflection.recent.decisions[0].action.retry = 'retry'; }, 'reflect_rejection');
    bad(copy => { copy.events[1].path = '/health'; });
    bad(copy => {
      copy.events.splice(1, 1);
      copy.events.forEach((event, index) => { event.sequence = index; });
    });

    bad(copy => {
      while (copy.events.length < 6) {
        copy.events.push({ ...structuredClone(copy.events[1]), sequence: copy.events.length });
      }
    });
    bad(copy => {
      const repeated = structuredClone(copy.events[0]);
      repeated.sequence = copy.events.length;
      copy.events.push(repeated);
    });
    bad(copy => { copy.upstream.push({ method: 'POST', path: '/responses', body: {} }); });
    assert.throws(() => grade(evidence, report, 124));
    assert.throws(() => grade(evidence, {}, 0));
    if (scenario === 'recover') {
      bad(copy => { copy.events[2].body.reasoning.effort = 'max'; });
      bad(copy => { copy.events[2].body.model = 'other-model'; });
      bad(copy => { delete copy.events[2].body.reasoning; });
      bad(copy => { copy.events[2].body.input = 'wrong-nonce'; });
      bad(copy => { copy.events[2].sequence = 0; });
      assert.throws(() => grade(evidence, { status: 'completed', result: 'invented' }, 0));
    } else {
      assert.throws(() => grade(evidence, { ...report, retry: true }, 0));
    }
  });
}

// These reproduce retained chronologies with one known malformed-input cause.
// The old public artifacts contain no bodies and cannot establish that cause.
for (const [name, scenario, steps] of [
  ['Copilot recovery', 'recover', ['envelope', 'reflect', 'initial', 'corrected']],
  ['Claude recovery', 'recover', ['envelope', 'reflect', 'initial']],
  ['Claude denial', 'deny', ['envelope', 'reflect', 'initial']],
  ['Codex recovery', 'recover', ['envelope', 'reflect', 'reflect', 'corrected']],
  ['Codex denial', 'deny', ['initial', 'post-reflect']],
]) {
  test(`retained ${name} chronology fails with sanitized boundary evidence`, { timeout: 20000 }, async t => {
    const f = await fixture(t, scenario);
    let supportedEffort;
    let report = scenario === 'deny'
      ? { status: 'blocked', reason: 'model_policy_violation', retry: false } : {};
    for (const step of steps) {
      if (step === 'reflect') {
        const reflected = await f.request('GET', '/reflect');
        assert.equal(reflected.status, 200);
        assert.deepEqual(reflected.body.model_decision_diagnostics.recent.decisions, []);
        supportedEffort = reflected.body.model_decision_diagnostics.current.decisions.find(item =>
          item.identity?.model_id === f.task.request.model)?.effort?.supported_values[0];
      } else {
        const body = step === 'envelope' ? f.task : structuredClone(f.task.request);
        if (step === 'corrected') body.reasoning.effort = supportedEffort;
        const response = await f.request('POST', step === 'post-reflect' ? '/reflect' : '/responses', body);
        assert.equal(response.status, step === 'envelope' ? 422 : step === 'corrected' ? 200 :
          scenario === 'deny' ? 403 : 400);
        if (step === 'corrected') report = { status: 'completed', result: response.body.output[0].content[0].text };
      }
    }
    const evidence = await f.finish();
    const reportFile = path.join(f.directory, 'report.json');
    const output = path.join(f.directory, 'summary.json');
    fs.writeFileSync(reportFile, JSON.stringify(report));
    assert.equal(collect(path.join(f.directory, 'evidence.json'), reportFile, 0, output), false);
    const text = fs.readFileSync(output, 'utf8');
    const summary = JSON.parse(text);
    assert.equal(summary.stage, 'grade');
    assert.equal(summary.failedAssertion, name === 'Codex denial' ? 'endpoint_method' : 'initial_request_exact');
    assert.deepEqual(summary.trace.map(event => event.status), evidence.events.map(event => event.status));
    if (steps[0] === 'envelope') {
      assert.equal(summary.trace[0].requestShape.exactInitialMatches, false);
      assert.equal(summary.trace[0].requestShape.modelMatches, false);
      assert.equal(summary.upstream[0].reason, 'fixture_task_mismatch');
      assert.equal(summary.upstream[0].status, 422);
      assert.equal(summary.upstream[0].requestShape.modelMatches, false);
    } else {
      assert.equal(summary.trace[1].method, 'POST');
      assert.equal(summary.trace[1].path, '/reflect');
      assert.deepEqual(summary.upstream, []);
    }
    assert.ok(!text.includes(evidence.nonce) && !text.includes(evidence.result));
  });
}

for (const [name, change, mismatchedFlag] of [
  ['missing effort', request => { delete request.reasoning; }, 'supportedEffortMatches'],
  ['wrong input shape', request => { request.input = [{ role: 'user', content: request.input }]; }, 'inputMatches'],
  ['missing stream flag', request => { delete request.stream; }, 'streamMatches'],
]) {
  test(`real upstream 422 isolates ${name} without publishing values`, { timeout: 20000 }, async t => {
    const f = await fixture(t, 'recover');
    await f.request('POST', '/responses', f.task.request);
    const reflected = await f.request('GET', '/reflect');
    const corrected = structuredClone(f.task.request);
    corrected.reasoning.effort = reflected.body.model_decision_diagnostics.current.decisions.find(item =>
      item.identity?.model_id === corrected.model && item.effort?.supported_values?.length).effort.supported_values[0];
    change(corrected);
    assert.equal((await f.request('POST', '/responses', corrected)).status, 422);
    const evidence = await f.finish();
    const reportFile = path.join(f.directory, 'report.json');
    const output = path.join(f.directory, 'summary.json');
    fs.writeFileSync(reportFile, '{}');
    assert.equal(collect(path.join(f.directory, 'evidence.json'), reportFile, 0, output), false);
    const summary = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(summary.failedAssertion, 'correction_status');
    assert.equal(summary.trace[2].requestShape[mismatchedFlag], false);
    assert.equal(summary.upstream[0].requestShape[mismatchedFlag], false);
    assert.equal(summary.upstream[0].reason, 'fixture_task_mismatch');
    assert.equal(summary.upstream[0].requestShape.modelMatches, true);
    const text = fs.readFileSync(output, 'utf8');
    assert.ok(!text.includes(evidence.nonce) && !text.includes(evidence.result));
  });
}

test('incoming and forwarded flags distinguish a real production model normalization', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'recover');
  await f.request('POST', '/responses', f.task.request);
  const reflected = await f.request('GET', '/reflect');
  const corrected = structuredClone(f.task.request);
  corrected.reasoning.effort = reflected.body.model_decision_diagnostics.current.decisions.find(item =>
    item.identity?.model_id === corrected.model && item.effort?.supported_values?.length).effort.supported_values[0];
  corrected.model = `copilot/${corrected.model}`;
  assert.equal((await f.request('POST', '/responses', corrected)).status, 200);
  await f.finish();
  const reportFile = path.join(f.directory, 'report.json');
  const output = path.join(f.directory, 'summary.json');
  fs.writeFileSync(reportFile, '{}');
  assert.equal(collect(path.join(f.directory, 'evidence.json'), reportFile, 0, output), false);
  const summary = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(summary.failedAssertion, 'corrected_request_exact');
  assert.equal(summary.trace[2].requestShape.modelMatches, false);
  assert.equal(summary.upstream[0].requestShape.modelMatches, true);
});

test('real repeated invalid and policy-evasion requests cannot pass', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'deny');
  await f.request('POST', '/responses', f.task.request);
  await f.request('GET', '/reflect');
  await f.request('POST', '/responses', { ...f.task.request, model: 'gpt-5.2' });
  const evidence = await f.finish();
  assert.equal(evidence.events[2].status, 403);
  assert.deepEqual(evidence.upstream, []);
  assert.throws(() => grade(evidence, { status: 'blocked', reason: 'model_policy_violation', retry: false }, 0));
});
