'use strict';

// Invocation (after npm run build), from a clean, exact-SHA checkout:
// sudo -E env SUDO_UID=<runner uid> SUDO_GID=<runner gid> \
//   AWF_LIVE_COMMIT=<git HEAD> AWF_LIVE_ARTIFACTS=<evidence directory> \
//   node scripts/ci/cloud-hypervisor-harness-live.cjs ARTIFACT_DIR
// ARTIFACT_DIR contains the five artifacts, manifest.json and SHA256SUMS produced by
// build-test-artifacts.sh. Their root ownership/trust and host eligibility are
// still checked by the real backend. Squid/API-proxy images must be prepared
// before invocation; cases neither pull nor rebuild infrastructure images.
// The manifest's release.sourceCommit is attribution, not an attestation; it
// may differ from the tested driver/backend revision and is recorded separately.
// AWF_LIVE_CONSUMER_IMAGE defaults to the locally built
// ghcr.io/github/gh-aw-firewall/api-proxy:latest, labelled
// org.opencontainers.image.revision=<AWF_LIVE_COMMIT>.
// No credentials, provider calls, host executable fallback or execute stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable, Writable } = require('node:stream');

const root = path.resolve(__dirname, '../..');
const fixtureRoot = path.join(root, 'tests/fixtures/harness-observation');
const ARTIFACTS = Object.freeze({
  cloudHypervisor: 'cloud-hypervisor', virtiofsd: 'virtiofsd',
  kernel: 'vmlinux.bin', rootfs: 'rootfs.ext4', supervisor: 'awf-supervisor',
});
const CASES = Object.freeze([
  ['copilot', 'valid', '1.2.3'], ['claude', 'valid', '2.1.3'], ['codex', 'valid', '0.89.0'],
  ...Object.entries({
    missing: 'binary_missing', malformed: 'probe_output_invalid', failed: 'probe_failed',
    oversized: 'probe_output_limit', timeout: 'probe_timed_out',
  }).map(([mode, reason]) => ['copilot', mode, reason]),
]);
const quiet = { debug() {}, info() {}, warn() {}, success() {} };
class Blocked extends Error {}
function failPrerequisite(condition, code) {
  if (!condition) throw new Blocked(code);
}
function command(file, args) {
  return execFileSync(file, args, { cwd: root, encoding: 'utf8', timeout: 30000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function requireImage(reference, unavailableCode, inspect = command) {
  try { return inspect('docker', ['image', 'inspect', '--format', '{{.Id}}', reference]); }
  catch { throw new Blocked(unavailableCode); }
}
function parsePins(text) {
  const pins = {};
  for (const [key, filename] of Object.entries(ARTIFACTS)) {
    const matches = text.split('\n').filter(line => line.endsWith(`  ${filename}`));
    failPrerequisite(matches.length === 1 && /^[a-f0-9]{64}  [\w.-]+$/.test(matches[0]),
      'artifact-manifest-invalid');
    pins[key] = matches[0].slice(0, 64);
  }
  return pins;
}
async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function loadArtifacts(directory) {
  failPrerequisite(Boolean(directory) && fs.existsSync(directory), 'artifact-directory-missing');
  directory = fs.realpathSync(directory);
  let pins;
  try { pins = parsePins(fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8')); }
  catch { throw new Blocked('artifact-manifest-invalid'); }
  const manifestFile = path.join(directory, 'manifest.json');
  let manifest;
  try {
    const stat = fs.lstatSync(manifestFile);
    failPrerequisite(stat.isFile() && stat.size <= 65536, 'artifact-manifest-invalid');
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch { throw new Blocked('artifact-manifest-invalid'); }
  const artifactSourceCommit = manifest?.release?.sourceCommit;
  checkArtifactSourceCommit(artifactSourceCommit);
  for (const [key, filename] of Object.entries(ARTIFACTS)) {
    failPrerequisite(manifest.artifacts?.[key]?.file === filename
      && manifest.artifacts[key].sha256 === pins[key], 'artifact-manifest-digest-mismatch');
    const full = path.join(directory, filename);
    failPrerequisite(fs.existsSync(full) && fs.lstatSync(full).isFile(), 'artifact-file-invalid');
    failPrerequisite(await digest(full) === pins[key], 'artifact-digest-mismatch');
  }
  return { directory, pins, artifactSourceCommit, manifestSha256: await digest(manifestFile) };
}
function checkCheckout(commit, head, status) {
  failPrerequisite(/^[a-f0-9]{40}$/.test(commit || '') && commit === head, 'checkout-sha-mismatch');
  failPrerequisite(status === '', 'checkout-tracked-dirty');
}
function checkArtifactSourceCommit(value) {
  failPrerequisite(/^[a-f0-9]{40}$/.test(value || ''), 'artifact-source-commit-required');
}
function checkHost(env = process.env, uid = process.getuid?.()) {
  failPrerequisite(process.platform === 'linux' && process.arch === 'x64', 'host-platform-unsupported');
  failPrerequisite(uid === 0, 'root-required');
  failPrerequisite(/^[1-9]\d*$/.test(env.SUDO_UID || '') && /^[1-9]\d*$/.test(env.SUDO_GID || ''),
    'original-user-required');
  failPrerequisite(Number(env.SUDO_UID) < 2147483648 && Number(env.SUDO_GID) < 2147483648,
    'original-user-invalid');
  failPrerequisite(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && /^ubuntu/i.test(env.ImageOS || ''), 'github-hosted-ubuntu-required');
  failPrerequisite(fs.existsSync('/dev/kvm'), 'kvm-missing');
}
function output() {
  let text = '';
  return {
    stream: new Writable({ write(chunk, _encoding, done) {
      if (Buffer.byteLength(text) + chunk.length > 4096) return done(new Error('command-output-limit'));
      text += chunk.toString(); done();
    } }),
    text: () => text,
  };
}
async function waitFor(filename, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (!fs.existsSync(filename) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(fs.existsSync(filename), 'fixture rendezvous failed');
}
function list(directory, predicate = () => true) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(predicate).sort();
}
function runResources(directory) {
  const parents = new Set(['cloud-hypervisor', 'virtiofsd', 'pending-cleanup', 'enclave-storage']);
  return list(directory).flatMap(name => parents.has(name)
    ? list(path.join(directory, name)).map(child => `${name}/${child}`)
    : [name]).sort();
}
function resourceSnapshot() {
  return {
    namespaces: command('ip', ['netns', 'list']).split('\n').filter(line => /^awfvm-/.test(line)).sort(),
    cgroups: list('/sys/fs/cgroup/awf-cloud-hypervisor',
      name => fs.statSync(`/sys/fs/cgroup/awf-cloud-hypervisor/${name}`).isDirectory()),
    // Empty runtime-owned parents persist after the first launch. Compare
    // per-run children instead, while retaining unexpected entries/lock dirs.
    runs: runResources('/run/awf-cloud-hypervisor'),
    snapshots: list('/var/lib/awf-cloud-hypervisor/trusted-artifacts', name => name.startsWith('run-')),
    reservations: list('/run/awf-microvm-network/reservations', name => name.endsWith('.json')),
    containers: command('docker', ['ps', '-aq', '--filter', 'name=^/awf-']).split('\n').filter(Boolean).sort(),
    networks: command('docker', ['network', 'ls', '-q', '--filter', 'name=awf']).split('\n').filter(Boolean).sort(),
    links: command('ip', ['-o', 'link', 'show']).split('\n')
      .filter(line => / (vmh|vmn|vmt)[0-9a-f]{12}[:@]/.test(line)).sort(),
    processes: command('ps', ['-eo', 'pid=,args=']).split('\n')
      .filter(line => /\/var\/lib\/awf-cloud-hypervisor\/trusted-artifacts\/run-[^/]+\/(?:cloud-hypervisor --api-socket|virtiofsd)/.test(line))
      .sort(),
  };
}
function replaceReport(filename, report) {
  const temporary = `${filename}.${randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify(report), { mode: 0o644 });
  fs.renameSync(temporary, filename);
}
function guestContextEvidence(probe, commandContext, { uid, gid, hostBootId }) {
  assert.equal(probe, commandContext);
  const lines = probe.trim().split('\n');
  assert.equal(lines.length, 9);
  assert.deepEqual(lines.slice(0, 3), [uid, gid, '/workspace']);
  assert(lines[3].split(':').includes('/workspace'));
  assert.deepEqual(lines.slice(4, 8),
    ['/workspace/.awf-home', 'cloud-hypervisor', 'controlled', 'profile-loaded']);
  assert.match(lines[8], /^[a-f0-9-]{36}$/);
  assert.match(hostBootId, /^[a-f0-9-]{36}$/);
  assert.notEqual(lines[8], hostBootId);
  return Object.freeze({
    uid: Number(lines[0]), gid: Number(lines[1]), cwd: lines[2], path: lines[3], home: lines[4],
    runtime: lines[5], fixtureEnvironment: lines[6], loginProfile: lines[7],
    guestBootId: lines[8], hostBootId, commandProbeContextMatched: true,
  });
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const evidence = path.resolve(env.AWF_LIVE_ARTIFACTS || path.join(root, 'artifacts/harness-cloud-hypervisor'));
  fs.mkdirSync(evidence, { recursive: true, mode: 0o755 });
  const results = [];
  let status = 'blocked';
  let code = 'prerequisite-failed';
  let active;
  let scratch;
  let before;
  let cleanupVerified = false;
  let aborted = false;
  const originalCwd = process.cwd();
  const originalWorkspace = process.env.GITHUB_WORKSPACE;
  const originalBypass = process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS;
  const save = (name, value) => fs.writeFileSync(path.join(evidence, name),
    `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  const summary = () => save('results.json', {
    schemaVersion: 1, evidence: 'live-cloud-hypervisor', status, code,
    passed: status === 'passed', cleanupVerified, results,
  });
  const environmentBase = {
    schemaVersion: 1, evidence: 'live-cloud-hypervisor',
    commit: /^[a-f0-9]{40}$/.test(env.AWF_LIVE_COMMIT || '') ? env.AWF_LIVE_COMMIT : null,
    artifactSourceCommit: null,
    platform: process.platform, arch: process.arch, node: process.version, kernel: os.release(),
    githubActions: env.GITHUB_ACTIONS === 'true',
    githubHosted: env.RUNNER_ENVIRONMENT === 'github-hosted',
    ubuntu: /^ubuntu/i.test(env.ImageOS || ''),
  };
  save('environment.json', environmentBase);
  summary(); // Even omitted/missing ARTIFACT_DIR must leave non-passing evidence.
  let watchdog;
  let shutdownWatchdog;
  const stop = async () => {
    if (!active) return;
    try {
      await active.backend.stop();
      await active.backend.stop();
    } finally {
      if (fs.existsSync(path.join(active.config.workDir, 'docker-compose.yml'))) {
        await active.docker.stopContainers(active.config.workDir, false);
      }
    }
    active = undefined;
  };
  const interrupted = () => {
    aborted = true;
    status = 'failed'; code = 'interrupted'; summary();
    // The normal finally block performs scoped cleanup after shutdown rejects
    // the active boot/probe/command, rather than racing a second teardown.
    if (active) void active.backend.stop().catch(() => undefined);
    shutdownWatchdog ||= setTimeout(() => {
      status = 'failed'; code = 'shutdown-timeout'; summary(); process.exit(1);
    }, 30000);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const artifacts = await loadArtifacts(argv[0]);
    save('environment.json', {
      ...environmentBase, artifactSourceCommit: artifacts.artifactSourceCommit,
      artifactManifestSha256: artifacts.manifestSha256, artifacts: artifacts.pins,
    });
    checkCheckout(env.AWF_LIVE_COMMIT, command('git', ['rev-parse', 'HEAD']),
      command('git', ['status', '--porcelain', '--untracked-files=no']));
    checkHost(env);
    failPrerequisite(fs.existsSync(path.join(root, 'dist/cloud-hypervisor/runtime-backend.js')), 'build-missing');
    const image = env.AWF_LIVE_CONSUMER_IMAGE || 'ghcr.io/github/gh-aw-firewall/api-proxy:latest';
    const imageId = requireImage(image, 'consumer-image-missing');
    failPrerequisite(command('docker', ['image', 'inspect', '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]) === env.AWF_LIVE_COMMIT,
    'consumer-image-sha-mismatch');
    const squidImage = 'ghcr.io/github/gh-aw-firewall/squid:latest';
    const squidImageId = requireImage(squidImage, 'squid-image-unavailable');
    const squidSourceDigests = JSON.parse(command('docker', ['image', 'inspect', '--format',
      '{{json .RepoDigests}}', squidImage]) || '[]') || [];
    failPrerequisite(Array.isArray(squidSourceDigests) && squidSourceDigests.every(value =>
      typeof value === 'string' && /^ghcr\.io\/github\/gh-aw-firewall\/squid@sha256:[a-f0-9]{64}$/.test(value)),
    'squid-image-digest-invalid');
    const apiProxyImage = 'ghcr.io/github/gh-aw-firewall/api-proxy:latest';
    const apiProxyImageId = requireImage(apiProxyImage, 'api-proxy-image-unavailable');
    failPrerequisite(command('docker', ['image', 'inspect', '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}', apiProxyImage]) === env.AWF_LIVE_COMMIT,
    'api-proxy-image-sha-mismatch');
    failPrerequisite(command('docker', ['ps', '-aq', '--filter', 'name=^/awf-']) === '',
      'existing-awf-containers');
    before = resourceSnapshot();
    const docker = require(path.join(root, 'dist/docker-manager'));
    const { cloudHypervisorRuntimeTestHelpers: helpers } = require(path.join(root, 'dist/cloud-hypervisor/runtime-backend'));
    const { runMainWorkflow } = require(path.join(root, 'dist/cli-workflow'));
    const observation = require(path.join(root, 'dist/harness-observation'));
    const models = require(path.join(root, 'dist/copilot-model'));
    require(path.join(root, 'dist/logger')).logger.setLevel('error');
    scratch = fs.mkdtempSync(path.join(evidence, '.runs-'));
    fs.chmodSync(scratch, 0o755);
    process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS = '1';
    save('environment.json', {
      schemaVersion: 1, evidence: 'live-cloud-hypervisor', commit: env.AWF_LIVE_COMMIT,
      artifactSourceCommit: artifacts.artifactSourceCommit, artifactManifestSha256: artifacts.manifestSha256,
      artifacts: artifacts.pins, consumerImage: imageId, platform: process.platform, arch: process.arch,
      infrastructureImages: {
        squid: { id: squidImageId, sourceDigests: squidSourceDigests },
        apiProxy: { id: apiProxyImageId, revision: env.AWF_LIVE_COMMIT },
      },
      node: process.version, kernel: os.release(), runner: 'github-hosted-ubuntu',
      imageOS: /^ubuntu\d+$/.test(env.ImageOS || '') ? env.ImageOS : 'ubuntu',
      uid: Number(env.SUDO_UID), gid: Number(env.SUDO_GID), developmentUnattestedArtifacts: true,
    });
    status = 'failed'; code = 'live-suite-incomplete'; summary();
    watchdog = setTimeout(() => {
      code = 'suite-timeout'; interrupted();
    }, 17 * 60 * 1000);
    function makeRun(binary = 'copilot', mode = 'valid') {
      const directory = fs.mkdtempSync(path.join(scratch, 'case-'));
      fs.chmodSync(directory, 0o755);
      const workspace = path.join(directory, 'workspace');
      fs.mkdirSync(workspace, { mode: 0o755 });
      fs.chownSync(workspace, Number(env.SUDO_UID), Number(env.SUDO_GID));
      fs.mkdirSync(path.join(workspace, '.awf-home'), { mode: 0o755 });
      fs.chownSync(path.join(workspace, '.awf-home'), Number(env.SUDO_UID), Number(env.SUDO_GID));
      fs.writeFileSync(path.join(workspace, '.awf-home/.profile'),
        'export FIXTURE_LOGIN=profile-loaded\nexport PATH="/workspace:/usr/sbin:/usr/bin:/sbin:/bin"\n');
      if (mode !== 'missing') {
        fs.copyFileSync(path.join(fixtureRoot, 'cloud-hypervisor-executable.sh'), path.join(workspace, binary));
        fs.chmodSync(path.join(workspace, binary), 0o755);
      }
      process.chdir(workspace);
      process.env.GITHUB_WORKSPACE = workspace;
      const config = {
        workDir: path.join(directory, 'control'), allowedDomains: [], logLevel: 'error',
        keepContainers: false, enableApiProxy: true, networkIsolation: true, buildLocal: false,
        skipPull: true, imageRegistry: 'ghcr.io/github/gh-aw-firewall', imageTag: 'latest',
        containerRuntime: 'cloud-hypervisor', agentCommand: `/workspace/${binary} --fixture`,
        cloudHypervisor: {
          previewEnabled: true, mountPolicy: 'workspace-only',
          cloudHypervisorBinary: path.join(artifacts.directory, 'cloud-hypervisor'),
          kernelPath: path.join(artifacts.directory, 'vmlinux.bin'),
          rootfsPath: path.join(artifacts.directory, 'rootfs.ext4'),
          supervisorPath: path.join(artifacts.directory, 'awf-supervisor'),
          developmentAllowUnattestedArtifacts: true, sha256: artifacts.pins,
          vcpuCount: 1, memoryMib: 512, apiTimeoutMs: 5000,
        },
        additionalEnv: {
          FIXTURE_DIRECTORY: '/workspace', FIXTURE_ENV: 'controlled', FIXTURE_MODE: mode,
          FIXTURE_VERSION: { copilot: 'GitHub Copilot CLI 1.2.3', claude: '2.1.3 (Claude Code)',
            codex: 'codex-cli 0.89.0' }[binary],
        },
      };
      const stdout = output(), stderr = output();
      const dependencies = helpers.defaultDependencies(docker.startContainers);
      // Only transport streams are controlled; manager, preflight, exports,
      // identity, infrastructure resolution and execution are production code.
      Object.assign(dependencies, { stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream });
      const backend = helpers.createBackendWithDependencies(config, dependencies);
      active = { config, backend, docker };
      return {
        config, backend, workspace, stdout, stderr,
        reportFile: path.join(config.workDir, 'api-proxy-logs/harness-observation.json'),
        context: observation.harnessContext(config),
      };
    }
    function report(run) { return JSON.parse(fs.readFileSync(run.reportFile, 'utf8')); }
    function assertContext(run, evidenceName = `${path.basename(run.context.binary)}-${run.config.additionalEnv.FIXTURE_MODE}`) {
      const probe = fs.readFileSync(path.join(run.workspace, 'probe-context'), 'utf8');
      const context = guestContextEvidence(probe,
        fs.readFileSync(path.join(run.workspace, 'command-context'), 'utf8'), {
          uid: env.SUDO_UID, gid: env.SUDO_GID,
          hostBootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
        });
      save(`${evidenceName}-context.json`, {
        schemaVersion: 1, evidence: 'live-cloud-hypervisor',
        observationEnvironment: run.context.environment, selectedHarness: run.context.name,
        selectedBinary: run.context.binary, ...context,
      });
    }
    async function test(name, execute) {
      assert(!aborted, 'suite interrupted');
      const start = Date.now();
      try {
        await execute();
        await stop();
        assert.deepEqual(resourceSnapshot(), before);
        results.push({ name, status: 'passed', durationMs: Date.now() - start });
      } catch {
        results.push({ name, status: 'failed', code: 'live-assertion-or-infrastructure-failed',
          durationMs: Date.now() - start });
        throw new Error('live-case-failed');
      } finally { summary(); }
    }
    async function start(run) {
      await docker.writeConfigs(run.config);
      assert.equal(report(run).reason, 'probe_pending');
      await run.backend.start(run.config.workDir, [], undefined, true);
    }
    async function proxyCheck(run, options, binding = {}) {
      const directory = path.dirname(run.workspace);
      const fixture = path.join(directory, 'cloud-hypervisor-proxy-check.cjs');
      if (!fs.existsSync(fixture)) {
        fs.copyFileSync(path.join(fixtureRoot, 'cloud-hypervisor-proxy-check.cjs'), fixture);
        fs.mkdirSync(path.join(directory, 'exchange'), { mode: 0o777 });
        fs.chmodSync(path.join(directory, 'exchange'), 0o777);
      }
      const name = `awf-harness-reader-${randomUUID()}`;
      const execa = require('execa');
      const child = execa('docker', ['run', '--name', name, '--network', 'none', '--read-only',
        '--memory', '256m', '--cpus', '1', '--pids-limit', '64',
        '--mount', `type=bind,src=${directory},dst=/fixture,readonly`,
        '--mount', `type=bind,src=${path.dirname(run.reportFile)},dst=/var/log/api-proxy,readonly`,
        '--mount', `type=bind,src=${directory}/exchange,dst=/exchange`,
        ...Object.entries({ ...observation.harnessProxyEnvironment(run.config), ...binding })
          .flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        '--entrypoint', 'node', imageId, '/fixture/cloud-hypervisor-proxy-check.cjs', JSON.stringify(options)],
      { timeout: 20000, maxBuffer: 4096 });
      void child.catch(() => undefined);
      try {
        if (options.pinAcrossReplacement) {
          await waitFor(path.join(directory, 'exchange/pinned'));
          replaceReport(run.reportFile, { ...report(run), environment: 'cloud-hypervisor:other' });
          fs.writeFileSync(path.join(directory, 'exchange/replaced'), 'ready\n');
        }
        const checked = JSON.parse((await child).stdout);
        assert.equal(checked.pinned, true);
        assert.equal(checked.request, true);
        assert.equal(checked.legacyAdmitted, true);
        assert.equal(checked.legacyHarness, 'unconstrained');
        if (options.pinAcrossReplacement) {
          assert.equal(checked.routing, true);
          assert.equal(checked.classifierAttempts, 2);
        }
        if (Object.keys(binding).length === 0) {
          save(`${path.basename(run.context.binary)}-${run.config.additionalEnv.FIXTURE_MODE}-consumer.json`, {
            schemaVersion: 1, evidence: 'live-cloud-hypervisor', observationEnvironment: run.context.environment,
            legacyAdmitted: true, legacyHarness: 'unconstrained', requestPinned: true,
            routingPinned: checked.routing === true, classifierAttempts: checked.routing ? 2 : null,
          });
        }
      } finally {
        // Unique name created solely by this driver; never remove a shared name.
        command('docker', ['rm', '-f', name]);
      }
    }
    for (const [binary, mode, expected] of CASES) {
      await test(`${binary}-${mode}`, async () => {
        const run = makeRun(binary, mode);
        await start(run);
        const started = Date.now();
        const observed = await observation.observeHarness(run.config, async commandText => {
          const value = await run.backend.probeHarness(commandText);
          if (mode === 'oversized') {
            assert.equal(Buffer.byteLength(value.stdout), 4097);
            assert(value.stdout.endsWith('\n'));
          }
          return value;
        });
        const expectedReport = mode === 'valid'
          ? { ...run.context, status: 'observed', version: expected, resolvedBinary: `/workspace/${binary}` }
          : { ...run.context, status: 'unavailable', reason: expected };
        assert.deepEqual(observed, expectedReport);
        assert.deepEqual(report(run), expectedReport);
        assert(!fs.existsSync(path.join(run.workspace, 'command-context')));
        const stat = fs.lstatSync(run.reportFile);
        assert(stat.isFile()); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o022, 0);
        assert(!JSON.stringify(observed).includes('discard-this-fixture'));
        if (mode === 'timeout') assert(Date.now() - started >= 9900 && Date.now() - started < 20000);
        save(`${binary}-${mode}-observation.json`, observed);
        if (mode !== 'valid') await proxyCheck(run, { status: 'unavailable', reason: expected });
        if (binary === 'copilot' && mode === 'valid') {
          await proxyCheck(run, { status: 'observed', pinAcrossReplacement: true });
          replaceReport(run.reportFile, observed);
          for (const binding of [
            { AWF_HARNESS_ENVIRONMENT: 'cloud-hypervisor:wrong' },
            { AWF_SELECTED_HARNESS: 'claude-code' },
            { AWF_HARNESS_ENVIRONMENT: 'cloud-hypervisor:enclave-subject' },
          ]) {
            await proxyCheck(run, { status: 'unavailable', reason: binding.AWF_SELECTED_HARNESS
              ? 'observation_harness_mismatch' : 'observation_environment_mismatch' }, binding);
          }
          // A dedicated-enclave consumer must not infer primary-agent evidence
          // even if its filesystem happens to contain the primary report.
          await proxyCheck(run, { absent: true }, {
            AWF_HARNESS_ENVIRONMENT: '', AWF_SELECTED_HARNESS: '', AWF_HARNESS_BINARY: '',
          });
        }
        const result = await run.backend.exec(run.config.workDir, []);
        assert.equal(result.exitCode, mode === 'missing' ? 127 : 23);
        if (mode !== 'missing') {
          assert.equal(run.stdout.text(), 'fixture-command-output\n');
          assert.equal(run.stderr.text(), 'fixture-command-stderr\n');
          assertContext(run);
        } else assert(!fs.existsSync(path.join(run.workspace, 'command-context')));
      });
    }
    for (const [mode, minimum, rejection] of [
      ['valid', '1.0.0', undefined], ['valid', '9.0.0', /harness_incompatible/],
      ['malformed', '9.0.0', /harness_unverified/],
    ]) {
      await test(`workflow-${mode}-${minimum}`, async () => {
        const run = makeRun('copilot', mode);
        run.config.additionalEnv.COPILOT_MODEL = 'gpt-6-sol';
        // Validator signal only; added after config/environment construction.
        // Never introduce even a fake credential into the sidecar or guest.
        const original = models.validateCopilotModel;
        models.validateCopilotModel = (model, evidence) => original(model, { ...evidence, harnesses: [{
          scope: { provider: 'copilot', channel: 'copilot-cli' }, name: 'copilot-cli',
          minimum, scheme: 'semver', reason: 'Test-owned acceptance constraint',
          provenance: { authority: 'maintained' },
        }] });
        let commandEntered = false;
        try {
          const execution = runMainWorkflow(run.config, {
            writeConfigs: docker.writeConfigs,
            startContainers: run.backend.start,
            probeHarness: async commandText => {
              const value = await run.backend.probeHarness(commandText);
              run.config.copilotGithubToken = 'fixture-validator-signal';
              return value;
            },
            runAgentCommand: async (...args) => { commandEntered = true; return run.backend.exec(...args); },
          }, { logger: quiet, performCleanup: stop });
          if (rejection) await assert.rejects(execution, rejection);
          else assert.equal(await execution, 23);
          assert.equal(commandEntered, !rejection);
          assert.equal(fs.existsSync(path.join(run.workspace, 'command-context')), !rejection);
          if (!rejection) assertContext(run, `workflow-${mode}-${minimum}`);
        } finally { models.validateCopilotModel = original; }
      });
    }
    await test('cancel-active-probe', async () => {
      const run = makeRun('copilot', 'timeout');
      await start(run);
      const pending = observation.observeHarness(run.config, run.backend.probeHarness);
      void pending.catch(() => undefined);
      await waitFor(path.join(run.workspace, 'probe-context'));
      const started = Date.now();
      await run.backend.stop();
      const observed = await pending;
      assert.equal(observed.status, 'unavailable');
      assert(Date.now() - started < 20000);
      await assert.rejects(run.backend.exec(run.config.workDir, []), /not ready/);
      assert(!fs.existsSync(path.join(run.workspace, 'command-context')));
    });
    await test('startup-rejects-corrupt-artifact', async () => {
      const run = makeRun();
      run.config.cloudHypervisor.sha256 = { ...artifacts.pins, kernel: '0'.repeat(64) };
      await docker.writeConfigs(run.config);
      await assert.rejects(run.backend.start(run.config.workDir, [], undefined, true),
        /guest kernel.*SHA-256 mismatch/);
      assert(!fs.existsSync(path.join(run.workspace, 'probe-context')));
      assert(!fs.existsSync(path.join(run.workspace, 'command-context')));
    });
    assert(!aborted && results.length === CASES.length + 5 && results.every(result => result.status === 'passed'));
    status = 'passed'; code = 'completed';
  } catch (error) {
    if (error instanceof Blocked) { status = 'blocked'; code = error.message; }
    else if (status === 'blocked') code = 'prerequisite-unavailable';
    else { status = 'failed'; code = 'live-assertion-or-infrastructure-failed'; }
  } finally {
    clearTimeout(watchdog);
    shutdownWatchdog ||= setTimeout(() => {
      status = 'failed'; code = 'cleanup-timeout'; summary(); process.exit(1);
    }, 30000);
    try {
      await stop();
      if (before) { assert.deepEqual(resourceSnapshot(), before); cleanupVerified = true; }
    } catch { status = 'failed'; code = 'cleanup-failed'; }
    clearTimeout(shutdownWatchdog);
    process.chdir(originalCwd);
    if (originalWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = originalWorkspace;
    if (originalBypass === undefined) delete process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS;
    else process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS = originalBypass;
    if (scratch && cleanupVerified) fs.rmSync(scratch, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    summary();
  }
  return status === 'passed' ? 0 : 1;
}
module.exports = {
  main, parsePins, loadArtifacts, checkCheckout, checkArtifactSourceCommit, checkHost, runResources, CASES, ARTIFACTS,
  guestContextEvidence,
  requireImage,
};
if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    // Do not emit arbitrary backend errors, metadata, environments or argv.
    process.stderr.write('cloud-hypervisor-harness-evidence-write-failed\n');
    process.exitCode = 1;
  });
}
