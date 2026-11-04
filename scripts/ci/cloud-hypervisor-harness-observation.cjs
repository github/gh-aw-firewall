'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, process, __dirname, console, setTimeout, clearTimeout */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const execa = require('execa');
const { getSafeHostUid, getSafeHostGid } = require('../../dist/host-identity');
const { evaluateGithubHostedRunnerEligibility } = require('../../dist/cloud-hypervisor/host-eligibility');

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'tests/fixtures/harness-observation/cloud-hypervisor');
const secret = 'awf-ch-fixture-secret-must-not-leak';
const cases = [
  { name: 'copilot-admit', harness: 'copilot', mode: 'valid', floor: '1.2.0' },
  { name: 'claude-legacy', harness: 'claude', mode: 'valid' },
  { name: 'codex-relative', harness: 'codex', mode: 'valid', relative: true },
  { name: 'copilot-incompatible', harness: 'copilot', mode: 'valid', floor: '99.0.0', blocked: true },
  ...['missing', 'malformed', 'failed', 'overflow', 'over-boundary', 'timeout'].map(mode => ({
    name: `copilot-${mode}`, harness: 'copilot', mode, floor: '1.2.0', blocked: true,
  })),
  { name: 'copilot-boundary', harness: 'copilot', mode: 'boundary', floor: '1.2.0' },
  { name: 'copilot-unverified-legacy', harness: 'copilot', mode: 'malformed' },
  { name: 'copilot-cancel', harness: 'copilot', mode: 'cancel', cancel: true },
];
const versions = {
  copilot: ['GitHub Copilot CLI 1.2.3', '1.2.3'],
  claude: ['2.1.3 (Claude Code)', '2.1.3'],
  codex: ['codex-cli 0.89.0', '0.89.0'],
};
const reasons = {
  missing: 'binary_missing', malformed: 'probe_output_invalid', failed: 'probe_failed',
  overflow: 'probe_output_limit', 'over-boundary': 'probe_output_limit', timeout: 'probe_timed_out',
};
let phase = 'host-eligibility';
function expected(test) {
  return {
    ...test, version: versions[test.harness][1],
    binary: `${test.relative ? './' : '/workspace/'}bin/${test.harness}`,
    ...(reasons[test.mode] ? { reason: reasons[test.mode] } : {}),
  };
}
function cleanEnvironment(directory) {
  const environment = {};
  for (const key of [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SUDO_UID', 'SUDO_GID', 'SUDO_USER',
    'GITHUB_ACTIONS', 'GITHUB_SHA', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
    'RUNNER_ENVIRONMENT', 'RUNNER_TEMP', 'ImageOS', 'ImageVersion',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment, GITHUB_WORKSPACE: `${directory}/workspace`,
    AWF_CH_HARNESS_TEST: '1', AWF_CH_CASE: directory,
    AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS: '1',
    OPENAI_API_KEY: secret,
  };
}
function artifactArguments(directory) {
  const digests = Object.fromEntries(fs.readFileSync(`${directory}/SHA256SUMS`, 'utf8')
    .trim().split('\n').map(line => {
      const match = /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line);
      assert(match, 'invalid artifact digest manifest');
      return [match[2], match[1]];
    }));
  const entries = [
    ['binary', 'cloud-hypervisor'], ['kernel', 'vmlinux.bin'],
    ['rootfs', 'rootfs.ext4'], ['supervisor', 'awf-supervisor'],
  ];
  for (const name of [...entries.map(([, file]) => file), 'virtiofsd']) {
    assert.match(digests[name] || '', /^[a-f0-9]{64}$/, `missing ${name} digest`);
    assert(fs.statSync(`${directory}/${name}`).isFile(), `missing ${name} artifact`);
  }
  return {
    digests,
    args: [
      ...entries.flatMap(([flag, file]) => [
        `--cloud-hypervisor-${flag}`, `${directory}/${file}`,
        `--cloud-hypervisor-${flag}-sha256`, digests[file],
      ]),
      '--cloud-hypervisor-virtiofsd-sha256', digests.virtiofsd,
    ],
  };
}
function assertSanitizedTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), 'unexpected diagnostic symlink');
    if (entry.isDirectory()) assertSanitizedTree(filename);
    else {
      assert(entry.isFile(), 'unexpected diagnostic file type');
      assert(fs.statSync(filename).size <= 16 * 1024 * 1024, 'diagnostic file exceeds scan bound');
      const data = fs.readFileSync(filename);
      assert(!data.includes(secret), 'credential sentinel leaked into audit/proxy logs');
      assert(!data.includes('discard-this-ch'), 'raw probe output leaked into audit/proxy logs');
    }
  }
}
async function assertNoResidue() {
  // Read-only checks on the already dedicated hosted runner. Never delete or
  // kill resources by name: the production lifecycle must clean its own run.
  await execa('bash', ['-euo', 'pipefail', '-c', `
    namespaces=$(ip netns list)
    if grep -q '^awfvm-' <<<"$namespaces"; then exit 1; fi
    links=$(ip -o link show)
    if grep -Eq ' (vmh|vmn|vmt)[0-9a-f]{12}[:@]' <<<"$links"; then exit 1; fi
    rules=$(iptables -S DOCKER-USER)
    if grep -q -- '--comment awf:awf_vm_' <<<"$rules"; then exit 1; fi
    if [ -d /sys/fs/cgroup/awf-cloud-hypervisor ]; then
      entries=$(find /sys/fs/cgroup/awf-cloud-hypervisor -mindepth 1 -maxdepth 1 -type d -print)
      test -z "$entries"
    fi
    if [ -d /var/lib/awf-cloud-hypervisor/trusted-artifacts ]; then
      entries=$(find /var/lib/awf-cloud-hypervisor/trusted-artifacts -mindepth 1 -maxdepth 1 -type d -name 'run-*' -print)
      test -z "$entries"
    fi
    if [ -d /run/awf-cloud-hypervisor ]; then
      entries=$(find /run/awf-cloud-hypervisor -mindepth 2 -print)
      test -z "$entries"
    fi
    if [ -d /run/awf-microvm-network/reservations ]; then
      entries=$(find /run/awf-microvm-network/reservations -name '*.json' -print)
      test -z "$entries"
    fi
    for pattern in \
      '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[c]loud-hypervisor --api-socket' \
      '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[v]irtiofsd.*--shared-dir='; do
      status=0
      pgrep -f "$pattern" >/dev/null || status=$?
      test "$status" -eq 1
    done
  `], { timeout: 10000 });
  const containers = await execa('docker', ['ps', '-aq', '--filter', 'name=^/awf-(squid|api-proxy|agent)$']);
  assert.equal(containers.stdout, '', 'production-named container residue remains');
}
async function waitForProbe(directory, child) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (fs.existsSync(`${directory}/workspace/probe-context`)) return;
    assert.equal(child.exitCode, null, 'CLI exited before cancellation rendezvous');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('guest probe cancellation rendezvous timed out');
}
async function suite(artifactDirectory, output) {
  assert.equal(process.platform, 'linux', 'live acceptance requires Linux, not a host-version substitute');
  assert.equal(process.arch, 'x64');
  assert.equal(process.getuid(), 0, 'run using sudo on the eligible hosted runner');
  assert.equal(evaluateGithubHostedRunnerEligibility().eligible, true, 'unsupported runner');
  fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
  phase = 'artifact-admission';
  const { args, digests } = artifactArguments(artifactDirectory);
  const commit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout;
  assert.match(commit, /^[a-f0-9]{40}$/);
  if (process.env.GITHUB_SHA) assert.equal(commit, process.env.GITHUB_SHA);
  const dockerVersion = (await execa('docker', ['version', '--format', '{{.Server.Version}}'])).stdout;
  const imageIds = {};
  for (const image of ['squid', 'api-proxy']) {
    imageIds[image] = (await execa('docker', ['image', 'inspect', '--format', '{{.Id}}',
      `ghcr.io/github/gh-aw-firewall/${image}:latest`])).stdout;
  }
  const manifest = JSON.parse(fs.readFileSync(`${artifactDirectory}/manifest.json`, 'utf8'));
  assert.equal(manifest.release.sourceCommit, commit, 'guest artifacts are from another checkout');
  const artifactVersions = Object.fromEntries(Object.entries(manifest.artifacts)
    .map(([name, artifact]) => [name, artifact.version]));
  fs.writeFileSync(`${output}/environment.json`, JSON.stringify({
    schemaVersion: 1, evidence: 'live-cloud-hypervisor', commit, platform: process.platform,
    arch: process.arch, kernel: os.release(), node: process.version, docker: dockerVersion, imageIds,
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    artifactRelease: manifest.release, artifactVersions, digests, developmentArtifacts: true,
  }, null, 2));
  phase = 'residue-preflight';
  await assertNoResidue();
  phase = 'guest-cases';
  const results = [];
  const bindings = new Set();
  let active;
  let interrupted = false;
  let completed = false;
  const stopActive = () => active?.kill('SIGTERM', { forceKillAfterTimeout: 20000 });
  const interrupt = () => { interrupted = true; stopActive(); };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  try {
    for (const test of cases) {
      assert(!interrupted, 'suite interrupted');
      const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'awf-ch-harness-'));
      const start = Date.now();
      const result = { name: test.name, passed: false };
      results.push(result);
      let timer;
      let timedOut = false;
      try {
        result.stage = 'fixture-setup';
        fs.mkdirSync(`${directory}/workspace/bin`, { recursive: true });
        fs.chmodSync(directory, 0o755);
        fs.chownSync(`${directory}/workspace`, Number(getSafeHostUid()), Number(getSafeHostGid()));
        fs.writeFileSync(`${directory}/expected.json`, JSON.stringify(expected(test)));
        if (test.mode !== 'missing') {
          fs.copyFileSync(`${fixture}/executable.sh`, `${directory}/workspace/bin/${test.harness}`);
          fs.chmodSync(`${directory}/workspace/bin/${test.harness}`, 0o755);
        }
        result.stage = 'compiled-cli-lifecycle';
        active = execa(process.execPath, [
          '--require', `${fixture}/preload.cjs`, `${root}/dist/cli.js`,
          '--container-runtime', 'cloud-hypervisor', '--cloud-hypervisor-preview',
          '--cloud-hypervisor-development-allow-unattested-artifacts',
          '--network-isolation', '--cloud-hypervisor-vcpus', '1', ...args,
          '--allow-domains', 'example.com', '--skip-pull', '--enable-api-proxy',
          '--work-dir', `${directory}/work`, '--proxy-logs-dir', `${directory}/proxy-logs`,
          '--audit-dir', `${directory}/audit`,
          '--env', `FIXTURE_MODE=${test.mode}`, '--env', `FIXTURE_VERSION=${versions[test.harness][0]}`,
          '--env', 'FIXTURE_ENV=controlled-ch-environment',
          '--', `${expected(test).binary} --fixture`,
        ], {
          cwd: root, env: cleanEnvironment(directory), extendEnv: false,
          maxBuffer: 1024 * 1024, reject: false, stdin: 'ignore',
        });
        // A failed spawn must not become an unhandled rejection while waiting
        // for the guest to enter its deliberately slow --version probe.
        void active.catch(() => undefined);
        timer = setTimeout(() => { timedOut = true; stopActive(); }, 240000);
        if (test.cancel) {
          await waitForProbe(directory, active);
          stopActive();
        }
        const command = await active;
        active = undefined;
        result.stage = 'guest-evidence';
        assert(!timedOut, 'case exceeded lifecycle budget');
        const expectedExit = test.cancel ? 143 : test.blocked ? 1 : 23;
        assert.equal(command.exitCode, expectedExit, 'unexpected CLI exit');
        for (const stream of [command.stdout, command.stderr]) {
          assert(!stream.includes(secret), 'credential sentinel leaked');
          assert(!stream.includes('discard-this-ch'), 'raw probe output leaked');
        }
        assertSanitizedTree(`${directory}/audit`);
        assertSanitizedTree(`${directory}/proxy-logs`);
        const evidence = JSON.parse(fs.readFileSync(`${directory}/evidence.json`, 'utf8'));
        result.evidence = evidence;
        assert.equal(evidence.commandEntered, !test.blocked && !test.cancel);
        const commandFile = `${directory}/workspace/command-context`;
        assert.equal(fs.existsSync(commandFile), !test.blocked && !test.cancel);
        if (!test.cancel) {
          assert(evidence.proxy.mountedReport && evidence.proxy.requestPin);
          assert(!bindings.has(evidence.report.environment), 'run identity reused');
          bindings.add(evidence.report.environment);
          if (test.blocked) assert.match(command.stderr, new RegExp(evidence.blocked));
          else {
            assert(command.stdout.includes('fixture-ch-command-output'));
            assert(command.stderr.includes('fixture-ch-command-stderr'));
            const actual = fs.readFileSync(commandFile, 'utf8');
            assert.equal(actual, fs.readFileSync(`${directory}/workspace/probe-context`, 'utf8'));
            const [uid, gid, cwd, guestPath, home, fixtureEnv, runtime] = actual.trim().split('\n');
            assert.deepEqual([uid, gid, cwd, home, fixtureEnv, runtime], [
              getSafeHostUid(), getSafeHostGid(), '/workspace', '/workspace/.awf-home',
              'controlled-ch-environment', 'cloud-hypervisor',
            ]);
            assert(guestPath.length > 0);
            result.guestContextMatched = true;
            result.guestContext = { uid, gid, cwd, path: guestPath, home, fixtureEnv, runtime };
          }
        } else {
          assert(evidence.probeRequest, 'cancellation did not reach actual producer');
          result.cancelledDuringGuestProbe = true;
        }
        await assertNoResidue();
        Object.assign(result, {
          name: test.name, passed: true, stage: 'complete', cleanupVerified: true, durationMs: Date.now() - start,
        });
        console.log(`PASS ${test.name}`);
      } catch (error) {
        console.error(`FAIL ${test.name} (${result.stage})`);
        throw error;
      } finally {
        clearTimeout(timer);
        if (active) {
          stopActive();
          const [joined] = await Promise.allSettled([active]);
          if (joined.status === 'rejected') result.childWaitFailed = true;
          active = undefined;
        }
        if (fs.existsSync(`${directory}/evidence.json`)) {
          const text = fs.readFileSync(`${directory}/evidence.json`, 'utf8');
          assert(!text.includes(secret) && !text.includes('discard-this-ch'), 'unsafe fixture evidence');
          result.evidence = JSON.parse(text);
        }
        await assertNoResidue();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    completed = true;
  } finally {
    process.off('SIGTERM', interrupt);
    process.off('SIGINT', interrupt);
    fs.writeFileSync(`${output}/results.json`, JSON.stringify({
      schemaVersion: 1, evidence: 'live-cloud-hypervisor', commit,
      passed: completed && results.length === cases.length && results.every(result => result.passed) && !interrupted,
      interrupted, results,
    }, null, 2));
  }
}

if (require.main === module) {
  const artifactDirectory = path.resolve(process.argv[2] || '');
  const output = path.resolve(process.env.AWF_CH_HARNESS_ARTIFACTS || 'artifacts/cloud-hypervisor-harness-live');
  fs.mkdirSync(output, { recursive: true });
  suite(artifactDirectory, output).catch(() => {
    // Raw CLI/probe errors are deliberately not uploaded or printed.
    fs.writeFileSync(`${output}/failure.json`, JSON.stringify({
      passed: false, liveAcceptance: false, phase, platform: process.platform, arch: process.arch,
    }, null, 2));
    console.error(`Cloud Hypervisor harness acceptance failed (${phase}); inspect sanitized evidence and the failing case.`);
    process.exitCode = 1;
  });
}
module.exports = { cases, expected, artifactArguments, cleanEnvironment };
