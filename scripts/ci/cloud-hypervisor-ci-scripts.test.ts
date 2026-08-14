import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const preflightPath = path.resolve(__dirname, 'cloud-hypervisor-host-preflight.sh');
const smokePath = path.resolve(__dirname, 'cloud-hypervisor-live-smoke.sh');

function shellcheckAvailable(): boolean {
  try {
    execFileSync('shellcheck', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('cloud-hypervisor-host-preflight.sh', () => {
  it('passes bash syntax check', () => {
    expect(() => execFileSync('bash', ['-n', preflightPath])).not.toThrow();
  });

  it('fails closed with a usage message when no artifact directory is given', () => {
    expect(() =>
      execFileSync('bash', [preflightPath], { stdio: 'pipe' }),
    ).toThrow();
  });

  it('enforces GitHub-hosted-only host eligibility ahead of live capability checks', () => {
    const source = fs.readFileSync(preflightPath, 'utf-8');
    expect(source).toContain('GITHUB_ACTIONS');
    expect(source).toContain('RUNNER_ENVIRONMENT');
    expect(source).toContain('github-hosted');
    expect(source).toContain('ImageOS');
  });

  it('requires setpriv (the launcher jailer replacement) and does not check a jailer binary version', () => {
    const source = fs.readFileSync(preflightPath, 'utf-8');
    expect(source).toContain('setpriv');
    expect(source).not.toContain('jailer --version');
    expect(source).not.toMatch(/\$ARTIFACT_DIR\/jailer/);
  });

  it('checks for Landlock LSM support and pins Cloud Hypervisor v53.0', () => {
    const source = fs.readFileSync(preflightPath, 'utf-8');
    expect(source).toContain('/sys/kernel/security/lsm');
    expect(source).toContain('landlock');
    expect(source).toContain("'53.0'");
  });

  it('verifies artifact digests via sha256sum --check --strict', () => {
    const source = fs.readFileSync(preflightPath, 'utf-8');
    expect(source).toContain('sha256sum --check --strict SHA256SUMS');
  });

  (shellcheckAvailable() ? it : it.skip)('has no shellcheck errors', () => {
    expect(() =>
      execFileSync('shellcheck', ['--severity=error', preflightPath]),
    ).not.toThrow();
  });
});

describe('cloud-hypervisor-live-smoke.sh', () => {
  it('passes bash syntax check', () => {
    expect(() => execFileSync('bash', ['-n', smokePath])).not.toThrow();
  });

  it('covers the shared behavioral/security contract plus virtio-fs semantics', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    const requiredCases = [
      'allowed-https',
      'blocked-domain',
      'direct-egress',
      'arbitrary-tcp',
      'dns-denial',
      'metadata-denial',
      'api-proxy-reflect',
      'workspace-live-share',
      'runtime-cache-readonly',
      'exit-code',
      'timeout-124',
      'partial-start-cleanup',
    ];
    for (const name of requiredCases) {
      expect(source).toContain(`run_case ${name}`);
    }
    // cancellation and keep are hand-rolled blocks (not run_case) in both scripts.
    expect(source).toContain('cancel_work=');
    expect(source).toContain('keep_work=');
  });

  it('adds Cloud Hypervisor-specific device-assumption and security-assertion coverage', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    expect(source).toContain('run_case device-assumptions');
    expect(source).toContain('/dev/vda');
    expect(source).toContain('/dev/vdb');
    expect(source).toContain('eth0');
    expect(source).toContain('sec_work=');
    expect(source).toContain('CapEff');
    expect(source).toContain('NoNewPrivs');
    expect(source).toContain('Seccomp');
    expect(source).toContain('landlock_enable');
    expect(source).toContain('cgroup.procs');
  });

  it('measures non-flaky boot-readiness and cleanup-time baselines', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    expect(source).toContain('BOOT_READINESS_CEILING_MS');
    expect(source).toContain('CLEANUP_CEILING_MS');
    expect(source).not.toMatch(/vhost-net|vhost-user/);
  });

  it('uses a Cloud Hypervisor-distinct secret sentinel and scans for leaks', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    expect(source).toContain('awf-cloud-hypervisor-real-secret-do-not-expose');
  });

  it('checks netns/veth/TAP plus Cloud Hypervisor-specific cgroup/process residue', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    expect(source).toContain("grep -q '^awfvm-'");
    expect(source).toContain('(vmh|vmn|vmt)');
    expect(source).toContain('CGROUP_ROOT');
    expect(source).toContain("pgrep -f 'cloud-hypervisor --api-socket'");
  });

  it('passes the pinned artifact digests as distinct --cloud-hypervisor-*-sha256 flags', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    expect(source).toContain('--cloud-hypervisor-binary-sha256');
    expect(source).toContain('--cloud-hypervisor-kernel-sha256');
    expect(source).toContain('--cloud-hypervisor-rootfs-sha256');
    expect(source).toContain('--cloud-hypervisor-supervisor-sha256');
  });

  it('explicitly passes --network-isolation (commander resolves the paired option to undefined by default)', () => {
    // Regression test: discovered via a live workflow_dispatch run —
    // assertCloudHypervisorRuntimeCompatibility() requires a strictly
    // truthy config.networkIsolation, but the --network-isolation/
    // --no-network-isolation commander.js option pair resolves to
    // `undefined` (not `true`) when neither flag is passed on the CLI,
    // despite the CLI help text describing it as "enabled by default".
    const source = fs.readFileSync(smokePath, 'utf-8');
    expect(source).toMatch(/COMMON=\(\n(?:.*\n)*?\s*--network-isolation\n/);
  });

  (shellcheckAvailable() ? it : it.skip)('has no shellcheck errors', () => {
    expect(() =>
      execFileSync('shellcheck', ['--severity=error', smokePath]),
    ).not.toThrow();
  });
});
