import {
  NVX_ARTIFACT_RELEASE_TAG,
  NVX_ARTIFACT_REPOSITORY,
  NVX_ARTIFACT_SIGNER_WORKFLOW,
  NVX_COMMIT,
  NVX_OPENVMM_COMMIT,
  NVX_RELEASE_TAG,
  NVX_VALIDATION_SIGNER_WORKFLOW,
} from './artifact-manifest';
import {
  resolveTrustedNvxHostTool,
  runNvxPreflight,
  type NvxArtifactSnapshot,
  type NvxPreflightDependencies,
} from './preflight';

const DIGESTS = {
  openvmm: '2'.repeat(64),
  kernel: '3'.repeat(64),
  initramfs: '4'.repeat(64),
};

function manifest() {
  return JSON.stringify({
    schemaVersion: 2,
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
      openvmm: { file: 'openvmm', sizeBytes: 100, sha256: DIGESTS.openvmm },
      kernel: { file: 'vmlinux', sizeBytes: 100, sha256: DIGESTS.kernel },
      initramfs: { file: 'initramfs.cpio.gz', sizeBytes: 100, sha256: DIGESTS.initramfs },
    },
  });
}

const options = {
  runId: 'a'.repeat(32),
  expectedReleaseTag: NVX_ARTIFACT_RELEASE_TAG,
  manifestPath: '/trusted/manifest.json',
  artifactManifestBundlePath: '/trusted/manifest.sigstore.json',
  artifacts: {
    openvmm: '/trusted/openvmm',
    kernel: '/trusted/vmlinux',
    initramfs: '/trusted/initramfs.cpio.gz',
  },
};

function snapshot(): NvxArtifactSnapshot {
  return {
    directory: `/run/awf-nvx/trusted-artifacts/run-${options.runId}`,
    openvmm: `/run/awf-nvx/trusted-artifacts/run-${options.runId}/openvmm`,
    kernel: `/run/awf-nvx/trusted-artifacts/run-${options.runId}/vmlinux`,
    initramfs: `/run/awf-nvx/trusted-artifacts/run-${options.runId}/initramfs.cpio.gz`,
    manifestPath: `/run/awf-nvx/trusted-artifacts/run-${options.runId}/manifest.json`,
    bundlePath:
      `/run/awf-nvx/trusted-artifacts/run-${options.runId}/manifest.sigstore.json`,
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
      mode: filePath.endsWith('openvmm')
        ? 0o100500
        : 0o100400,
      size: 100,
    })),
    sha256: jest.fn(async (filePath) => {
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
    expect(deps.access).not.toHaveBeenCalledWith('/dev/net/tun', expect.any(Number));
    expect(deps.verifyAttestation).toHaveBeenCalledWith(
      '/usr/bin/gh',
      snapshot().manifestPath,
      snapshot().bundlePath,
      NVX_ARTIFACT_SIGNER_WORKFLOW,
    );
    expect(deps.createSnapshot).toHaveBeenCalledWith(
      options,
      expect.objectContaining({
        runId: options.runId,
        artifactSnapshotDirectory: snapshot().directory,
      }),
    );
    expect(deps.sha256).toHaveBeenCalledTimes(3);
  });

  describe('trusted NVX host tool resolution', () => {
    it('accepts a root-owned alternatives symlink whose canonical target stays trusted', async () => {
      const lstat = jest.fn(async (filePath: string) => ({
        isFile: () => filePath === '/usr/sbin/xtables-nft-multi',
        isSymbolicLink: () => false,
        uid: 0,
        mode: 0o100755,
      }));
      const realpath = jest.fn(async (filePath: string) => {
        if (filePath === '/usr/sbin/iptables') return '/usr/sbin/xtables-nft-multi';
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      });

      await expect(resolveTrustedNvxHostTool(
        'iptables',
        { lstat, realpath },
      )).resolves.toBe('/usr/sbin/xtables-nft-multi');
    });

    it('rejects a canonical tool target outside the trusted system directories', async () => {
      const lstat = jest.fn();
      const realpath = jest.fn(async (filePath: string) => {
        if (filePath === '/usr/sbin/iptables') return '/opt/untrusted/iptables';
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      });

      await expect(resolveTrustedNvxHostTool(
        'iptables',
        { lstat, realpath },
      )).rejects.toThrow(/required trusted NVX host tool/);
      expect(lstat).not.toHaveBeenCalled();
    });
  });

  it('accepts an explicitly pinned validation workflow without weakening the default', async () => {
    const signer = NVX_VALIDATION_SIGNER_WORKFLOW;
    const signedManifest = manifest().replace(NVX_ARTIFACT_SIGNER_WORKFLOW, signer);
    const deps = dependencies({
      readFile: jest.fn(async (filePath) => {
        if (filePath === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory pids';
        if (filePath === '/proc/sys/kernel/seccomp/actions_avail') {
          return 'kill_process kill_thread errno';
        }
        if (filePath === options.manifestPath || filePath === snapshot().manifestPath) {
          return signedManifest;
        }
        throw new Error(`unexpected read: ${filePath}`);
      }),
    });

    await runNvxPreflight({ ...options, expectedSignerWorkflow: signer }, deps);

    expect(deps.verifyAttestation).toHaveBeenCalledWith(
      '/usr/bin/gh',
      snapshot().manifestPath,
      snapshot().bundlePath,
      signer,
    );
  });

  it('rejects signer overrides outside the two pinned AWF workflows', async () => {
    await expect(runNvxPreflight({
      ...options,
      expectedSignerWorkflow: 'github/gh-aw-firewall/.github/workflows/untrusted.yml',
    }, dependencies())).rejects.toThrow(/Untrusted NVX artifact signer workflow/);
  });

  it('rejects source artifacts whose sizes do not match the manifest before copying', async () => {
    const deps = dependencies({
      lstat: jest.fn(async (filePath) => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        mode: filePath.endsWith('openvmm')
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
          : filePath.endsWith('openvmm')
              ? DIGESTS.openvmm
              : filePath.endsWith('vmlinux')
                ? DIGESTS.kernel
                : DIGESTS.initramfs),
    });

    await expect(runNvxPreflight(options, deps)).rejects.toThrow(/digest changed/);
    expect(deps.removeSnapshot).toHaveBeenCalledWith(snapshot().directory);
  });

  it('rejects a snapshot outside the canonical per-run directory', async () => {
    const unexpected = {
      ...snapshot(),
      directory: '/run/awf-nvx/trusted-artifacts/run-other',
    };
    const deps = dependencies({
      createSnapshot: jest.fn().mockResolvedValue(unexpected),
    });

    await expect(runNvxPreflight(options, deps)).rejects.toThrow(
      /snapshot directory must be/,
    );
    expect(deps.removeSnapshot).toHaveBeenCalledWith(snapshot().directory);
  });

  it('rejects artifact paths outside the canonical snapshot directory', async () => {
    const unexpected = {
      ...snapshot(),
      openvmm: '/opt/openvmm',
    };
    const deps = dependencies({
      createSnapshot: jest.fn().mockResolvedValue(unexpected),
    });

    await expect(runNvxPreflight(options, deps)).rejects.toThrow(
      /snapshot openvmm must be/,
    );
    expect(deps.verifyAttestation).not.toHaveBeenCalled();
  });
});
