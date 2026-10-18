import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { runInNewContext } from 'vm';
import { createHash } from 'crypto';

const preflightPath = path.resolve(__dirname, 'cloud-hypervisor-host-preflight.sh');
const smokePath = path.resolve(__dirname, 'cloud-hypervisor-live-smoke.sh');
const artifactBuildPath = path.resolve(
  __dirname,
  '../../guest/cloud-hypervisor/build-test-artifacts.sh'
);
const artifactVerifyPath = path.resolve(
  __dirname,
  '../../guest/cloud-hypervisor/verify-test-artifacts.sh'
);
const releaseWorkflowPath = path.resolve(
  __dirname,
  '../../.github/workflows/release.yml'
);

function shellcheckAvailable(): boolean {
  try {
    execFileSync('shellcheck', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('build-test-artifacts.sh', () => {
  it('passes bash syntax check', () => {
    expect(() => execFileSync('bash', ['-n', artifactBuildPath])).not.toThrow();
  });

  it('keeps guest distribution metadata and verification aligned with the build-tools base', () => {
    const dockerfile = fs.readFileSync(
      path.resolve(__dirname, '../../containers/build-tools/Dockerfile'),
      'utf-8',
    );
    const version = dockerfile.match(/^FROM ubuntu:(\d+\.\d+)@sha256:/m)?.[1];
    expect(version).toBeDefined();
    const source = fs.readFileSync(artifactBuildPath, 'utf-8');
    const verifier = fs.readFileSync(artifactVerifyPath, 'utf-8');
    expect(source).toContain(`"distribution": "ubuntu:${version}"`);
    expect(verifier).toContain(`grep -F 'Ubuntu ${version}'`);
  });

  it('resumes interrupted downloads with bounded retries and verifies before publishing', () => {
    const source = fs.readFileSync(artifactBuildPath, 'utf-8');
    expect(source).toContain('--continue-at -');
    expect(source).toContain('--retry-all-errors');
    expect(source).toContain('--retry-max-time 900');
    expect(source).toContain('--http1.1');
    expect(source).toContain('local partial="${destination}.part"');
    expect(source).toContain('sha256sum --check --status');
    expect(source).toContain('mv -- "$partial" "$destination"');
  });

  it('emits one release-pinned manifest covering every trusted runtime artifact', () => {
    const source = fs.readFileSync(artifactBuildPath, 'utf-8');
    for (const key of ['cloudHypervisor', 'virtiofsd', 'kernel', 'rootfs', 'supervisor']) {
      expect(source).toContain(`"${key}": {`);
    }
    expect(source).toContain('"repository": "github/gh-aw-firewall"');
    expect(source).toContain(
      '"workflow": "github/gh-aw-firewall/.github/workflows/release.yml"',
    );
    const verifier = fs.readFileSync(artifactVerifyPath, 'utf-8');
    expect(verifier).toContain('.artifacts.${key}.sha256');
  });

  it('attests the manifest and publishes its offline verification bundle', () => {
    const workflow = fs.readFileSync(releaseWorkflowPath, 'utf-8');
    expect(workflow).toContain(
      'subject-path: release/cloud-hypervisor-test-x86_64/manifest.json',
    );
    expect(workflow).toContain(
      '${{ steps.attest_cloud_hypervisor_manifest.outputs.bundle-path }}',
    );
    expect(workflow).toContain(
      'release/cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl',
    );
  });
});

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

  it('requires KVM access only for the privileged AWF orchestrator', () => {
    const source = fs.readFileSync(preflightPath, 'utf-8');
    expect(source).toContain('sudo -n test -r /dev/kvm -a -w /dev/kvm');
    expect(source).not.toContain('workflow user');
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

  it('preflights one shared enclave rootfs and fixed entrypoints for v2 and compatible v1 manifests', () => {
    const source = fs.readFileSync(preflightPath, 'utf-8');
    expect(source).toContain('rootfs_name=enclave-rootfs.ext4');
    expect(source).toContain('if .schemaVersion == 2 then');
    expect(source).toContain('elif .schemaVersion == 1 then');
    expect(source).toContain('.entrypoints.script == "/usr/local/bin/run-enclave-script"');
    expect(source).toContain('.entrypoints.agent == "/usr/local/bin/run-enclave-agent"');
  });

  describe.each([2, 1])('schema v%s artifact validation', schemaVersion => {
    const source = fs.readFileSync(preflightPath, 'utf-8');
    const functions = source.slice(source.indexOf('fail() {'), source.indexOf('[ "$(uname -s)"'));
    const validation = source.slice(source.indexOf('require_regular_file "$ARTIFACT_DIR/enclave-manifest.json"'));

    function validate(mutate: (manifest: any) => void = () => {}): void {
      const scratch = fs.mkdtempSync(path.resolve('.awf-preflight-test-'));
      try {
        const contents = Buffer.from('shared enclave rootfs fixture');
        const sha256 = createHash('sha256').update(contents).digest('hex');
        const filename = 'enclave-rootfs.ext4';
        const identity = {
          file: filename, sha256, sizeBytes: contents.length,
          uid: 65534, gid: 65534,
        };
        const entrypoints = {
          script: '/usr/local/bin/run-enclave-script',
          agent: '/usr/local/bin/run-enclave-agent',
        };
        const manifest = {
          schemaVersion,
          artifactType: 'awf-cloud-hypervisor-enclave-rootfs-set',
          architecture: 'x86_64',
          compatibility: { cloudHypervisorVersion: '53.0' },
          ...(schemaVersion === 2
            ? { rootfs: identity, entrypoints }
            : { rootfs: {
              script: { ...identity, role: 'script', entrypoint: entrypoints.script },
              agent: { ...identity, role: 'agent', entrypoint: entrypoints.agent },
            } }),
        };
        mutate(manifest);
        fs.writeFileSync(path.join(scratch, filename), contents);
        fs.writeFileSync(path.join(scratch, 'enclave-rootfs.SHA256SUMS'), `${sha256}  ${filename}\n`);
        fs.writeFileSync(path.join(scratch, 'enclave-manifest.json'), JSON.stringify(manifest));
        execFileSync('bash', ['-c', [
          'set -euo pipefail', 'ARTIFACT_DIR=$1', functions, validation,
        ].join('\n'), 'preflight-artifact-test', scratch], { stdio: 'pipe' });
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }

    it('accepts the shared filesystem identity', () => {
      expect(() => validate()).not.toThrow();
    });

    it.each([
      ['file', 'other.ext4'],
      ['sha256', '0'.repeat(64)],
      ['sizeBytes', 1],
      ['uid', 0],
      ['gid', 0],
    ])('rejects incorrect %s metadata', (field, value) => {
      expect(() => validate(manifest => {
        const identity = schemaVersion === 2 ? manifest.rootfs : manifest.rootfs.agent;
        identity[field] = value;
      })).toThrow(/identity or fixed entrypoints are invalid/);
    });

    it.each(['script', 'agent'])('rejects a changed %s entrypoint', role => {
      expect(() => validate(manifest => {
        if (schemaVersion === 2) manifest.entrypoints[role] = '/bin/sh';
        else manifest.rootfs[role].entrypoint = '/bin/sh';
      })).toThrow(/identity or fixed entrypoints are invalid/);
    });

    it('rejects an unsupported schema', () => {
      expect(() => validate(manifest => { manifest.schemaVersion = 3; }))
        .toThrow(/identity or fixed entrypoints are invalid/);
    });
  });

  (shellcheckAvailable() ? it : it.skip)('has no shellcheck errors', () => {
    expect(() =>
      execFileSync('shellcheck', ['--severity=error', preflightPath]),
    ).not.toThrow();
  });
});

describe('cloud-hypervisor-live-smoke.sh', () => {
  it('creates private work directories even with a permissive runner umask', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    const headerEnd = source.indexOf('\nARTIFACT_DIR=');
    expect(headerEnd).toBeGreaterThan(0);
    const header = source.slice(0, headerEnd);
    const runCase = source.match(/^run_case\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(runCase).toBeDefined();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-smoke-permissions-'));
    try {
      execFileSync('bash', ['-c', [
        'umask 022',
        header,
        'RUN_ROOT="$1"',
        'ROOT=fixture',
        'SECRET_SENTINEL=fixture-sentinel',
        'COMMON=()',
        'sudo() { test "$1" = -E && test "$2" = node; }',
        'assert_no_residue() { :; }',
        runCase!,
        'run_case fixture 0 true',
      ].join('\n'), 'awf-smoke-permissions', scratch], { stdio: 'pipe' });
      expect(fs.statSync(path.join(scratch, 'fixture/work')).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('passes bash syntax check', () => {
    expect(() => execFileSync('bash', ['-n', smokePath])).not.toThrow();
  });

  describe('keep-mode trusted-artifact teardown', () => {
    const snapshotRoot = '/var/lib/awf-cloud-hypervisor/trusted-artifacts';
    const directory = `${snapshotRoot}/run-Ab1234`;
    const source = fs.readFileSync(smokePath, 'utf-8');
    const cleanup = source.match(
      /<<'KEEP_SNAPSHOT_CLEANUP'\n([\s\S]*?)\nKEEP_SNAPSHOT_CLEANUP/,
    )?.[1];

    async function runCleanup(options: {
      executable?: unknown;
      realpath?: string;
      uid?: number;
      isDirectory?: boolean;
      mountError?: Error;
      identityError?: Error;
    } = {}) {
      expect(cleanup).toBeDefined();
      const identity = { device: '1', inode: '2' };
      const dependencies = { lstat: jest.fn() };
      const captureFileIdentity = jest.fn().mockResolvedValue(identity);
      const assertNoMountsUnder = options.mountError
        ? jest.fn().mockRejectedValue(options.mountError)
        : jest.fn().mockResolvedValue(undefined);
      const removeExactDirectory = options.identityError
        ? jest.fn().mockRejectedValue(options.identityError)
        : jest.fn().mockResolvedValue(undefined);
      const modules: Record<string, unknown> = {
        fs: { promises: {
          readFile: jest.fn().mockResolvedValue(JSON.stringify({ process: {
            executable: options.executable ?? `${directory}/cloud-hypervisor`,
          } })),
          realpath: jest.fn().mockResolvedValue(options.realpath ?? directory),
          lstat: jest.fn().mockResolvedValue({
            uid: options.uid ?? 0,
            isDirectory: () => options.isDirectory ?? true,
          }),
        } },
        path,
        '/fixture/dist/cloud-hypervisor/manager-types': {
          CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT: snapshotRoot,
        },
        '/fixture/dist/cloud-hypervisor/cleanup-dependencies': {
          resolveCleanupDependencies: () => dependencies,
        },
        '/fixture/dist/cloud-hypervisor/cleanup-process': { captureFileIdentity },
        '/fixture/dist/cloud-hypervisor/cleanup-record-store': {
          assertNoMountsUnder, removeExactDirectory,
        },
      };
      const testProcess = {
        argv: ['node', '-', '/fixture', '/fixture/confinement.json'],
        exitCode: 0,
      };
      const error = jest.fn();
      await runInNewContext(cleanup!, {
        require: (name: string) => {
          if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
          return modules[name];
        },
        process: testProcess,
        console: { error },
      });
      return {
        identity, dependencies, captureFileIdentity, assertNoMountsUnder,
        removeExactDirectory, testProcess, error,
      };
    }

    it('removes only the kept VM snapshot through identity and mount guards', async () => {
      const result = await runCleanup();
      expect(result.testProcess.exitCode).toBe(0);
      expect(result.error).not.toHaveBeenCalled();
      expect(result.captureFileIdentity).toHaveBeenCalledWith(result.dependencies.lstat, directory);
      expect(result.assertNoMountsUnder).toHaveBeenCalledWith(result.dependencies, directory);
      expect(result.removeExactDirectory).toHaveBeenCalledWith(
        directory, result.identity, result.dependencies, true,
      );
      expect(result.assertNoMountsUnder.mock.invocationCallOrder[0])
        .toBeLessThan(result.removeExactDirectory.mock.invocationCallOrder[0]);
      const keepCase = source.slice(source.indexOf('keep_work='), source.indexOf(
        '# --- Cloud Hypervisor-specific live security assertions',
      ));
      expect(keepCase.indexOf("<<'KEEP_SNAPSHOT_CLEANUP'"))
        .toBeLessThan(keepCase.lastIndexOf('\nassert_no_residue'));
    });

    it.each([
      { executable: `${snapshotRoot}/cloud-hypervisor` },
      { executable: `${snapshotRoot}/../run-Ab1234/cloud-hypervisor` },
      { executable: `${directory}/other-binary` },
      { executable: 42 },
      { realpath: `${snapshotRoot}/run-Other1` },
      { uid: 1000 },
      { isDirectory: false },
      { mountError: new Error('mount remains') },
    ])('rejects unsafe snapshot removal: %j', async (options) => {
      const result = await runCleanup(options);
      expect(result.testProcess.exitCode).toBe(1);
      expect(result.error).toHaveBeenCalledTimes(1);
      expect(result.removeExactDirectory).not.toHaveBeenCalled();
    });

    it('surfaces identity-checked removal failures', async () => {
      const failure = new Error('snapshot identity changed');
      const result = await runCleanup({ identityError: failure });
      expect(result.testProcess.exitCode).toBe(1);
      expect(result.error).toHaveBeenCalledWith(failure);
    });
  });

  describe('enclave network packet fixture', () => {
    const source = fs.readFileSync(path.resolve(
      __dirname, '../../src/cloud-hypervisor/enclave-network.integration.test.ts',
    ), 'utf-8');

    it('enables loopback in every namespace before probing the peer locally', () => {
      expect(source).toMatch(
        /for \(const namespace of \[plan\.namespaceName, guestNs, peerNs\]\) \{\s*await inNs\(namespace, 'ip', \['link', 'set', 'lo', 'up'\]\);/,
      );
      expect(source.indexOf("['link', 'set', 'lo', 'up']"))
        .toBeLessThan(source.indexOf('const probe ='));
    });

    it('bounds peer readiness retries below the setup hook timeout', () => {
      const readiness = source.slice(source.indexOf('let ready = false'), source.indexOf('if (!ready) throw'));
      const attempts = Number(readiness.match(/attempt < (\d+)/)?.[1]);
      const requestSeconds = Number(readiness.match(/'--max-time', '([\d.]+)'/)?.[1]);
      const hookTimeout = Number(source.match(/\}, ([\d_]+)\);/)?.[1].replace(/_/g, ''));
      expect(attempts).toBeGreaterThan(0);
      expect(requestSeconds).toBeGreaterThan(0);
      expect((requestSeconds * 1000 + 100) * attempts).toBeLessThan(hookTimeout);
    });
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
      'allow-write',
      'allow-write-none',
      'allow-write-invalid',
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
    for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
      expect(source).toContain(field);
    }
    expect(source).toContain('0000000000000000');
    expect(source).toContain('NoNewPrivs');
    expect(source).toContain('Seccomp');
    expect(source).toContain('landlock_enable');
    expect(source).toContain('"/tun_flags"');
    expect(source).toContain('cgroup.procs');
    expect(
      source.match(/sudo getfacl --absolute-names --numeric \/dev\/kvm/g),
    ).toHaveLength(2);
    expect(source).toContain(
      'sudo getfacl --absolute-names --numeric /dev/net/tun',
    );
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
    expect(source).toContain(
      "pgrep -f '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[c]loud-hypervisor --api-socket'",
    );
    expect(source).toContain(
      "pgrep -f '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[v]irtiofsd.*--shared-dir='",
    );
    expect(source).not.toContain(
      'pgrep -f "$ARTIFACT_DIR/[c]loud-hypervisor --api-socket"',
    );
    expect(source).not.toContain(
      'pgrep -f "$ARTIFACT_DIR/[v]irtiofsd.*--shared-dir="',
    );
  });

  it('uses process probes that exclude their own command line but match live targets', () => {
    const probes = [
      {
        pattern:
          '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[c]loud-hypervisor --api-socket',
        target:
          '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-abc123/cloud-hypervisor --api-socket /run/awf.sock',
      },
      {
        pattern:
          '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[v]irtiofsd.*--shared-dir=',
        target:
          '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-abc123/virtiofsd --socket-path=/run/vhost.sock --shared-dir=/workspace',
      },
    ];

    for (const probe of probes) {
      const expression = new RegExp(probe.pattern);
      expect(expression.test(`sudo pgrep -f '${probe.pattern}'`)).toBe(false);
      expect(expression.test(probe.target)).toBe(true);
    }
  });

  it('uses the conspicuous dual opt-in for same-run unattested test artifacts', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    expect(source).toContain(
      'AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS=1',
    );
    expect(source).toContain(
      '--cloud-hypervisor-development-allow-unattested-artifacts',
    );
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

  it('proves filesystem.allowWrite enforcement end to end, including fail-closed', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    // Selective policy: host-visible persistence of an allowed write, plus
    // sibling/parent/create/truncate/rename/delete denial outside the list.
    expect(source).toContain('"allowWrite": ["/workspace/allowed", "/workspace/allowed-file.txt"]');
    expect(source).toContain('test "$(cat "$allow_workspace/allowed/created.txt")" = guest-allowed');
    expect(source).toContain('test "$(cat "$allow_workspace/blocked/file.txt")" = host');
    expect(source).toContain('test ! -e "$allow_workspace/created-at-root.txt"');
    expect(source).toContain('test ! -e "$allow_workspace/renamed.txt"');
    // A selective export stays read-write guest-side; only the zero-overlay
    // narrowing publishes the guest mount itself read-only.
    expect(source).toContain('grep -q " /workspace/allowed virtiofs " /proc/mounts');
    expect(source).toContain('grep -q " /workspace virtiofs ro," /proc/mounts');
    // Unmatched allowlist entries abort the run instead of widening it.
    expect(source).toContain('run_case allow-write-invalid 1');
    expect(source).toContain("grep -q 'filesystem.allowWrite'");
  });

  it('proves every allowWrite denial probe actually executed under BusyBox ash', () => {
    const source = fs.readFileSync(smokePath, 'utf-8');
    // Regression: the guest shell is BusyBox ash, where a redirection failure
    // on a POSIX *special* builtin is fatal and exits the shell. An earlier
    // `! : > /workspace/input.txt` truncate probe therefore terminated the
    // guest command before the rename and delete probes ran, while the host
    // post-checks still passed vacuously -- a write never attempted also never
    // Comment lines are excluded: the rationale above quotes the old probe.
    const executableLines = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    expect(executableLines.some((line) => /!\s*:\s*>/.test(line))).toBe(false);
    expect(source).toContain('! ( printf "" > /workspace/input.txt )');

    // Every denial probe is subshell-contained (so even a fatal shell error is
    // isolated) and followed by a sentinel that the suite then requires.
    for (const probe of [
      '! ( printf blocked > /workspace/blocked/file.txt )',
      '! ( printf blocked > /workspace/created-at-root.txt )',
      '! ( mkdir /workspace/blocked-dir )',
      '! ( mv /workspace/rename-me.txt /workspace/renamed.txt )',
      '! ( rm /workspace/blocked/file.txt )',
    ]) {
      expect(source).toContain(probe);
    }

    expect(source).toContain('assert_sentinels() {');
    expect(source).toContain('missing sentinel $sentinel (probe never executed)');
    for (const sentinel of [
      'AWF-ALLOWWRITE-ALLOWED-OK',
      'AWF-ALLOWWRITE-SIBLING-DENIED',
      'AWF-ALLOWWRITE-CREATE-DENIED',
      'AWF-ALLOWWRITE-MKDIR-DENIED',
      'AWF-ALLOWWRITE-TRUNCATE-DENIED',
      'AWF-ALLOWWRITE-RENAME-DENIED',
      'AWF-ALLOWWRITE-DELETE-DENIED',
      'AWF-ALLOWWRITE-NONE-READ-OK',
      'AWF-ALLOWWRITE-NONE-WRITE-DENIED',
      'AWF-ALLOWWRITE-NONE-CREATE-DENIED',
    ]) {
      // Emitted by the guest command, and separately required afterwards.
      expect(source).toContain(`echo ${sentinel}`);
      expect(source.split(sentinel).length - 1).toBeGreaterThanOrEqual(2);
    }
    expect(source).toContain('assert_sentinels allow-write \\');
    expect(source).toContain('assert_sentinels allow-write-none \\');
  });

  (shellcheckAvailable() ? it : it.skip)('has no shellcheck errors', () => {
    expect(() =>
      execFileSync('shellcheck', ['--severity=error', smokePath]),
    ).not.toThrow();
  });
});
