import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import vm from 'vm';
import execa from 'execa';

// These are deterministic driver/fixture checks, not guest or KVM acceptance.
const root = path.resolve(__dirname, '../..');
const driverPath = path.join(__dirname, 'cloud-hypervisor-harness-live.cjs');
const driver = require('./cloud-hypervisor-harness-live.cjs');
const source = fs.readFileSync(driverPath, 'utf8');
const fixture = path.join(root, 'tests/fixtures/harness-observation/cloud-hypervisor-executable.sh');
const scratch = fs.mkdtempSync(path.join(root, '.harness-driver-test-'));
const sha = 'a'.repeat(40);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let sequence = 0;
function directory() {
  const result = path.join(scratch, `case-${sequence++}`);
  fs.mkdirSync(result);
  return result;
}
function artifacts() {
  const result = directory();
  const lines: string[] = [];
  for (const filename of Object.values(driver.ARTIFACTS) as string[]) {
    fs.writeFileSync(path.join(result, filename), filename);
    lines.push(`${digest(filename)}  ${filename}`);
  }
  fs.writeFileSync(path.join(result, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(result, 'manifest.json'), JSON.stringify({
    release: { sourceCommit: 'b'.repeat(40) },
    artifacts: Object.fromEntries(Object.entries(driver.ARTIFACTS).map(([key, file]) =>
      [key, { file, sha256: digest(file as string) }])),
  }));
  return result;
}
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('Cloud Hypervisor harness acceptance driver (deterministic, not live proof)', () => {
  it('pins exactly the five build artifacts and verifies their real bytes', async () => {
    const result = await driver.loadArtifacts(artifacts());
    expect(Object.keys(result.pins)).toEqual(['cloudHypervisor', 'virtiofsd', 'kernel', 'rootfs', 'supervisor']);
    expect(result.pins.kernel).toBe(digest('vmlinux.bin'));
    expect(result.artifactSourceCommit).toBe('b'.repeat(40));
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['missing', 'duplicate', 'malformed'])('rejects %s digest entries', async mode => {
    const result = artifacts();
    const file = path.join(result, 'SHA256SUMS');
    let text = fs.readFileSync(file, 'utf8');
    if (mode === 'missing') text = text.split('\n').filter(line => !line.endsWith('  virtiofsd')).join('\n');
    if (mode === 'duplicate') text += `${digest('virtiofsd')}  virtiofsd\n`;
    if (mode === 'malformed') text = text.replace(digest('virtiofsd'), 'not-a-digest');
    fs.writeFileSync(file, text);
    await expect(driver.loadArtifacts(result)).rejects.toThrow('artifact-manifest-invalid');
  });

  it('rejects tampered bytes, missing files and symlinked artifacts before launch', async () => {
    for (const mode of ['tampered', 'missing', 'symlink']) {
      const result = artifacts();
      const file = path.join(result, 'awf-supervisor');
      if (mode === 'tampered') fs.writeFileSync(file, 'changed');
      else {
        fs.unlinkSync(file);
        if (mode === 'symlink') fs.symlinkSync(path.join(result, 'virtiofsd'), file);
      }
      await expect(driver.loadArtifacts(result)).rejects.toThrow(
        mode === 'tampered' ? 'artifact-digest-mismatch' : 'artifact-file-invalid',
      );
    }
  });

  it('requires exact HEAD and a clean tracked checkout, not a branch or prefix', () => {
    expect(() => driver.checkCheckout(sha, sha, '')).not.toThrow();
    for (const commit of [undefined, 'main', sha.slice(0, 7), 'b'.repeat(40)]) {
      expect(() => driver.checkCheckout(commit, sha, '')).toThrow('checkout-sha-mismatch');
    }
    expect(() => driver.checkCheckout(sha, sha, ' M src/cli.ts')).toThrow('checkout-tracked-dirty');
  });

  it('requires an exact artifact source SHA without equating it to tested HEAD', () => {
    expect(() => driver.checkArtifactSourceCommit('b'.repeat(40))).not.toThrow();
    for (const value of [undefined, 'main', sha.slice(0, 7), 'sensitive-untrusted-source']) {
      expect(() => driver.checkArtifactSourceCommit(value)).toThrow('artifact-source-commit-required');
    }
  });

  it('records artifact source and tested revisions separately, including blocked evidence', async () => {
    const evidence = directory();
    const artifactSourceCommit = 'b'.repeat(40);
    const result = await execa(process.execPath, [driverPath, artifacts()], {
      reject: false, timeout: 5000,
      env: { AWF_LIVE_ARTIFACTS: evidence, AWF_LIVE_COMMIT: sha,
        AWF_LIVE_ARTIFACT_SOURCE_SHA: 'c'.repeat(40) },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(evidence, 'environment.json'), 'utf8')))
      .toMatchObject({ commit: sha, artifactSourceCommit });
  });

  it('rejects missing manifest source and manifest/checksum disagreement', async () => {
    for (const mode of ['missing-source', 'wrong-digest', 'missing-manifest']) {
      const work = artifacts();
      const file = path.join(work, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (mode === 'missing-source') delete manifest.release.sourceCommit;
      if (mode === 'wrong-digest') manifest.artifacts.kernel.sha256 = '0'.repeat(64);
      fs.writeFileSync(file, JSON.stringify(manifest));
      if (mode === 'missing-manifest') fs.unlinkSync(file);
      await expect(driver.loadArtifacts(work)).rejects.toThrow(mode === 'missing-source'
        ? 'artifact-source-commit-required' : mode === 'wrong-digest'
          ? 'artifact-manifest-digest-mismatch' : 'artifact-manifest-invalid');
    }
  });

  it('ignores persistent empty runtime parents but detects stranded runs and locks', () => {
    const result = directory();
    for (const name of ['cloud-hypervisor', 'virtiofsd', 'pending-cleanup']) {
      fs.mkdirSync(path.join(result, name));
    }
    expect(driver.runResources(result)).toEqual([]);
    fs.mkdirSync(path.join(result, 'cloud-hypervisor/stranded'));
    fs.writeFileSync(path.join(result, 'pending-cleanup/stranded.json'), '{}');
    fs.mkdirSync(path.join(result, '.account-lock'));
    expect(driver.runResources(result)).toEqual([
      '.account-lock', 'cloud-hypervisor/stranded', 'pending-cleanup/stranded.json',
    ]);
  });

  it('does not silently invent GitHub-hosted identity or original sudo identity', () => {
    expect(() => driver.checkHost({}, 0)).toThrow('original-user-required');
    expect(() => driver.checkHost({ SUDO_UID: '0', SUDO_GID: '1000' }, 0)).toThrow('original-user-required');
    expect(() => driver.checkHost({ SUDO_UID: '1000', SUDO_GID: '1000' }, 1000)).toThrow('root-required');
    expect(() => driver.checkHost({
      SUDO_UID: '1000', SUDO_GID: '1000', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted',
      ImageOS: 'ubuntu24',
    }, 0)).toThrow('github-hosted-ubuntu-required');
  });

  it.each([undefined, 'absent'])('writes non-passing sanitized evidence for missing artifacts (%s)', async argument => {
    const evidence = directory();
    const result = await execa(process.execPath, [driverPath, ...(argument ? [path.join(scratch, argument)] : [])], {
      reject: false, timeout: 5000,
      env: { AWF_LIVE_ARTIFACTS: evidence, AWF_LIVE_COMMIT: 'raw-secret-must-not-be-published',
        UNRELATED_SECRET: 'another-secret' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    const text = fs.readFileSync(path.join(evidence, 'results.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      status: 'blocked', passed: false, code: 'artifact-directory-missing', cleanupVerified: false, results: [],
    });
    const environment = fs.readFileSync(path.join(evidence, 'environment.json'), 'utf8');
    expect(JSON.parse(environment).commit).toBeNull();
    expect(text + environment).not.toMatch(/raw-secret|another-secret|UNRELATED_SECRET/);
  });

  it('keeps the production manager, preflight, exports, identity and lifecycle wiring', () => {
    expect(source).toContain('helpers.defaultDependencies(docker.startContainers)');
    expect(source).toContain('helpers.createBackendWithDependencies(config, dependencies)');
    expect(source).toContain('await docker.writeConfigs(run.config)');
    expect(source).toContain('await active.docker.stopContainers(active.config.workDir, false)');
    expect(source).toContain('runMainWorkflow(run.config');
    expect(source).toContain("process.env.GITHUB_WORKSPACE = workspace");
    expect(source).toContain("process.chdir(workspace)");
    expect(source).not.toMatch(/dependencies\.(createManager|identity|preflight|resolveExports|resolveInfrastructure)\s*=/);
    expect(source).not.toMatch(/execute\s*:\s*(async|\()/);
    expect(source).not.toMatch(/mktemp|os\.tmpdir\(|\/tmp\//);
    expect(source).toContain('resourceSnapshot(), before');
    expect(source.match(/await active\.backend\.stop\(\);/g)).toHaveLength(2);
    expect(source).not.toMatch(/prune|pkill|killall|cleanup\.sh/);
  });

  it('covers valid harnesses, every unavailable class, workflow admission and active cancellation', () => {
    expect(driver.CASES).toEqual([
      ['copilot', 'valid', '1.2.3'], ['claude', 'valid', '2.1.3'], ['codex', 'valid', '0.89.0'],
      ['copilot', 'missing', 'binary_missing'], ['copilot', 'malformed', 'probe_output_invalid'],
      ['copilot', 'failed', 'probe_failed'], ['copilot', 'oversized', 'probe_output_limit'],
      ['copilot', 'timeout', 'probe_timed_out'],
    ]);
    expect(source).toContain("['valid', '1.0.0', undefined]");
    expect(source).toContain('/harness_incompatible/');
    expect(source).toContain('/harness_unverified/');
    expect(source).toContain("await test('cancel-active-probe'");
    expect(source).toContain("await test('startup-rejects-corrupt-artifact'");
    expect(source).toContain("'/proc/sys/kernel/random/boot_id'");
    expect(source).toContain("assert.notEqual(lines[8]");
  });

  it('uses the real networkless fixed-path proxy consumer and immutable request pins', () => {
    expect(source).toContain("env.AWF_LIVE_CONSUMER_IMAGE || 'ghcr.io/github/gh-aw-firewall/api-proxy:latest'");
    expect(source).toContain('{{index .Config.Labels "org.opencontainers.image.revision"}}');
    expect(source).toContain("'consumer-image-sha-mismatch'");
    expect(source).not.toContain('awf-harness-agent');
    expect(source).toContain("'--network', 'none', '--read-only'");
    expect(source).toContain('dst=/var/log/api-proxy,readonly');
    expect(source).toContain("'cloud-hypervisor-proxy-check.cjs'");
    const consumer = fs.readFileSync(path.join(path.dirname(fixture), 'cloud-hypervisor-proxy-check.cjs'), 'utf8');
    expect(consumer).toContain("require('/app/model-eligibility')");
    expect(consumer).toContain("require('/app/routing-controller')");
    expect(consumer).toContain('pinRequestEligibility(req)');
    expect(consumer).toContain('await replacementBarrier()');
    expect(consumer).toContain('assert.equal(executions[1].awfEligibility, routingPin)');
    expect(consumer).toContain("assert.equal(evaluate(request()).harness, 'unverified')");
    expect(source).toContain('pinAcrossReplacement: true');
    expect(source).toContain("AWF_HARNESS_ENVIRONMENT: 'cloud-hypervisor:wrong'");
    expect(source).toContain("AWF_SELECTED_HARNESS: 'claude-code'");
    expect(source).toContain("AWF_HARNESS_ENVIRONMENT: 'cloud-hypervisor:enclave-subject'");
  });

  it('executes the consumer fixture through real request/routing modules (simulated trusted mount, not live proof)', async () => {
    const work = directory();
    const filename = path.join(work, 'report.json');
    const environment = 'cloud-hypervisor:deterministic';
    const report = {
      environment, name: 'copilot-cli', binary: '/workspace/copilot',
      resolvedBinary: '/workspace/copilot', version: '1.2.3', status: 'observed',
    };
    fs.writeFileSync(filename, JSON.stringify(report), { mode: 0o644 });
    const previous = {
      environment: process.env.AWF_HARNESS_ENVIRONMENT, name: process.env.AWF_SELECTED_HARNESS,
      binary: process.env.AWF_HARNESS_BINARY,
    };
    Object.assign(process.env, {
      AWF_HARNESS_ENVIRONMENT: environment, AWF_SELECTED_HARNESS: 'copilot-cli',
      AWF_HARNESS_BINARY: '/workspace/copilot',
    });
    const originalOpen = fs.openSync;
    const originalStat = fs.fstatSync;
    const descriptors = new Set<number>();
    // Only the deterministic test simulates the root-owned fixed mount.
    // The live driver executes this same fixture with the actual mount/image.
    const open = jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      const selected = file === '/var/log/api-proxy/harness-observation.json';
      const fd = (originalOpen as Function)(selected ? filename : file, ...args);
      if (selected) descriptors.add(fd);
      return fd;
    }) as typeof fs.openSync);
    const stat = jest.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, ...args: unknown[]) => {
      const value = (originalStat as Function)(fd, ...args);
      return descriptors.has(fd) ? Object.assign(value, { uid: 0 }) : value;
    }) as typeof fs.fstatSync);
    try {
      const fixtureFs = {
        writeFileSync: (file: string, value: string) => {
          expect(file).toBe('/exchange/pinned');
          fs.writeFileSync(path.join(work, 'pinned'), value);
          setImmediate(() => {
            fs.writeFileSync(filename, JSON.stringify({ ...report, environment: 'cloud-hypervisor:other' }));
            fs.writeFileSync(path.join(work, 'replaced'), 'ready\n');
          });
        },
        existsSync: (file: string) => fs.existsSync(path.join(work, path.basename(file))),
      };
      const consumerSource = fs.readFileSync(path.join(path.dirname(fixture), 'cloud-hypervisor-proxy-check.cjs'), 'utf8');
      const fixtureModule: { exports: { main?: (options: unknown) => Promise<unknown> } } = { exports: {} };
      vm.runInNewContext(consumerSource, {
        module: fixtureModule, process, Buffer, setTimeout,
        require: (name: string) => name === 'node:fs' ? fixtureFs
          : require(name.startsWith('/app/') ? path.join(root, 'containers/api-proxy', name.slice(5)) : name),
      });
      await expect(fixtureModule.exports.main!({ status: 'observed', pinAcrossReplacement: true }))
        .resolves.toEqual({ pinned: true, request: true, routing: true, classifierAttempts: 2 });
    } finally {
      open.mockRestore(); stat.mockRestore();
      for (const [key, value] of Object.entries({
        AWF_HARNESS_ENVIRONMENT: previous.environment, AWF_SELECTED_HARNESS: previous.name,
        AWF_HARNESS_BINARY: previous.binary,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.each([
    ['valid', 'copilot', 'GitHub Copilot CLI 1.2.3', '1.2.3'],
    ['valid', 'claude', '2.1.3 (Claude Code)', '2.1.3'],
    ['valid', 'codex', 'codex-cli 0.89.0', '0.89.0'],
    ['malformed', 'copilot', '', 'probe_output_invalid'],
    ['failed', 'copilot', '', 'probe_failed'],
    ['oversized', 'copilot', '', 'probe_output_limit'],
  ])('executes POSIX fixture %s/%s and parser without Docker or runtime stubs', async (mode, binary, version, expected) => {
    const work = directory();
    const executable = path.join(work, binary);
    fs.copyFileSync(fixture, executable);
    fs.chmodSync(executable, 0o755);
    const env = {
      FIXTURE_MODE: mode, FIXTURE_VERSION: version, FIXTURE_ENV: 'controlled',
      FIXTURE_LOGIN: 'profile-loaded', FIXTURE_DIRECTORY: work, AWF_RUNTIME: 'deterministic-host-only',
    };
    const contract = require('../../src/model-information-contract/harness-observation');
    const context = { environment: 'deterministic-host-only', ...contract.selectHarness(executable) };
    const probe = await execa('/bin/sh', ['-c', contract.probeCommand(context)], {
      reject: false, cwd: work, env, stripFinalNewline: false, timeout: 5000,
    });
    if (mode === 'oversized') {
      expect(Buffer.byteLength(probe.stdout)).toBe(4097);
      expect(probe.stdout.endsWith('\n')).toBe(true);
    }
    const report = contract.parseProbe(context, probe);
    expect(report.status === 'observed' ? report.version : report.reason).toBe(expected);
    expect(JSON.stringify(report)).not.toContain('discard-this-fixture');
    const commandResult = await execa(executable, ['--fixture'], {
      reject: false, cwd: work, env, stripFinalNewline: false, timeout: 5000,
    });
    expect(commandResult).toMatchObject({
      exitCode: 23, stdout: 'fixture-command-output\n', stderr: 'fixture-command-stderr\n',
    });
    expect(fs.readFileSync(path.join(work, 'probe-context'), 'utf8'))
      .toBe(fs.readFileSync(path.join(work, 'command-context'), 'utf8'));
  });
});
