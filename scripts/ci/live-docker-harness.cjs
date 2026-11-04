'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const execa = require('execa');
const yaml = require('js-yaml');
const { buildAgentService } = require('../../dist/services/agent-service');
const { applyHostPathPrefixToVolumes, prefixHostPath } = require('../../dist/services/host-path-prefix');
const {
  createDockerHarnessObservation, DOCKER_HARNESS_ENVIRONMENT_LABEL,
} = require('../../dist/docker-harness-observation');
const {
  harnessContext, harnessProxyEnvironment, observeHarness, prepareHarnessObservation,
} = require('../../dist/harness-observation');
const { createEligibilityStore } = require('../../dist/model-information-contract/eligibility');
const { eligibilityEvidence } = require('../../dist/model-information-contract/harness-observation');
const { identity } = require('../../dist/model-information-contract/identity');
const { setAwfDockerHost } = require('../../dist/docker-host');
const { parseImageTag } = require('../../dist/image-tag');
const { runMainWorkflow } = require('../../dist/cli-workflow');
const copilotModels = require('../../dist/copilot-model');

const fixtureRoot = path.resolve(__dirname, '../../tests/fixtures/harness-observation');
const image = process.env.AWF_LIVE_AGENT_IMAGE || 'awf-harness-agent:local';
const topology = process.env.AWF_LIVE_TOPOLOGY || 'native';
const prefix = topology === 'split-dind' ? '/runner' : undefined;
const artifacts = path.resolve(process.env.AWF_LIVE_ARTIFACTS || 'artifacts/harness-live');
const label = 'io.github.awf.live-harness-test';
const owner = randomUUID();
const results = [];
const directories = new Set();
const containers = new Set();
let active;

async function docker(args, options = {}) {
  return execa('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024, ...options });
}
async function isolatedRun(args, options = {}) {
  const name = `awf-live-reader-${randomUUID()}`;
  containers.add(name);
  try {
    return await docker(['run', '--name', name, '--label', `${label}=${owner}`, '--network', 'none',
      '--memory', '256m', '--pids-limit', '64', '--cpus', '1', ...args], options);
  } finally {
    await ownedRemove(name);
  }
}
function translated(filename) {
  return prefix ? prefixHostPath(filename, prefix) : filename;
}
async function ownedRemove(name) {
  const inspected = await docker(['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name],
    { reject: false });
  if (inspected.exitCode !== 0) {
    assert.match(inspected.stderr, /No such (object|container)/, 'cannot establish cleanup ownership');
    containers.delete(name);
    return;
  }
  assert.equal(inspected.stdout, owner, `refusing to remove unowned container ${name}`);
  await docker(['rm', '-f', name]);
  const gone = await docker(['inspect', name], { reject: false });
  assert.notEqual(gone.exitCode, 0, 'container survived cleanup');
  assert.match(gone.stderr, /No such (object|container)/);
  containers.delete(name);
}
async function cleanup() {
  for (const name of [...containers]) await ownedRemove(name);
  for (const directory of directories) {
    fs.rmSync(directory, { recursive: true, force: true });
    directories.delete(directory);
  }
}
function write(filename, content, mode = 0o644) {
  fs.writeFileSync(filename, content, { mode });
}
function readReport(run) {
  return JSON.parse(fs.readFileSync(run.reportFile, 'utf8'));
}
function reportFile(run, report) {
  const temporary = `${run.reportFile}.replacement`;
  write(temporary, JSON.stringify(report));
  fs.renameSync(temporary, run.reportFile);
}
async function waitFor(filename) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(filename) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(fs.existsSync(filename), 'fixture rendezvous timed out');
}
async function makeRun(binary = 'copilot', mode = 'valid', options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-live-harness-'));
  directories.add(directory);
  fs.chmodSync(directory, 0o755);
  for (const subdirectory of ['bin', 'pinned', 'workspace', 'home', 'etc', 'control', 'control/api-proxy-logs', 'exchange']) {
    fs.mkdirSync(path.join(directory, subdirectory), { mode: 0o755 });
  }
  fs.chownSync(`${directory}/workspace`, 1001, 1002);
  fs.chownSync(`${directory}/home`, 1001, 1002);
  fs.chownSync(`${directory}/exchange`, 1001, 1002);
  write(`${directory}/etc/passwd`,
    `root:x:0:0:root:/root:/bin/bash\nfixture:x:1001:1002:Fixture:${directory}/home:/bin/bash\n`);
  write(`${directory}/etc/group`, 'root:x:0:\nfixture:x:1002:\n');
  write(`${directory}/startup`, [
    'export FIXTURE_ENV="$FIXTURE_ENV:startup"',
    ...(options.pinned ? [fs.readFileSync(`${fixtureRoot}/pinned-startup.sh`, 'utf8')] : []),
    ...(options.function ? [`${binary}() { "${directory}/bin/${binary}" "$@"; }`] : []),
    '',
  ].join('\n'));
  if (mode !== 'missing') {
    fs.copyFileSync(`${fixtureRoot}/executable.sh`, `${directory}/bin/${binary}`);
    fs.chmodSync(`${directory}/bin/${binary}`, 0o755);
    fs.copyFileSync(`${directory}/bin/${binary}`, `${directory}/pinned/${binary}`);
    fs.chmodSync(`${directory}/pinned/${binary}`, 0o755);
    if (options.pinned) write(`${directory}/bin/${binary}`, '#!/bin/bash\nexit 99\n');
  }
  const config = {
    workDir: `${directory}/control`, allowedDomains: [], logLevel: 'error', keepContainers: false,
    enableApiProxy: true, agentCommand: mode === 'missing' ? `${directory}/absent/${binary}` : `${binary} --fixture`,
    dockerHostPathPrefix: prefix, runnerTopology: prefix ? 'arc-dind' : 'standard',
    networkIsolation: true, memoryLimit: '512m', pidsLimit: 128,
  };
  const environment = {
    AWF_USER_UID: options.startupFailure ? '0' : '1001', AWF_USER_GID: '1002',
    AWF_CHROOT_ENABLED: 'true', AWF_CHROOT_IDENTITY_UID: '1001', AWF_CHROOT_IDENTITY_GID: '1002',
    AWF_CHROOT_IDENTITY_HOME: `${directory}/home`, AWF_CHROOT_IDENTITY_USER: 'fixture',
    AWF_HOST_PATH: `${directory}/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    AWF_WORKDIR: `${directory}/workspace`, AWF_NETWORK_ISOLATION: '1',
    AWF_COMMAND_STDOUT_ONLY: '1', BASH_ENV: `${directory}/startup`,
    FIXTURE_DIRECTORY: `${directory}/workspace`, FIXTURE_ENV: 'controlled',
    FIXTURE_MODE: mode, FIXTURE_VERSION: {
      copilot: 'GitHub Copilot CLI 1.2.3', claude: '2.1.3 (Claude Code)', codex: 'codex-cli 0.89.0',
    }[binary],
    ...(options.pinned ? { FIXTURE_PINNED_BINARY: `${directory}/pinned/${binary}` } : {}),
  };
  const volumes = [
    ...['/usr', '/bin', '/sbin', '/lib', '/lib64'].filter(item => fs.existsSync(item))
      .map(item => `${item}:/host${item}:ro`),
    '/dev:/host/dev:ro', '/sys:/host/sys:ro',
    '/etc/ssl/certs:/host/etc/ssl/certs:ro',
    `${directory}/etc/passwd:/host/etc/passwd:ro`, `${directory}/etc/group:/host/etc/group:ro`,
    `${directory}/workspace:/host${directory}/workspace:rw`,
    `${directory}/home:/host${directory}/home:rw`,
    `${directory}/bin:/host${directory}/bin:ro`,
    `${directory}/pinned:/host${directory}/pinned:ro`,
    `${directory}/startup:/host${directory}/startup:ro`,
  ];
  write(`${config.workDir}/seccomp-profile.json`,
    fs.readFileSync(path.resolve(__dirname, '../../containers/agent/seccomp-profile.json')));
  const service = buildAgentService({
    config, environment, agentVolumes: applyHostPathPrefixToVolumes(volumes, prefix), dnsServers: [],
    networkConfig: { agentIp: '172.30.0.20' },
    imageConfig: { useGHCR: true, registry: 'unused', parsedTag: parseImageTag('local'), projectRoot: process.cwd() },
  });
  // Isolate this producer test from provider/network services. Preserve the
  // production command, tmpfs, identity, security settings and image entrypoint.
  delete service.networks;
  delete service.depends_on;
  service.network_mode = 'none';
  service.cpus = 1;
  service.image = image;
  service.labels[label] = owner;
  const compose = `${config.workDir}/compose.yml`;
  write(compose, yaml.dump({ services: { agent: service } }));
  const report = `${config.workDir}/api-proxy-logs/harness-observation.json`;
  prepareHarnessObservation(config);
  const run = {
    directory, config, compose, reportFile: report,
    controller: createDockerHarnessObservation(config, harnessContext(config)),
    context: harnessContext(config), commandFile: `${directory}/workspace/command-context`,
  };
  active = run;
  if (!options.deferStart) await startRun(run);
  return run;
}
async function startRun(run) {
  containers.add('awf-agent');
  await docker(['compose', '-p', `awf-live-${owner}`, '-f', run.compose, 'up', '-d', '--no-build', '--pull', 'never']);
}
async function waitExit(run) {
  const wait = await docker(['wait', 'awf-agent'], { timeout: 20000 });
  const logs = await docker(['logs', 'awf-agent']);
  // This entrypoint mode separates setup diagnostics from command stdout.
  // Assert the fixture's single stderr record independently of setup messages.
  return {
    exitCode: Number(wait.stdout), stdout: logs.stdout.trim(),
    stderr: logs.stderr.split('\n').filter(line => line === 'fixture-command-stderr').join('\n'),
  };
}
async function failureDiagnostics(run) {
  const state = await docker(['inspect', '--format',
    '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}', 'awf-agent'], { reject: false });
  const gate = await docker(['exec', '--user', '0:0', 'awf-agent', '/bin/bash', '-p', '-c', `
if [ -f /host/run/awf-harness/probe/result ]; then
  { IFS= read -r binding; IFS= read -r status; } </host/run/awf-harness/probe/result
  if [[ "$status" =~ ^[0-9]{1,3}$ ]]; then printf '%s' "$status"; fi
fi`], { reject: false });
  const logs = await docker(['logs', 'awf-agent'], { reject: false });
  const errorClasses = [
    ['identity', /Invalid AWF_USER_/],
    ['procfs', /Failed to mount procfs/],
    ['chroot-prerequisite', /requires a glibc|capsh not found|bash not found/],
    ['ca-store', /No CA store available for AWF trust policy/],
    ['preload', /Could not copy one-shot-token|Could not create \/run\/awf-lib/],
    ['permission', /Permission denied/],
    ['missing-path', /No such file or directory/],
    ['readonly-mount', /Read-only file system/],
  ].filter(([, pattern]) => pattern.test(logs.stderr)).map(([name]) => name);
  write(`${artifacts}/failure-diagnostics.json`, JSON.stringify({
    state: /^[a-z]+ \d+ (true|false)$/.test(state.stdout) ? state.stdout : 'unavailable',
    probeExitCode: /^\d{1,3}$/.test(gate.stdout) ? Number(gate.stdout) : null,
    probeContextExists: fs.existsSync(`${run.directory}/workspace/probe-context`),
    commandContextExists: fs.existsSync(run.commandFile),
    entrypointErrorClasses: errorClasses,
  }, null, 2));
}
async function finishRun() {
  await ownedRemove('awf-agent');
  active = undefined;
}
async function proxyCheck(run, options) {
  const library = `${run.directory}/proxy`;
  if (!fs.existsSync(library)) {
    fs.mkdirSync(library);
    fs.cpSync(path.resolve(__dirname, '../../containers/api-proxy/catalogue-contract'), `${library}/catalogue-contract`, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../containers/api-proxy/harness-observation.js'), `${library}/harness-observation.js`);
    fs.copyFileSync(`${fixtureRoot}/proxy-check.cjs`, `${run.directory}/proxy-check.cjs`);
  }
  const name = `awf-live-proxy-${randomUUID()}`;
  containers.add(name);
  const args = ['run', '--name', name, '--label', `${label}=${owner}`, '--network', 'none',
    '--memory', '256m', '--pids-limit', '64', '--read-only',
    '--mount', `type=bind,src=${translated(run.directory)},dst=/fixture,readonly`,
    '--mount', `type=bind,src=${translated(`${run.config.workDir}/api-proxy-logs`)},dst=/var/log/api-proxy,readonly`,
    '--mount', `type=bind,src=${translated(`${run.directory}/exchange`)},dst=/exchange`,
    ...Object.entries(harnessProxyEnvironment(run.config)).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '--entrypoint', 'node', image, '/fixture/proxy-check.cjs', JSON.stringify(options)];
  const child = docker(args);
  // Attach a rejection handler before waiting for a file rendezvous; the
  // original promise is still awaited below and failures are never hidden.
  void child.catch(() => undefined);
  if (options.pinAcrossReplacement) {
    await waitFor(`${run.directory}/exchange/pinned`);
    reportFile(run, { ...readReport(run), environment: 'docker:another-run' });
    write(`${run.directory}/exchange/replaced`, 'ready\n');
  }
  const result = await child;
  await ownedRemove(name);
  return JSON.parse(result.stdout);
}
function admission(run, report, constrained) {
  const scope = { provider: 'copilot', channel: 'copilot-cli' };
  const model = identity('copilot', 'fixture-model');
  const harnesses = constrained ? [{
    scope, name: run.context.name, minimum: '9.0.0', scheme: 'semver',
    reason: 'Test-only requirement; never added to production constraints', provenance: { authority: 'maintained' },
  }] : [];
  return createEligibilityStore({ models: [{ identity: model, harnesses }] }).pin().evaluate({
    identity: model, scope, ...eligibilityEvidence(report, scope),
  });
}
async function test(name, execute) {
  const start = Date.now();
  try {
    await execute();
    results.push({ name, status: 'passed', durationMs: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', durationMs: Date.now() - start });
    if (active) await failureDiagnostics(active);
    throw error;
  } finally {
    if (active) await finishRun();
  }
}
async function suite() {
  assert.equal(process.platform, 'linux', 'live Docker harness requires Linux');
  assert.equal(process.getuid(), 0, 'run as root for trusted report ownership');
  assert(['native', 'split-dind'].includes(topology));
  setAwfDockerHost(process.env.DOCKER_HOST);
  // Never take over an existing production-named agent on a shared daemon.
  const occupied = await docker(['ps', '-aq', '--filter', 'name=^/awf-agent$']);
  assert.equal(occupied.stdout, '', 'awf-agent already exists; refusing to alter it');
  const info = await docker(['info', '--format', '{{json .ServerVersion}}']);
  const imageId = await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  const revision = await docker(['image', 'inspect', '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]);
  assert.match(process.env.AWF_LIVE_COMMIT || '', /^[a-f0-9]{40}$/, 'exact tested commit required');
  assert.equal(revision.stdout, process.env.AWF_LIVE_COMMIT, 'agent image was not built from tested checkout');
  write(`${artifacts}/environment.json`, JSON.stringify({
    schemaVersion: 1, evidence: 'live-docker', topology,
    commit: process.env.AWF_LIVE_COMMIT, image: imageId.stdout,
    docker: JSON.parse(info.stdout), platform: process.platform, arch: process.arch,
    node: process.version, runner: prefix ? 'isolated Debian runner container' : 'GitHub-hosted Ubuntu',
    kubernetesArcDeployment: false,
  }, null, 2));
  if (prefix) {
    await test('split topology rejects unprefixed runner paths and accepts translated paths', async () => {
      const directory = fs.mkdtempSync('/tmp/awf-live-harness-topology-');
      directories.add(directory);
      write(`${directory}/sentinel`, 'runner-only-by-translated-path\n');
      const rejected = await isolatedRun(['--entrypoint', '/bin/cat',
        '--mount', `type=bind,src=${directory}/sentinel,dst=/sentinel,readonly`, image, '/sentinel'], { reject: false });
      assert.notEqual(rejected.exitCode, 0);
      assert.match(rejected.stderr, /bind source path does not exist/);
      const accepted = await isolatedRun(['--entrypoint', '/bin/cat',
        '--mount', `type=bind,src=${translated(`${directory}/sentinel`)},dst=/sentinel,readonly`, image, '/sentinel']);
      assert.equal(accepted.stdout, 'runner-only-by-translated-path');
    });
  }
  let priorReport;
  for (const [binary, version] of [['copilot', '1.2.3'], ['claude', '2.1.3'], ['codex', '0.89.0']]) {
    await test(`${binary}: real chroot context, atomic publication, legacy admission, output and exit`, async () => {
      const run = await makeRun(binary);
      assert.equal(readReport(run).reason, 'probe_pending');
      const report = await observeHarness(run.config, run.controller.probeHarness);
      write(`${artifacts}/${binary}-observation.json`, JSON.stringify(report, null, 2));
      assert.deepEqual(report, { ...run.context, status: 'observed', version, resolvedBinary: `${run.directory}/bin/${binary}` });
      assert(!fs.existsSync(run.commandFile), 'command entered before report publication/release');
      assert.equal(fs.statSync(run.reportFile).uid, 0);
      assert.equal(fs.statSync(run.reportFile).mode & 0o022, 0);
      assert.equal(admission(run, report, false).admitted, true);
      if (priorReport) assert.notEqual(priorReport.environment, report.environment);
      if (binary === 'copilot') {
        await proxyCheck(run, { status: 'observed', pinAcrossReplacement: true });
        reportFile(run, report);
      }
      priorReport = report;
      await run.controller.releaseHarness();
      assert.deepEqual(await waitExit(run), {
        exitCode: 23, stdout: 'fixture-command-output', stderr: 'fixture-command-stderr',
      });
      const probe = fs.readFileSync(`${run.directory}/workspace/probe-context`, 'utf8');
      assert.equal(probe, fs.readFileSync(run.commandFile, 'utf8'));
      const context = probe.trim().split('\n');
      assert.deepEqual(context.slice(0, 7), [
        '1001', '1002', `${run.directory}/workspace`,
        `${run.directory}/home/.npm-global/bin:${run.directory}/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        `${run.directory}/home`, 'fixture', 'fixture',
      ]);
      assert.match(context[7], /^controlled(?::startup)+$/);
      assert.deepEqual(context.slice(8), [`${run.directory}/startup`, 'non-login']);
    });
  }
  for (const [mode, reason] of [
    ['missing', 'binary_missing'], ['malformed', 'probe_output_invalid'],
    ['overflow', 'probe_output_limit'], ['overflow-newline', 'probe_output_limit'],
    ['failed', 'probe_failed'], ['timeout', 'probe_timed_out'],
  ]) {
    await test(`${mode}: sanitized unavailable evidence and unconstrained execution`, async () => {
      const run = await makeRun('copilot', mode);
      const start = Date.now();
      const report = await observeHarness(run.config, run.controller.probeHarness);
      write(`${artifacts}/${mode}-observation.json`, JSON.stringify(report, null, 2));
      assert.deepEqual(report, { ...run.context, status: 'unavailable', reason });
      assert(!JSON.stringify(report).includes('discard-this-fixture'));
      assert(!fs.existsSync(run.commandFile));
      if (mode === 'timeout') {
        assert(Date.now() - start >= 9900);
        assert(Date.now() - start < 20000);
      }
      if (mode.startsWith('overflow')) {
        const output = await docker(['exec', 'awf-agent', 'stat', '-c', '%s', '/host/run/awf-harness/probe/stdout']);
        assert.equal(Number(output.stdout), 4097);
      }
      assert.equal(admission(run, report, false).admitted, true);
      await proxyCheck(run, { status: 'unavailable', reason });
      await run.controller.releaseHarness();
      const result = await waitExit(run);
      assert.equal(result.exitCode, mode === 'missing' ? 127 : 23);
      assert.equal(fs.existsSync(run.commandFile), mode !== 'missing');
    });
  }
  for (const mode of ['valid', 'malformed']) {
    await test(`${mode}: real workflow admission recheck blocks command entry with a test-only floor`, async () => {
      const run = await makeRun('copilot', mode, { deferStart: true });
      run.config.additionalEnv = { COPILOT_MODEL: 'gpt-6-sol' };
      // Only a validator enablement signal, never sent to any container.
      run.config.copilotGithubToken = 'fixture-not-a-credential';
      const originalValidate = copilotModels.validateCopilotModel;
      copilotModels.validateCopilotModel = (model, evidence) => originalValidate(model, {
        ...evidence,
        harnesses: [{
          scope: { provider: 'copilot', channel: 'copilot-cli' },
          name: 'copilot-cli', minimum: '9.0.0', scheme: 'semver',
          reason: 'Test-only requirement', provenance: { authority: 'maintained' },
        }],
      });
      let releases = 0;
      try {
        await assert.rejects(runMainWorkflow(run.config, {
          ensureFirewallNetwork: async () => { throw new Error('networkless fixture must not set up host firewall'); },
          setupHostIptables: async () => { throw new Error('networkless fixture must not alter host rules'); },
          writeConfigs: async () => prepareHarnessObservation(run.config),
          startContainers: async () => startRun(run),
          probeHarness: run.controller.probeHarness,
          releaseHarness: async () => { releases++; await run.controller.releaseHarness(); },
          runAgentCommand: async () => { throw new Error('blocked workflow entered command waiter'); },
        }, {
          logger: { info() {}, success() {}, warn() {} },
          performCleanup: async () => finishRun(),
        }), mode === 'valid' ? /harness_incompatible/ : /harness_unverified/);
      } finally {
        copilotModels.validateCopilotModel = originalValidate;
      }
      assert.equal(releases, 0);
      const report = readReport(run);
      assert.equal(admission(run, report, true).harness, mode === 'valid' ? 'incompatible' : 'unverified');
      await new Promise(resolve => setTimeout(resolve, 250));
      assert(!fs.existsSync(run.commandFile));
      await docker(['stop', '--time', '2', 'awf-agent']);
      assert(!fs.existsSync(run.commandFile));
    });
  }
  await test('shell-pinned executable uses the corrected resolver, not the PATH candidate', async () => {
    const run = await makeRun('copilot', 'valid', { pinned: true });
    const report = await observeHarness(run.config, run.controller.probeHarness);
    assert.equal(report.resolvedBinary, `${run.directory}/pinned/copilot`);
    await run.controller.releaseHarness();
    assert.equal((await waitExit(run)).exitCode, 23);
    assert.equal(fs.readFileSync(`${run.directory}/workspace/probe-context`, 'utf8'), fs.readFileSync(run.commandFile, 'utf8'));
  });
  await test('shell function selection stays unverified while preserving legacy command execution', async () => {
    const run = await makeRun('copilot', 'valid', { function: true });
    const report = await observeHarness(run.config, run.controller.probeHarness);
    assert.equal(report.reason, 'probe_failed');
    assert(!fs.existsSync(`${run.directory}/workspace/probe-context`));
    await run.controller.releaseHarness();
    assert.equal((await waitExit(run)).exitCode, 23);
  });
  await test('wrong-run transport binding and cancellation never release a waiting command', async () => {
    const run = await makeRun();
    await run.controller.probeHarness('ignored');
    await docker(['exec', '--user', '0:0', 'awf-agent', '/bin/bash', '-c',
      'printf "docker:wrong-run\\n0\\n" >/host/run/awf-harness/probe/result']);
    const otherController = createDockerHarnessObservation(run.config, run.context);
    await assert.rejects(otherController.probeHarness('ignored'), /readiness failed/);
    await assert.rejects(otherController.releaseHarness(), /not ready/);
    const start = Date.now();
    await docker(['stop', '--time', '2', 'awf-agent']);
    assert([137, 143].includes((await waitExit(run)).exitCode));
    assert(Date.now() - start < 10000);
    assert(!fs.existsSync(run.commandFile));
  });
  await test('startup failure retains original exit and never creates a command context', async () => {
    const run = await makeRun('copilot', 'valid', { startupFailure: true });
    assert.equal((await waitExit(run)).exitCode, 1);
    await run.controller.releaseHarness();
    assert(!fs.existsSync(run.commandFile));
    const state = await docker(['inspect', '--format',
      `{{index .Config.Labels "${DOCKER_HARNESS_ENVIRONMENT_LABEL}"}}`, 'awf-agent']);
    assert.equal(state.stdout, run.context.environment);
  });
  await test('proxy trust, stale-run isolation and dedicated-enclave absence remain fail closed', async () => {
    const run = await makeRun();
    const report = await observeHarness(run.config, run.controller.probeHarness);
    reportFile(run, priorReport);
    await proxyCheck(run, { status: 'unavailable', reason: 'observation_environment_mismatch' });
    reportFile(run, report);
    fs.chmodSync(run.reportFile, 0o666);
    await proxyCheck(run, { status: 'unavailable', reason: 'observation_invalid' });
    fs.chmodSync(run.reportFile, 0o644);
    fs.chownSync(run.reportFile, 1001, 1002);
    await proxyCheck(run, { status: 'unavailable', reason: 'observation_invalid' });
    fs.chownSync(run.reportFile, 0, 0);
    fs.unlinkSync(run.reportFile);
    fs.symlinkSync(`${run.directory}/startup`, run.reportFile);
    await proxyCheck(run, { status: 'unavailable', reason: 'observation_invalid' });
    fs.unlinkSync(run.reportFile);
    // This is a separate no-network reader, not an enclave producer or run.
    // Absence of the primary binding must yield no inferred observation.
    const checked = await isolatedRun(['--read-only',
      '--mount', `type=bind,src=${translated(`${run.directory}/proxy`)},dst=/proxy,readonly`,
      '--entrypoint', 'node', image, '-e',
      "require('node:assert/strict').equal(require('/proxy/harness-observation').readHarnessObservation(), undefined)"]);
    assert.equal(checked.exitCode, 0);
  });
}

if (require.main === module) {
  fs.mkdirSync(artifacts, { recursive: true });
  let interrupted = false;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      if (interrupted) return;
      interrupted = true;
      cleanup().then(() => {
        write(`${artifacts}/results.json`, JSON.stringify({
          schemaVersion: 1, evidence: 'live-docker', topology, results,
          passed: false, interrupted: true, cleanupVerified: containers.size === 0 && directories.size === 0,
        }, null, 2));
        process.exit(code);
      }).catch(error => {
        console.error(error);
        process.exit(1);
      });
    });
  }
  suite().catch(error => {
    // Only controlled fixture assertions and bounded Docker errors are logged;
    // never inspect/dump process.env, container environment or arbitrary logs.
    console.error(error);
    process.exitCode = 1;
  }).finally(async () => {
    try { await cleanup(); } catch (error) { console.error(error); process.exitCode = 1; }
    write(`${artifacts}/results.json`, JSON.stringify({
      schemaVersion: 1, evidence: 'live-docker', topology, results,
      passed: process.exitCode !== 1, cleanupVerified: containers.size === 0 && directories.size === 0,
    }, null, 2));
  });
}
