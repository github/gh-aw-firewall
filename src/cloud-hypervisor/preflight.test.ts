import { constants } from 'fs';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import execa from 'execa';
import * as os from 'os';
import * as path from 'path';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import {
  calculateSha256,
  cloudHypervisorPreflightTestHelpers,
  parseCloudHypervisorVersion,
  parseVirtiofsdVersion,
  runCloudHypervisorPreflight,
  type CloudHypervisorPreflightDependencies,
} from './preflight';

jest.mock('execa');

const digest = 'a'.repeat(64);
const mockedExeca = execa as jest.MockedFunction<typeof execa>;

function manifest(): string {
  return JSON.stringify({
    schemaVersion: 1,
    architecture: 'x86_64',
    release: {
      repository: 'github/gh-aw-firewall',
      workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
      tag: 'v0.23.1',
      sourceCommit: 'b'.repeat(40),
    },
    artifacts: {
      cloudHypervisor: { file: 'cloud-hypervisor', version: '53.0', sha256: digest },
      virtiofsd: { file: 'virtiofsd', version: '1.10.0', sha256: digest },
      kernel: { file: 'vmlinux.bin', version: '6.1.141', sha256: digest },
      rootfs: { file: 'rootfs.ext4', version: 'v0.23.1', sha256: digest },
      supervisor: { file: 'awf-supervisor', version: 'v0.23.1', sha256: digest },
    },
  });
}

function config(overrides: Partial<CloudHypervisorOptions> = {}): CloudHypervisorOptions {
  return {
    previewEnabled: true,
    mountPolicy: 'workspace-only',
    cloudHypervisorBinary: '/opt/cloud-hypervisor',
    kernelPath: '/opt/vmlinux.bin',
    rootfsPath: '/opt/rootfs.ext4',
    supervisorPath: '/opt/awf-supervisor',
    artifactManifestPath: '/opt/manifest.json',
    artifactManifestBundlePath: '/opt/manifest.sigstore.jsonl',
    artifactReleaseTag: 'v0.23.1',
    vcpuCount: 2,
    memoryMib: 512,
    apiTimeoutMs: 5000,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<CloudHypervisorPreflightDependencies> = {},
): Partial<CloudHypervisorPreflightDependencies> {
  return {
    platform: 'linux',
    arch: 'x64',
    uid: 1000,
    access: jest.fn().mockResolvedValue(undefined),
    lstat: jest.fn().mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100755,
      uid: 0,
    }),
    runVersion: jest.fn(async (binaryPath: string) => (
      binaryPath.endsWith('/virtiofsd') ? 'virtiofsd backend 1.10.0' : 'cloud-hypervisor v53.0'
    )),
    sha256: jest.fn().mockResolvedValue(digest),
    readFile: jest.fn().mockResolvedValue(manifest()),
    createArtifactSnapshot: jest.fn(async (sources) => ({
      directory: '/run/awf-cloud-hypervisor/trusted-artifacts/run-test',
      cloudHypervisorBinary: '/snapshot/cloud-hypervisor',
      virtiofsdBinary: '/snapshot/virtiofsd',
      kernelPath: '/snapshot/vmlinux.bin',
      rootfsPath: '/snapshot/rootfs.ext4',
      supervisorPath: '/snapshot/awf-supervisor',
      ...(sources.manifestPath ? { manifestPath: '/snapshot/manifest.json' } : {}),
      ...(sources.bundlePath
        ? { bundlePath: '/snapshot/manifest.sigstore.jsonl' }
        : {}),
    })),
    removeArtifactSnapshot: jest.fn().mockResolvedValue(undefined),
    verifyManifestAttestation: jest.fn().mockResolvedValue(undefined),
    assertToolAvailable: jest.fn(async (tool: string) => `/usr/bin/${tool}`),
    assertHostPolicy: jest.fn().mockResolvedValue(2),
    assertDockerInfrastructure: jest.fn().mockResolvedValue(undefined),
    resolveKvmGid: jest.fn().mockResolvedValue(978),
    ...overrides,
  };
}

describe('Cloud Hypervisor preflight (foundation only)', () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    mockedExeca.mockReset();
  });

  afterEach(() => {
    delete process.env.SUDO_UID;
    delete process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS;
    jest.restoreAllMocks();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('runs default version, tool, and digest host probes', async () => {
    const defaults = cloudHypervisorPreflightTestHelpers.defaultDependencies;
    mockedExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: `node ${process.version.slice(1)}`,
        stderr: '',
      } as never)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'unsupported flag',
      } as never);
    await expect(defaults.runVersion(process.execPath)).resolves.toContain(
      process.version.slice(1),
    );
    await expect(defaults.runVersion('/bin/false')).rejects.toThrow(
      /--version" exited with code/,
    );

    process.env.PATH = `${path.delimiter}/usr/bin`;
    await expect(defaults.assertToolAvailable('false'))
      .resolves.toBe('/usr/bin/false');
    await expect(defaults.assertToolAvailable('definitely-not-an-awf-tool'))
      .rejects.toThrow(/was not found on PATH/);

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-ch-preflight-digest-'));
    const target = path.join(directory, 'artifact');
    try {
      await fs.writeFile(target, 'verified artifact');
      await expect(calculateSha256(target)).resolves.toBe(
        createHash('sha256').update('verified artifact').digest('hex'),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('runs host policy and Docker probes through the default helper', async () => {
    const defaults = cloudHypervisorPreflightTestHelpers.defaultDependencies;
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    const access = jest.spyOn(fs, 'access').mockResolvedValue(undefined);
    await expect(defaults.assertHostPolicy()).resolves.toBe(2);
    expect(access).toHaveBeenCalledWith(
      '/proc/sys/kernel/seccomp/actions_avail',
      constants.R_OK,
    );

    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: 'available',
      stderr: '',
    } as never);
    await expect(defaults.assertDockerInfrastructure('/usr/bin/docker')).resolves.toBeUndefined();
    expect(mockedExeca).toHaveBeenCalledWith(
      '/usr/bin/docker',
      ['compose', 'version'],
      expect.objectContaining({ timeout: 10_000, reject: false }),
    );

    const statSpy = jest.spyOn(fs, 'stat').mockResolvedValue({ gid: 978 } as never);
    await expect(defaults.resolveKvmGid()).resolves.toBe(978);
    expect(statSpy).toHaveBeenCalledWith('/dev/kvm');
  });

  it('verifies the manifest with the offline bundle and exact release workflow identity', async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: 'Loaded digest sha256:abc',
      stderr: '',
    } as never);
    await expect(
      cloudHypervisorPreflightTestHelpers.defaultDependencies.verifyManifestAttestation(
        '/usr/bin/gh',
        '/opt/manifest.json',
        '/opt/manifest.sigstore.jsonl',
      ),
    ).resolves.toBeUndefined();
    expect(mockedExeca).toHaveBeenCalledWith(
      '/usr/bin/gh',
      [
        'attestation',
        'verify',
        '/opt/manifest.json',
        '--repo',
        'github/gh-aw-firewall',
        '--bundle',
        '/opt/manifest.sigstore.jsonl',
        '--signer-workflow',
        'github/gh-aw-firewall/.github/workflows/release.yml',
        '--deny-self-hosted-runners',
      ],
      expect.objectContaining({ reject: false, timeout: 30_000 }),
    );
  });

  it('reports host policy and Docker probe failures', async () => {
    const defaults = cloudHypervisorPreflightTestHelpers.defaultDependencies;
    jest.spyOn(process, 'getuid').mockReturnValue(1000);
    await expect(defaults.assertHostPolicy()).rejects.toThrow(/requires root/);

    mockedExeca.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'daemon unavailable',
    } as never);
    await expect(defaults.assertDockerInfrastructure('/usr/bin/docker'))
      .rejects.toThrow(/\/usr\/bin\/docker info failed.*daemon unavailable/);
  });

  it('rejects cgroup v1-only hosts explicitly instead of falling back', async () => {
    const defaults = cloudHypervisorPreflightTestHelpers.defaultDependencies;
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    jest.spyOn(fs, 'access').mockImplementation(async (target) => {
      if (target === '/sys/fs/cgroup/cgroup.controllers') {
        throw new Error('no cgroup v2');
      }
      return undefined;
    });
    await expect(defaults.assertHostPolicy())
      .rejects.toThrow(/requires the cgroup v2 unified hierarchy.*no cgroup v2/);
  });

  it('parses Cloud Hypervisor release output', () => {
    expect(parseCloudHypervisorVersion('cloud-hypervisor v53.0')).toBe('53.0');
    expect(parseCloudHypervisorVersion('53.0')).toBe('53.0');
    expect(() => parseCloudHypervisorVersion('unknown')).toThrow(/Could not parse/);
  });

  it('parses and pins virtiofsd v1.10.0 output', () => {
    expect(parseVirtiofsdVersion('virtiofsd backend 1.10.0')).toBe('1.10.0');
    expect(() => parseVirtiofsdVersion('virtiofsd unknown')).toThrow(/Could not parse/);
  });

  it('verifies the attested manifest before its five artifact digests', async () => {
    const deps = dependencies();
    const result = await runCloudHypervisorPreflight(config({
    }), deps);

    expect(result.version).toBe('53.0');
    expect(result.cloudHypervisorBinary).toBe('/snapshot/cloud-hypervisor');
    expect(result.virtiofsdBinary).toBe('/snapshot/virtiofsd');
    expect(result.kernelPath).toBe('/snapshot/vmlinux.bin');
    expect(result.rootfsPath).toBe('/snapshot/rootfs.ext4');
    expect(result.supervisorPath).toBe('/snapshot/awf-supervisor');
    expect(result.artifactSnapshotDirectory).toContain('run-test');
    expect(result.cgroupVersion).toBe(2);
    expect(result.kvmGid).toBe(978);
    expect(deps.resolveKvmGid).toHaveBeenCalledTimes(1);
    expect(deps.access).toHaveBeenCalledWith(
      '/dev/kvm',
      constants.R_OK | constants.W_OK,
    );
    expect(deps.sha256).toHaveBeenCalledTimes(5);
    // Docker, the eleven runtime host tools, and gh for attestation verification.
    expect(deps.assertToolAvailable).toHaveBeenCalledTimes(13);
    expect(deps.assertDockerInfrastructure).toHaveBeenCalledWith('/usr/bin/docker');
    expect(deps.verifyManifestAttestation).toHaveBeenCalledWith(
      '/usr/bin/gh',
      '/snapshot/manifest.json',
      '/snapshot/manifest.sigstore.jsonl',
    );
    expect(result.tools).toEqual({
      ip: '/usr/bin/ip',
      nft: '/usr/bin/nft',
      sysctl: '/usr/bin/sysctl',
      flock: '/usr/bin/flock',
      mke2fs: '/usr/bin/mke2fs',
      debugfs: '/usr/bin/debugfs',
      e2fsck: '/usr/bin/e2fsck',
      rsync: '/usr/bin/rsync',
      mount: '/usr/bin/mount',
      umount: '/usr/bin/umount',
      setpriv: '/usr/bin/setpriv',
    });
  });

  it('rejects inaccessible KVM without checking artifacts', async () => {
    const access = jest.fn().mockRejectedValue(new Error('EACCES'));
    const lstat = jest.fn();
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({ access, lstat }),
    )).rejects.toThrow(/readable and writable \/dev\/kvm.*EACCES/);
    expect(lstat).not.toHaveBeenCalled();
  });

  it('rejects mismatched versions, unsafe permissions, and digest mismatches', async () => {
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({ runVersion: jest.fn().mockResolvedValue('cloud-hypervisor v52.0') }),
    )).rejects.toThrow(/pinned to v53\.0/);

    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({
        lstat: jest.fn().mockResolvedValue({
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o100777,
          uid: 1000,
        }),
      }),
    )).rejects.toThrow(/must not be group- or world-writable/);

    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({ sha256: jest.fn().mockResolvedValue('b'.repeat(64)) }),
    )).rejects.toThrow(/SHA-256 mismatch/);

    process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS = '1';
    await expect(runCloudHypervisorPreflight(
      config({
        developmentAllowUnattestedArtifacts: true,
        sha256: {
          cloudHypervisor: digest,
          virtiofsd: digest,
          kernel: 'bad',
          rootfs: digest,
          supervisor: digest,
        },
      }),
      dependencies(),
    )).rejects.toThrow(/must contain exactly 64 hexadecimal/);
  });

  it('fails closed when attestation verification fails before reading the manifest', async () => {
    const readFile = jest.fn();
    const removeArtifactSnapshot = jest.fn().mockResolvedValue(undefined);
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({
        readFile,
        removeArtifactSnapshot,
        verifyManifestAttestation: jest.fn().mockRejectedValue(new Error('bad signature')),
      }),
    )).rejects.toThrow(/bad signature/);
    expect(readFile).not.toHaveBeenCalled();
    expect(removeArtifactSnapshot).toHaveBeenCalledWith(
      '/run/awf-cloud-hypervisor/trusted-artifacts/run-test',
    );
  });

  it('requires conspicuous dual opt-in for development-only legacy digests', async () => {
    const legacy = config({
      artifactManifestPath: undefined,
      artifactManifestBundlePath: undefined,
      artifactReleaseTag: undefined,
      developmentAllowUnattestedArtifacts: true,
      sha256: {
        cloudHypervisor: digest,
        virtiofsd: digest,
        kernel: digest,
        rootfs: digest,
        supervisor: digest,
      },
    });
    await expect(runCloudHypervisorPreflight(legacy, dependencies()))
      .rejects.toThrow(/AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS=1/);

    process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS = '1';
    const deps = dependencies();
    await expect(runCloudHypervisorPreflight(legacy, deps)).resolves.toBeDefined();
    expect(deps.verifyManifestAttestation).not.toHaveBeenCalled();
  });

  it('rejects a missing or mismatched sibling virtiofsd', async () => {
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({
        lstat: jest.fn(async (filePath: string) => {
          if (filePath === '/opt/virtiofsd') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return {
            isFile: () => true,
            isSymbolicLink: () => false,
            mode: 0o100755,
            uid: 0,
          };
        }),
      }),
    )).rejects.toThrow(/virtiofsd/);

    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({
        runVersion: jest.fn(async (filePath: string) => (
          filePath.endsWith('/virtiofsd') ? 'virtiofsd backend 1.9.0' : 'cloud-hypervisor v53.0'
        )),
      }),
    )).rejects.toThrow(/virtiofsd is pinned to v1\.10\.0/);
  });

  it('verifies Cloud Hypervisor digest before invoking the binary', async () => {
    const runVersion = jest.fn().mockResolvedValue('cloud-hypervisor v53.0');
    await expect(runCloudHypervisorPreflight(
      config({ sha256: { cloudHypervisor: digest } }),
      dependencies({
        runVersion,
        sha256: jest.fn(async (filePath: string) => (
          filePath === '/snapshot/cloud-hypervisor' ? 'b'.repeat(64) : digest
        )),
      }),
    )).rejects.toThrow(/Cloud Hypervisor binary SHA-256 mismatch/);
    expect(runVersion).not.toHaveBeenCalled();
  });

  it('rejects missing artifacts, unsupported hosts, and unavailable tools', async () => {
    await expect(runCloudHypervisorPreflight(
      config({ supervisorPath: undefined }),
      dependencies(),
    )).rejects.toThrow(/requires guest kernel, rootfs, and supervisor/);
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({ platform: 'darwin' }),
    )).rejects.toThrow(/requires Linux with KVM/);
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({ arch: 'arm64' }),
    )).rejects.toThrow(/supported only on x86_64 GitHub-hosted runners/);
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({
        assertToolAvailable: jest.fn(async (tool: string) => {
          if (tool === 'ip') throw new Error('missing');
          return `/usr/bin/${tool}`;
        }),
      }),
    )).rejects.toThrow(/requires host tool "ip": missing/);
  });

  it('rejects untrusted artifact files and inaccessible paths', async () => {
    await expect(runCloudHypervisorPreflight(
      config({ cloudHypervisorBinary: 'relative/cloud-hypervisor' }),
      dependencies(),
    )).rejects.toThrow(/path must be absolute/);
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({
        lstat: jest.fn(async (filePath: string) => (
          filePath === '/opt/cloud-hypervisor'
            ? {
                isFile: () => false,
                isSymbolicLink: () => true,
                mode: 0o120777,
                uid: 0,
              }
            : {
                isFile: () => false,
                isSymbolicLink: () => false,
                mode: 0o040755,
                uid: 0,
              }
        )),
      }),
    )).rejects.toThrow(/regular file and not a symbolic link/);
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({
        lstat: jest.fn().mockResolvedValue({
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o100755,
          uid: 4000,
        }),
      }),
    )).rejects.toThrow(/must be owned by root or uid/);
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({
        access: jest.fn(async (filePath: string) => {
          if (filePath !== '/dev/kvm') throw new Error('EACCES');
        }),
      }),
    )).rejects.toThrow(/does not have the required host access/);
  });

  it('uses SUDO_UID as trusted owner when running under sudo', async () => {
    process.env.SUDO_UID = '2001';
    const lstat = jest.fn().mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100755,
      uid: 2001,
    });
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({ uid: undefined, lstat }),
    )).resolves.toMatchObject({ version: '53.0' });
  });

  it('rejects writable or symlinked parent directories', async () => {
    const lstat = jest.fn(async (filePath: string) => {
      if (filePath === '/opt') {
        return {
          isFile: () => false,
          isSymbolicLink: () => false,
          mode: 0o040777,
          uid: 0,
        };
      }
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: 0o100755,
        uid: 0,
      };
    });
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({ lstat }),
    )).rejects.toThrow(/parent directory must not be group- or world-writable/);

    const symlinkParent = jest.fn(async (filePath: string) => {
      if (filePath === '/opt') {
        return {
          isFile: () => false,
          isSymbolicLink: () => true,
          mode: 0o040755,
          uid: 0,
        };
      }
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: 0o100755,
        uid: 0,
      };
    });
    await expect(runCloudHypervisorPreflight(
      config(),
      dependencies({ lstat: symlinkParent }),
    )).rejects.toThrow(/parent directory must not be a symbolic link/);
  });

  it('rejects user-controlled PATH tools', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-ch-preflight-tool-'));
    const tool = path.join(directory, 'ip');
    await fs.writeFile(tool, '#!/bin/sh\n');
    await fs.chmod(tool, 0o755);
    process.env.PATH = directory;
    try {
      await expect(cloudHypervisorPreflightTestHelpers.defaultDependencies.assertToolAvailable('ip'))
        .rejects.toThrow(/trusted host tool "ip"/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
