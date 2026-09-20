import {
  NVX_ARTIFACT_RELEASE_TAG,
  NVX_ARTIFACT_REPOSITORY,
  NVX_ARTIFACT_SIGNER_WORKFLOW,
  NVX_COMMIT,
  NVX_OPENVMM_COMMIT,
  NVX_RELEASE_TAG,
} from './artifact-manifest';
import {
  runNvxPreflight,
  type NvxArtifactSnapshot,
  type NvxPreflightDependencies,
} from './preflight';

const DIGESTS = {
  launcher: '1'.repeat(64),
  openvmm: '2'.repeat(64),
  kernel: '3'.repeat(64),
  initramfs: '4'.repeat(64),
};

function manifest() {
  return JSON.stringify({
    schemaVersion: 1,
    release: {
      repository: NVX_ARTIFACT_REPOSITORY,
      workflow: NVX_ARTIFACT_SIGNER_WORKFLOW,
      tag: NVX_ARTIFACT_RELEASE_TAG,
      sourceCommit: 'a'.repeat(40),
    },
    upstream: {
      releaseTag: NVX_RELEASE_TAG,
      nvxCommit: NVX_COMMIT,
      openvmmCommit: NVX_OPENVMM_COMMIT,
    },
    architecture: 'x86_64',
    artifacts: {
      launcher: { file: 'nvx.py', sizeBytes: 100, sha256: DIGESTS.launcher },
      openvmm: { file: 'openvmm', sizeBytes: 100, sha256: DIGESTS.openvmm },
      kernel: { file: 'vmlinux', sizeBytes: 100, sha256: DIGESTS.kernel },
      initramfs: { file: 'initramfs.cpio.gz', sizeBytes: 100, sha256: DIGESTS.initramfs },
    },
  });
}

const options = {
  expectedReleaseTag: NVX_ARTIFACT_RELEASE_TAG,
  manifestPath: '/trusted/manifest.json',
  artifactManifestBundlePath: '/trusted/manifest.sigstore.json',
  artifacts: {
    launcher: '/trusted/nvx.py',
    openvmm: '/trusted/openvmm',
    kernel: '/trusted/vmlinux',
    initramfs: '/trusted/initramfs.cpio.gz',
  },
};

function snapshot(): NvxArtifactSnapshot {
  return {
    directory: '/run/awf-nvx/trusted-artifacts/run-test',
    launcher: '/run/awf-nvx/trusted-artifacts/run-test/nvx.py',
    openvmm: '/run/awf-nvx/trusted-artifacts/run-test/openvmm',
    kernel: '/run/awf-nvx/trusted-artifacts/run-test/vmlinux',
    initramfs: '/run/awf-nvx/trusted-artifacts/run-test/initramfs.cpio.gz',
    manifestPath: '/run/awf-nvx/trusted-artifacts/run-test/manifest.json',
    bundlePath: '/run/awf-nvx/trusted-artifacts/run-test/manifest.sigstore.json',
  };
}

function dependencies(overrides: Partial<NvxPreflightDependencies> = {}):
NvxPreflightDependencies {
  return {
    platform: 'linux',
    arch: 'x64',
    effectiveUid: 0,
    access: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn(async (filePath) => {
      if (filePath === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory pids';
      if (filePath === '/proc/sys/kernel/seccomp/actions_avail') {
        return 'kill_process kill_thread errno';
      }
      if (filePath === options.manifestPath) return manifest();
      if (filePath === snapshot().manifestPath) return manifest();
      throw new Error(`unexpected read: ${filePath}`);
    }),
    lstat: jest.fn(async (filePath) => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: filePath.endsWith('nvx.py') || filePath.endsWith('openvmm')
        ? 0o100500
        : 0o100400,
      size: 100,
    })),
    sha256: jest.fn(async (filePath) => {
      if (filePath.endsWith('nvx.py')) return DIGESTS.launcher;
      if (filePath.endsWith('openvmm')) return DIGESTS.openvmm;
      if (filePath.endsWith('vmlinux')) return DIGESTS.kernel;
      if (filePath.endsWith('initramfs.cpio.gz')) return DIGESTS.initramfs;
      throw new Error(`unexpected digest: ${filePath}`);
    }),
    resolveTool: jest.fn(async (name) => `/usr/bin/${name}`),
    verifyAttestation: jest.fn().mockResolvedValue(undefined),
    createSnapshot: jest.fn().mockResolvedValue(snapshot()),
    removeSnapshot: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('NVX preflight', () => {
  it('requires host controls, verifies attestation and digests, then re-verifies a snapshot', async () => {
    const deps = dependencies();
    const result = await runNvxPreflight(options, deps);

    expect(result.snapshot).toEqual(snapshot());
    expect(deps.access).toHaveBeenCalledWith('/dev/kvm', expect.any(Number));
    expect(deps.access).toHaveBeenCalledWith('/dev/net/tun', expect.any(Number));
    expect(deps.verifyAttestation).toHaveBeenCalledWith(
      '/usr/bin/gh',
      snapshot().manifestPath,
      snapshot().bundlePath,
    );
    expect(deps.sha256).toHaveBeenCalledTimes(4);
  });

  it('rejects source artifacts whose sizes do not match the manifest before copying', async () => {
    const deps = dependencies({
      lstat: jest.fn(async (filePath) => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        mode: filePath.endsWith('nvx.py') || filePath.endsWith('openvmm')
          ? 0o100500
          : 0o100400,
        size: filePath === options.artifacts.kernel ? 101 : 100,
      })),
    });

    await expect(runNvxPreflight(options, deps)).rejects.toThrow(/source NVX kernel/);
    expect(deps.createSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['non-Linux host', { platform: 'darwin' as NodeJS.Platform }, /Linux x86_64/],
    ['non-root execution', { effectiveUid: 501 }, /effective uid 0/],
    ['missing cgroup controller', {
      readFile: jest.fn(async (filePath: string) =>
        filePath === '/sys/fs/cgroup/cgroup.controllers'
          ? 'cpu memory'
          : filePath === '/proc/sys/kernel/seccomp/actions_avail'
            ? 'kill_process'
            : filePath === options.manifestPath
              ? manifest()
            : filePath === snapshot().manifestPath
              ? manifest()
              : Promise.reject(new Error(`unexpected read: ${filePath}`))),
    }, /controller: pids/],
  ])('fails closed for %s', async (_label, overrides, error) => {
    await expect(runNvxPreflight(
      options,
      dependencies(overrides),
    )).rejects.toThrow(error);
  });

  it('removes a snapshot whose copied digest does not match', async () => {
    const deps = dependencies({
      sha256: jest.fn(async (filePath) =>
        filePath.startsWith('/run/awf-nvx/') && filePath.endsWith('openvmm')
          ? 'f'.repeat(64)
          : filePath.endsWith('nvx.py')
            ? DIGESTS.launcher
            : filePath.endsWith('openvmm')
              ? DIGESTS.openvmm
              : filePath.endsWith('vmlinux')
                ? DIGESTS.kernel
                : DIGESTS.initramfs),
    });

    await expect(runNvxPreflight(options, deps)).rejects.toThrow(/digest changed/);
    expect(deps.removeSnapshot).toHaveBeenCalledWith(snapshot().directory);
  });
});
