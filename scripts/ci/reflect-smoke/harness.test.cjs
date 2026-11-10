'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { readReport, collect } = require('./collect.cjs');
const { failureId } = require('./grade.cjs');

const root = path.resolve(__dirname, '../../..');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-reflect-harness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function executable(file, body) {
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o700 });
}

test('manual-only workflow launches all three pinned agents in parallel from the exact checkout', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/agent-reflect-smoke.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const copilot = workflow.jobs.copilot;
  const nonCopilot = workflow.jobs.non_copilot;
  assert.deepEqual(copilot.permissions, { contents: 'read', 'copilot-requests': 'write' });
  assert.deepEqual(nonCopilot.permissions, { contents: 'read' });
  assert.deepEqual(nonCopilot.strategy.matrix.agent, ['claude', 'codex']);
  for (const job of [copilot, nonCopilot]) {
    assert.equal(job.env.SOURCE_SHA, '${{ github.sha }}');
    assert.equal(job.needs, 'deterministic');
    for (const step of job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))) {
      assert.equal(step.with['persist-credentials'], false);
      assert.equal(step.with.ref, undefined);
    }
    const builds = job.steps.find(step => step.name?.startsWith('Build exact')).run;
    assert.ok(builds.includes('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"'));
    assert.ok(builds.includes('awf-reflect/$image:$SOURCE_SHA'));
    assert.ok(builds.includes('AWF_VERSION=0.0.0-reflect$SOURCE_SHA'));
    assert.ok(!builds.includes('latest'));
    assert.equal(job.steps.at(-1).if, 'always()');
    assert.equal(job.steps.at(-1).with['if-no-files-found'], 'error');
  }
});

test('host orchestration cannot pass a noop CLI or forged agent marker and freezes both fixtures', t => {
  const dir = directory(t);
  const checkout = path.join(dir, 'checkout');
  const temp = path.join(dir, 'runner');
  const bin = path.join(dir, 'bin');
  const scripts = path.join(checkout, 'scripts/ci/reflect-smoke');
  for (const entry of [temp, bin, scripts, path.join(checkout, 'dist'),
    path.join(checkout, '.awf-reflect-tools')]) fs.mkdirSync(entry, { recursive: true });
  for (const file of ['guest.sh', 'collect.cjs', 'grade.cjs', 'diagnostics.cjs']) {
    fs.copyFileSync(path.join(__dirname, file), path.join(scripts, file));
  }
  const calls = path.join(dir, 'calls.jsonl');
  const sha = 'a'.repeat(40);
  executable(path.join(bin, 'git'), `console.log('${sha}');`);
  executable(path.join(bin, 'timeout'), `
    const result = require('child_process').spawnSync(process.argv[5], process.argv.slice(6), {
      stdio: 'inherit', env: process.env, timeout: 10000
    });
    process.exit(result.status ?? 1);
  `);
  executable(path.join(bin, 'docker'), `
    const fs = require('fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.CALLS, JSON.stringify({ tool: 'docker', args }) + '\\n');
    if (args[0] === 'image') console.log('sha256:fixture');
    if (args[0] === 'inspect') console.log('true');
    if (args[0] === 'cp') {
      fs.writeFileSync(args[2], args[1].endsWith('task.json') ? '{}' :
        JSON.stringify({ version: 1, complete: true, events: [], upstream: [] }));
    }
  `);
  executable(path.join(bin, 'sudo'), `
    const fs = require('fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.CALLS, JSON.stringify({ tool: 'sudo', args }) + '\\n');
    if (args[0].endsWith('/docker')) {
      const result = require('child_process').spawnSync(args[0], args.slice(1), {
        stdio: 'inherit', env: process.env
      });
      process.exit(result.status ?? 1);
    }
    if (!args[0].startsWith('--preserve-env=') || !args[1].endsWith('/timeout') ||
        args[2] !== '--signal=TERM' || args[3] !== '--kill-after=30s' || args[4] !== '480s') process.exit(2);
    const result = require('child_process').spawnSync(args[1], args.slice(2), {
      stdio: 'inherit', env: process.env
    });
    process.exit(result.status ?? 1);
  `);
  fs.writeFileSync(path.join(checkout, 'dist/cli.js'), `
    const fs = require('fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.CALLS, JSON.stringify({ tool: 'awf', args, cwd: process.cwd(),
      workspace: process.env.GITHUB_WORKSPACE,
      config: JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8')) }) + '\\n');
    fs.writeFileSync('report.json', '{"status":"completed","result":"FORGED"}');
    fs.writeFileSync('agent-version.txt', 'codex-cli 0.159.3\\n');
  `);
  const run = spawnSync('bash', [path.join(__dirname, 'run.sh')], {
    cwd: checkout, encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CALLS: calls, GITHUB_WORKSPACE: checkout,
      RUNNER_TEMP: temp, SOURCE_SHA: sha, AGENT: 'codex', OPENAI_API_KEY: 'test-credential',
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_STEP_SUMMARY: path.join(dir, 'summary') },
  });
  assert.equal(run.status, 1, run.stderr);
  const records = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const invocations = records.filter(record => record.tool === 'awf');
  assert.equal(invocations.length, 2);
  for (const record of invocations) {
    assert.ok(record.cwd.startsWith(path.join(temp, 'reflect-private-codex/guest-')));
    assert.equal(record.workspace, record.cwd);
    assert.notEqual(record.cwd, checkout);
    assert.deepEqual(record.config, { apiProxy: { maxTurns: 24 } });
    assert.ok(record.args.includes('--network-isolation'));
    assert.ok(record.args.includes('--topology-attach'));
    assert.ok(record.args.includes('--skip-pull'));
    assert.ok(record.args.includes('--keep-containers'));
    assert.ok(record.args[record.args.indexOf('--work-dir') + 1].includes('/trusted-'));
    assert.equal(record.args[record.args.indexOf('--image-tag') + 1], sha);
    assert.equal(record.args[record.args.indexOf('--max-ai-credits') + 1], '30');
    assert.equal(record.args[record.args.indexOf('--agent-timeout') + 1], '6');
  }
  const dockerCalls = records.filter(record => record.tool === 'docker');
  assert.equal(dockerCalls.filter(record => record.args[0] === 'stop').length, 2);
  const removals = dockerCalls.filter(record => record.args[0] === 'rm');
  assert.equal(removals.length, 2);
  for (const record of removals) assert.ok(record.args.includes('--volumes'));
  const networkDisconnects = dockerCalls.filter(record =>
    record.args[0] === 'network' && record.args[1] === 'disconnect');
  assert.equal(networkDisconnects.length, 2);
  for (const record of networkDisconnects) assert.equal(record.args[2], 'none');
  const fixtureRuns = dockerCalls.filter(record => record.args[0] === 'run');
  assert.equal(fixtureRuns.length, 2);
  for (const record of fixtureRuns) {
    assert.ok(record.args.includes('type=volume,dst=/evidence'));
    assert.ok(!record.args.some(arg => arg.startsWith('/evidence:')));
  }
  for (const invocation of invocations) {
    const invocationIndex = records.indexOf(invocation);
    assert.equal(records.slice(0, invocationIndex).filter(record =>
      record.tool === 'docker' && record.args[0] === 'network' && record.args[1] === 'disconnect').length,
    invocations.indexOf(invocation) + 1);
  }
  assert.match(fs.readFileSync(path.join(__dirname, 'run.sh'), 'utf8'), /rm --force --volumes/);
  const teardown = dockerCalls.filter(record => record.args[0] === 'compose');
  assert.equal(teardown.length, 2);
  for (const record of teardown) assert.deepEqual(record.args.slice(-4), ['down', '-v', '-t', '1']);
  for (const scenario of ['recover', 'deny']) {
    const verdict = JSON.parse(fs.readFileSync(path.join(temp, `reflect-evidence-codex/${scenario}.json`)));
    assert.equal(verdict.status, 'fail');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, 'reflect-evidence-codex/harness-status.json'))),
    { exitCode: 1 });
});

for (const agent of ['copilot', 'claude', 'codex']) {
  test(`real guest launcher invokes ${agent}, not a scripted inference client`, t => {
    const dir = directory(t);
    const log = path.join(dir, 'args.jsonl');
    const pinnedBin = path.join(dir, 'tools/node_modules/.bin');
    fs.mkdirSync(pinnedBin, { recursive: true });
    executable(path.join(dir, agent), `
      require('fs').appendFileSync(process.env.DECOY_LOG, 'decoy selected\\n');
    `);
    executable(path.join(pinnedBin, agent), `
      require('fs').appendFileSync(process.env.ARGS_LOG, JSON.stringify({
        args: process.argv.slice(2), key: process.env.CODEX_API_KEY, path: process.env.PATH
      }) + '\\n');
      if (process.argv.includes('--version')) console.log('1.2.3');
    `);
    const run = spawnSync('bash', [path.join(__dirname, 'guest.sh'), agent, 'http://isolated-fixture:8080'], {
      cwd: dir, encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, ARGS_LOG: log,
        DECOY_LOG: path.join(dir, 'decoy.log'),
        OPENAI_BASE_URL: 'http://configured-sidecar:10000/v1' },
    });
    assert.equal(run.status, 0, run.stderr);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 2);
    const call = calls[1];
    assert.ok(call.path.startsWith(`${pinnedBin}:`));
    assert.equal(fs.existsSync(path.join(dir, 'decoy.log')), false);
    const prompt = call.args.find(arg => arg.includes('Perform the task'));
    assert.ok(prompt.includes('http://isolated-fixture:8080/reflect'));
    assert.ok(prompt.includes('First submit its request unchanged'));
    assert.ok(!prompt.includes('"effort":"low"') && !prompt.includes('"effort":"high"'));
    assert.equal(fs.existsSync(path.join(dir, 'report.json')), false, 'Noop CLI must not create success');
    if (agent === 'codex') {
      assert.equal(call.key, 'sk-placeholder-for-api-proxy');
      assert.ok(call.args.includes('model_provider="awf"'));
      assert.ok(call.args.some(arg => arg.includes('base_url="http://configured-sidecar:10000/v1"')));
      assert.ok(call.args.some(arg => arg.includes('wire_api="responses"')));
    }
    if (agent === 'claude') assert.ok(call.args.includes('--max-turns'));
    if (agent === 'copilot') assert.ok(call.args.includes('--max-ai-credits'));
  });
}

test('collector rejects missing, symlink, oversized and non-JSON reports without leaking output', t => {
  const dir = directory(t);
  const report = path.join(dir, 'report.json');
  assert.throws(() => readReport(report));
  fs.writeFileSync(report, '{}');
  fs.symlinkSync(report, path.join(dir, 'link'));
  assert.throws(() => readReport(path.join(dir, 'link')));
  fs.writeFileSync(report, 'x'.repeat(4097));
  assert.throws(() => readReport(report));
  fs.writeFileSync(report, 'PRIVATE-UNTRUSTED-TEXT');
  assert.throws(() => readReport(report));
  const output = path.join(dir, 'summary.json');
  assert.equal(collect(path.join(dir, 'missing-evidence'), report, 0, output), false);
  const summary = fs.readFileSync(output, 'utf8');
  assert.equal(JSON.parse(summary).status, 'fail');
  assert.equal(JSON.parse(summary).failedAssertion, null);
  assert.ok(!summary.includes('PRIVATE-UNTRUSTED-TEXT'));
});

test('public failure evidence is bounded and cannot echo arbitrary values or forged assertion IDs', t => {
  const dir = directory(t);
  const secret = 'PRIVATE-PROMPT-TOKEN-HEADER-TRANSCRIPT';
  const event = { sequence: secret, method: secret, path: secret, status: secret,
    error: secret, body: { model: secret, input: secret, reasoning: { effort: secret }, extra: secret },
    headers: { authorization: secret }, reflection: { recent: { decisions: [
      { reason: secret }, ...Array.from({ length: 100 }, () => ({ reason: 'policy_denied' })),
    ] } } };
  const state = { version: 1, scenario: 'recover', complete: true, model: secret, nonce: secret,
    effort: secret, result: secret, events: Array(100).fill(event), upstream: Array(100).fill(event) };
  const evidence = path.join(dir, 'evidence.json');
  const report = path.join(dir, 'report.json');
  const output = path.join(dir, 'summary.json');
  fs.writeFileSync(evidence, JSON.stringify(state));
  fs.writeFileSync(report, JSON.stringify({ status: secret, result: secret }));
  assert.equal(collect(evidence, report, 0, output), false);
  const text = fs.readFileSync(output, 'utf8');
  const summary = JSON.parse(text);
  assert.equal(summary.failedAssertion, 'request_count');
  assert.equal(summary.trace.length, 13);
  assert.equal(summary.upstream.length, 13);
  assert.equal(summary.trace[0].sequence, null);
  assert.equal(summary.trace[0].status, null);
  assert.equal(summary.trace[0].reason, null);
  assert.deepEqual(summary.trace[0].diagnosticReasons, ['policy_denied']);
  assert.ok(Object.values(summary.trace[0].requestShape).every(value => typeof value === 'boolean'));
  assert.ok(!text.includes(secret));
  assert.ok(text.length < 25000);
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'grade.cjs'), evidence, report, '0'],
    { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr.trim(), 'Reflect smoke failed: request_count');
  assert.ok(!`${cli.stdout}${cli.stderr}`.includes(secret));
  assert.equal(failureId(Object.assign(new Error(secret), { code: 'initial_request_exact' })), null);
  assert.equal(collect(evidence, report, secret, output), false);
  const badExit = fs.readFileSync(output, 'utf8');
  assert.equal(JSON.parse(badExit).agentExit, null);
  assert.equal(JSON.parse(badExit).failedAssertion, 'agent_exit');
  assert.ok(!badExit.includes(secret));
  fs.writeFileSync(report, secret);
  assert.equal(collect(evidence, report, 0, output), false);
  const badReport = fs.readFileSync(output, 'utf8');
  assert.equal(JSON.parse(badReport).stage, 'read_report');
  assert.equal(JSON.parse(badReport).failedAssertion, null);
  assert.ok(!badReport.includes(secret));
});
