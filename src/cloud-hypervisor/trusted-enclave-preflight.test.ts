import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { CloudHypervisorEnclaveHostServiceOptions } from '../enclave/cloud-hypervisor-host-service';
import { HostExecutorResourceJournal, hostExecutorStorageDirectory, hostExecutorVmRunId } from '../enclave/host-executor-journal';
import type { HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { CloudHypervisorArtifactSnapshotSources } from './artifact-snapshot';
import { CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG } from './artifact-manifest';
import { assertTrustedHostTool } from './artifact-trust';
import { preflightCloudHypervisorEnclaveArtifacts } from './enclave-artifact-preflight';
import type { CloudHypervisorEnclaveArtifactPreflightOptions } from './enclave-executor-types';
import { runCloudHypervisorPreflight, type CloudHypervisorPreflightDependencies } from './preflight';
import { createBoundedEnclavePreflight } from './trusted-enclave-preflight';
import { prepareTrustedInvocationStorage } from './trusted-enclave-storage';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES as profiles } from './workload-profile';

jest.mock('./artifact-trust', () => ({
  ...jest.requireActual('./artifact-trust'),
  assertTrustedAncestorChain: jest.fn(),
  assertTrustedHostTool: jest.fn(),
}));
jest.mock('./trusted-enclave-storage', () => ({ prepareTrustedInvocationStorage: jest.fn() }));
jest.mock('./enclave-artifact-preflight', () => ({ preflightCloudHypervisorEnclaveArtifacts: jest.fn() }));
jest.mock('./preflight', () => ({
  ...jest.requireActual('./preflight'), runCloudHypervisorPreflight: jest.fn(),
}));

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const config: CloudHypervisorOptions = {
  previewEnabled: true, mountPolicy: 'workspace-only',
  cloudHypervisorBinary: '/operator/cloud-hypervisor',
  kernelPath: '/operator/vmlinux.bin', rootfsPath: '/operator/rootfs.ext4',
  supervisorPath: '/operator/awf-supervisor',
  artifactManifestPath: '/operator/manifest.json',
  artifactManifestBundlePath: '/operator/manifest.sigstore.jsonl',
  artifactReleaseTag: CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG, vcpuCount: 2, memoryMib: 512, apiTimeoutMs: 5000,
};

function options(roles: readonly ('script' | 'agent')[] = ['script']): CloudHypervisorEnclaveHostServiceOptions {
  return {
    config, workDir: '/private/work', runtimeDir: '/private/runtime', environment: { PATH: '/trusted' },
    runState: {
      runId: 'a'.repeat(32), seedsDir: '/private/seeds', invocationsDir: '/private/invocations',
      entries: roles.map((executorKind) => ({
        entryId: `configured-${executorKind}`, executorKind, timeoutMs: 5000,
        staticSeedIds: [], dynamicAgents: false,
      })),
    },
  };
}

describe('bounded immutable enclave preflight', () => {
  let events: string[];
  let sources: Map<string, string>;
  let snapshot: Map<string, string>;
  let active: Set<string>;
  let plan: HostExecutorInvocationPlan;
  let root: string;
  let sealed: boolean;
  let journal: {
    captureDirectory: jest.Mock; captureMount: jest.Mock;
    prepareSnapshot: jest.Mock; captureSnapshot: jest.Mock;
    closeStorage: jest.Mock; verifyDirectory: jest.Mock; complete: jest.Mock;
  };
  let close: jest.Mock;
  let createSnapshot: jest.Mock;
  let mountTmpfs: jest.Mock;
  let probes: Partial<CloudHypervisorPreflightDependencies>;

  beforeEach(() => {
    jest.resetAllMocks();
    events = [];
    active = new Set();
    sealed = false;
    snapshot = new Map();
    const artifacts = {
      cloudHypervisor: { file: 'cloud-hypervisor', version: '53.0' },
      virtiofsd: { file: 'virtiofsd', version: '1.13.3' },
      kernel: { file: 'vmlinux.bin', version: '6.1.141' },
      rootfs: { file: 'rootfs.ext4', version: CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG },
      supervisor: { file: 'awf-supervisor', version: CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG },
    };
    sources = new Map(Object.values(artifacts).map((artifact) =>
      [`/operator/${artifact.file}`, artifact.file]));
    sources.set(config.artifactManifestPath!, JSON.stringify({
      schemaVersion: 1, architecture: 'x86_64',
      release: {
        repository: 'github/gh-aw-firewall',
        workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
        tag: CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG, sourceCommit: 'b'.repeat(40),
      },
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) =>
        [name, { ...artifact, sha256: sha256(artifact.file) }])),
    }));
    sources.set(config.artifactManifestBundlePath!, 'attestation');
    journal = {
      captureDirectory: jest.fn(async () => { events.push('capture-directory'); }),
      captureMount: jest.fn(async () => { events.push('capture-mount'); }),
      prepareSnapshot: jest.fn(async () => { events.push('prepare-snapshot'); }),
      captureSnapshot: jest.fn(async () => { events.push('capture-snapshot'); }),
      closeStorage: jest.fn(async () => { events.push('close-partial'); }),
      verifyDirectory: jest.fn(async () => { events.push('verify-directory'); }),
      complete: jest.fn(async () => { events.push('complete'); }),
    };
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'lstat').mockResolvedValue({
      uid: 0, mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false,
    } as Awaited<ReturnType<typeof fs.lstat>>);
    jest.spyOn(fs, 'realpath').mockImplementation(async (value) => String(value));
    jest.spyOn(fs, 'rm').mockImplementation(async () => { events.push('remove-directory'); });
    (assertTrustedHostTool as jest.Mock).mockImplementation(async (tool) => { events.push(`tool-${tool}`); });
    jest.spyOn(HostExecutorResourceJournal, 'create').mockImplementation(async (_run, value, id) => {
      plan = value;
      root = hostExecutorStorageDirectory(id);
      expect(active.has(root)).toBe(true);
      events.push('journal');
      return journal as unknown as HostExecutorResourceJournal;
    });
    close = jest.fn(async () => { events.push('close'); });
    mountTmpfs = jest.fn(async () => { events.push('mount'); });
    createSnapshot = jest.fn(async (input: CloudHypervisorArtifactSnapshotSources, _copy, capture) => {
      expect(active.has(root)).toBe(true);
      expect(journal.prepareSnapshot).toHaveBeenCalled();
      const directory = path.join(root, 'artifacts', 'run-snapshot');
      await capture(directory);
      const copied = Object.fromEntries(Object.entries(input).map(([key, source]) => {
        const destination = path.join(directory, path.basename(source as string));
        snapshot.set(destination, sources.get(source as string)!);
        return [key, destination];
      }));
      sealed = true;
      events.push('seal');
      return { ...copied, directory };
    });
    (prepareTrustedInvocationStorage as jest.Mock).mockImplementation(async (_run, value, passedJournal, tools) => {
      expect(value).toBe(plan);
      expect(passedJournal).toBe(journal);
      expect(tools).toEqual({ mount: '/trusted/mount', umount: '/trusted/umount' });
      events.push('allocate');
      return {
        workDir: root, dependencies: {
          createArtifactSnapshot: createSnapshot, mountTmpfs,
          verifyStorage: jest.fn(async () => { events.push('verify-storage'); }),
        },
        managerDependencies: {}, close,
      };
    });
    probes = {
      platform: 'linux', arch: 'x64', uid: 1000,
      access: jest.fn(async () => undefined),
      lstat: jest.fn(async () => ({
        uid: 1000, mode: 0o100755, size: 1, isFile: () => true, isSymbolicLink: () => false,
      })),
      assertToolAvailable: jest.fn(async (tool) => `/trusted/${tool}`),
      copySparseFile: jest.fn(),
      verifyManifestAttestation: jest.fn(async (_tool, subject) => {
        expect(sealed).toBe(true);
        expect(subject.startsWith(`${root}/artifacts/`)).toBe(true);
        events.push('attest');
        sources.set(config.artifactManifestPath!, '{"swapped":true}');
      }),
      readFile: jest.fn(async (file) => {
        expect(sealed).toBe(true);
        expect(snapshot.has(file)).toBe(true);
        events.push('parse');
        return snapshot.get(file)!;
      }),
      sha256: jest.fn(async (file) => {
        expect(sealed).toBe(true);
        expect(snapshot.has(file)).toBe(true);
        sources.set(config.cloudHypervisorBinary, 'malicious-binary');
        return sha256(snapshot.get(file)!);
      }),
      runVersion: jest.fn(async (binary) => {
        expect(sealed).toBe(true);
        expect(snapshot.has(binary)).toBe(true);
        expect(snapshot.get(binary)).toBe(path.basename(binary));
        events.push('version');
        return binary.endsWith('/virtiofsd') ? 'virtiofsd 1.13.3' : 'cloud-hypervisor v53.0';
      }),
      assertHostPolicy: jest.fn(async () => 2),
      assertDockerInfrastructure: jest.fn(),
      resolveKvmGid: jest.fn(async () => 978),
    };
    (runCloudHypervisorPreflight as jest.Mock).mockImplementation((input, overrides) =>
      jest.requireActual('./preflight').runCloudHypervisorPreflight(input, { ...probes, ...overrides }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('attests, parses, hashes and probes only the sealed snapshot despite operator source swaps', async () => {
    const result = await createBoundedEnclavePreflight(options(), active).preflight(config);
    expect(result).toMatchObject({
      cloudHypervisorBinary: config.cloudHypervisorBinary, virtiofsdBinary: '/operator/virtiofsd',
      kernelPath: config.kernelPath, rootfsPath: config.rootfsPath, supervisorPath: config.supervisorPath,
      artifactDigests: { cloudHypervisor: sha256('cloud-hypervisor') },
      version: '53.0', kvmGid: 978, cgroupVersion: 2,
    });
    expect(sources.get(config.cloudHypervisorBinary)).toBe('malicious-binary');
    expect(sources.get(config.artifactManifestPath!)).toBe('{"swapped":true}');
    expect(events.indexOf('seal')).toBeLessThan(events.indexOf('attest'));
    expect(events.indexOf('attest')).toBeLessThan(events.indexOf('parse'));
    expect(events.slice(-4)).toEqual(['close', 'verify-directory', 'remove-directory', 'complete']);
    expect(active.size).toBe(0);
    expect(journal.captureSnapshot).toHaveBeenCalledWith(`${root}/artifacts/run-snapshot`);
    expect(plan.entryId).toBe('configured-script');
    expect(plan.invocationId).toMatch(/^[0-9a-f]{32}$/);
    expect(root).toBe(hostExecutorStorageDirectory(hostExecutorVmRunId(plan)));
    expect(mountTmpfs).toHaveBeenCalledWith(plan.invocationHostDir, profiles.script.writableStorageBytes,
      profiles.script.uid, profiles.script.gid, { mount: '/trusted/mount', umount: '/trusted/umount' });
  });

  it.each([{ roles: ['script'] }, { roles: ['agent'] }, { roles: ['script', 'agent'] }] as {
    roles: ('script' | 'agent')[];
  }[])(
    'uses only the actual configured role cap for $roles', async ({ roles }) => {
      await createBoundedEnclavePreflight(options(roles), active).preflight(config);
      const role = roles.includes('agent') ? 'agent' : 'script';
      expect(plan.executorKind).toBe(role);
      expect(mountTmpfs.mock.calls[0][1]).toBe(profiles[role].writableStorageBytes);
    },
  );

  it('bounds captured role attestation bytes within a separate owned domain', async () => {
    const artifactOptions = { manifestPath: '/operator/enclave-manifest' } as CloudHypervisorEnclaveArtifactPreflightOptions;
    const result = { verified: true };
    (preflightCloudHypervisorEnclaveArtifacts as jest.Mock).mockImplementation(async (input, verificationRoot) => {
      expect(input).toBe(artifactOptions);
      expect(verificationRoot).toBe(`${root}/verification`);
      expect(active.has(root)).toBe(true);
      return result;
    });
    await expect(createBoundedEnclavePreflight(options(['agent']), active)
      .preflightEnclaveArtifacts(artifactOptions)).resolves.toBe(result);
    expect(fs.mkdir).toHaveBeenCalledWith(`${root}/verification`, { mode: 0o700 });
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(journal.complete).toHaveBeenCalled();
    expect(active.size).toBe(0);
  });

  it('stages captured role manifest and bundle bytes only beneath the trusted optional verification root', async () => {
    const verificationRoot = '/private/bounded/verification';
    const directory = `${verificationRoot}/awf-enclave-attestation-fixture`;
    const manifestPath = '/operator/enclave-manifest.json';
    const bundlePath = '/operator/cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl';
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
    (fs.lstat as jest.Mock).mockResolvedValue({
      uid: 0, mode: 0o100400, size: 2, isFile: () => true, isSymbolicLink: () => false,
    });
    jest.spyOn(fs, 'open').mockImplementation(async (file) => {
      const content = Buffer.from(String(file) === manifestPath ? '{}' : 'bundle');
      return {
        stat: async () => ({ uid: 0, mode: 0o100400, size: content.length, isFile: () => true }),
        read: async (buffer: Buffer, _offset: number, length: number, position: number) => {
          const bytes = content.subarray(position, position + length);
          bytes.copy(buffer);
          return { bytesRead: bytes.length };
        },
        close: async () => undefined,
      } as unknown as Awaited<ReturnType<typeof fs.open>>;
    });
    jest.spyOn(fs, 'mkdtemp').mockResolvedValue(directory);
    jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    const actual = jest.requireActual('./enclave-artifact-preflight') as typeof import('./enclave-artifact-preflight');
    await expect(actual.preflightCloudHypervisorEnclaveArtifacts({
      releaseTag: CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG, manifestPath, manifestBundlePath: bundlePath,
      scriptRootfsPath: '/operator/script-rootfs', agentRootfsPath: '/operator/agent-rootfs',
      attestationToolPath: '/trusted/gh',
    }, verificationRoot)).rejects.toThrow();
    expect(fs.mkdtemp).toHaveBeenCalledWith(`${verificationRoot}/awf-enclave-attestation-`);
    expect(fs.writeFile).toHaveBeenCalledWith(`${directory}/manifest.json`, Buffer.from('{}'),
      { flag: 'wx', mode: 0o400 });
    expect(fs.writeFile).toHaveBeenCalledWith(
      `${directory}/cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl`, Buffer.from('bundle'),
      { flag: 'wx', mode: 0o400 },
    );
    expect(fs.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  });

  it.each([
    { field: 'tag', value: `${CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG}-mismatch`, error: /manifest release mismatch/ },
    { field: 'repository', value: 'attacker/repo', error: /release.repository must be/ },
    { field: 'workflow', value: 'attacker/repo/.github/workflows/release.yml', error: /release.workflow must be/ },
    { field: 'sourceCommit', value: 'not-a-commit', error: /lowercase 40-character Git SHA/ },
  ])('rejects sealed manifest $field mismatches before executing artifact probes', async ({ field, value, error }) => {
    const manifest: { release: Record<string, string> } = JSON.parse(sources.get(config.artifactManifestPath!)!);
    manifest.release[field] = value;
    sources.set(config.artifactManifestPath!, JSON.stringify(manifest));
    await expect(createBoundedEnclavePreflight(options(), active).preflight(config)).rejects.toThrow(error);
    expect(probes.verifyManifestAttestation).toHaveBeenCalled();
    expect(probes.runVersion).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(journal.complete).toHaveBeenCalled();
    expect(active.size).toBe(0);
  });

  it.each([
    { gate: 'attestation', error: /attestation failed/ },
    { gate: 'digest', error: /SHA-256 mismatch/ },
    { gate: 'version', error: /pinned to v53\.0/ },
    { gate: 'basename', error: /must be named cloud-hypervisor/ },
    { gate: 'KVM', error: /KVM unavailable/ },
    { gate: 'release', error: /must match this AWF release/ },
  ])(
    'preserves the existing $gate gate and cleans before rejection', async ({ gate, error }) => {
      let input = config;
      if (gate === 'attestation') (probes.verifyManifestAttestation as jest.Mock).mockRejectedValue(new Error('attestation failed'));
      if (gate === 'digest') (probes.sha256 as jest.Mock).mockResolvedValue('f'.repeat(64));
      if (gate === 'version') (probes.runVersion as jest.Mock).mockResolvedValue('cloud-hypervisor v52.0');
      if (gate === 'basename') input = { ...config, cloudHypervisorBinary: '/operator/renamed' };
      if (gate === 'release') input = { ...config, artifactReleaseTag: `${CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG}-mismatch` };
      if (gate === 'KVM') (probes.access as jest.Mock).mockImplementation(async (file) => {
        if (file === '/dev/kvm') throw new Error('KVM unavailable');
      });
      await expect(createBoundedEnclavePreflight(options(), active).preflight(input)).rejects.toThrow(error);
      expect(close).toHaveBeenCalled();
      expect(journal.complete).toHaveBeenCalled();
      expect(active.size).toBe(0);
    },
  );

  it('cleans an identity-known domain after a captured partial snapshot was deleted by its copy helper', async () => {
    createSnapshot.mockImplementation(async (_sources, _copy, capture) => {
      await capture(`${root}/artifacts/run-partial`);
      throw new Error('storage full while copying');
    });
    await expect(createBoundedEnclavePreflight(options(), active).preflight(config))
      .rejects.toThrow('storage full while copying');
    expect(close).toHaveBeenCalled();
    expect(journal.complete).toHaveBeenCalled();
    expect(active.size).toBe(0);
    expect(probes.verifyManifestAttestation).not.toHaveBeenCalled();
    expect(probes.runVersion).not.toHaveBeenCalled();
  });

  it('retains the active domain and does not release source paths on a busy cleanup', async () => {
    close.mockRejectedValue(new Error('storage unmount failed'));
    await expect(createBoundedEnclavePreflight(options(), active).preflight(config))
      .rejects.toThrow('storage unmount failed');
    expect(active.has(root)).toBe(true);
    expect(fs.rm).not.toHaveBeenCalled();
    expect(journal.complete).not.toHaveBeenCalled();
  });

  it('tries identity-journal cleanup after allocation fails, retaining active enforcement if it fails', async () => {
    (prepareTrustedInvocationStorage as jest.Mock).mockRejectedValue(new Error('partial mount'));
    journal.closeStorage.mockRejectedValue(new Error('uncommitted mount'));
    await expect(createBoundedEnclavePreflight(options(), active).preflight(config))
      .rejects.toThrow('uncommitted mount');
    expect(journal.closeStorage).toHaveBeenCalledWith('/trusted/umount');
    expect(active.has(root)).toBe(true);
    expect(journal.complete).not.toHaveBeenCalled();
  });

  it('retains the active identity when journal creation cannot be confirmed', async () => {
    (HostExecutorResourceJournal.create as jest.Mock).mockRejectedValue(new Error('journal write failed'));
    await expect(createBoundedEnclavePreflight(options(), active).preflight(config))
      .rejects.toThrow('journal write failed');
    expect(active.size).toBe(1);
    expect(prepareTrustedInvocationStorage).not.toHaveBeenCalled();
  });

  it('resolves trusted mount tools before creating resources and rejects missing roles', async () => {
    (assertTrustedHostTool as jest.Mock).mockRejectedValue(new Error('operator-writable tool'));
    await expect(createBoundedEnclavePreflight(options(), active).preflight(config))
      .rejects.toThrow('trusted host tool "mount"');
    expect(HostExecutorResourceJournal.create).not.toHaveBeenCalled();
    expect(prepareTrustedInvocationStorage).not.toHaveBeenCalled();
    await expect(createBoundedEnclavePreflight(options([]), active).preflight(config))
      .rejects.toThrow('configured static role');
  });

  it('rejects operator-owned invocation parents before privileged allocation', async () => {
    (fs.lstat as jest.Mock).mockResolvedValue({
      uid: 1000, mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false,
    });
    await expect(createBoundedEnclavePreflight(options(), active).preflight(config))
      .rejects.toThrow('root-owned');
    expect(prepareTrustedInvocationStorage).not.toHaveBeenCalled();
  });

  it('rejects a sticky world-writable ancestor rather than relaxing invocation trust', async () => {
    (fs.lstat as jest.Mock).mockImplementation(async (directory) => ({
      uid: 0, mode: directory === '/var/tmp' ? 0o41777 : 0o40700,
      isDirectory: () => true, isSymbolicLink: () => false,
    }));
    const input = options();
    input.runState.invocationsDir = '/var/tmp/private/invocations';
    await expect(createBoundedEnclavePreflight(input, active).preflight(config)).rejects.toThrow('root-owned trusted');
    expect(prepareTrustedInvocationStorage).not.toHaveBeenCalled();
    expect(HostExecutorResourceJournal.create).not.toHaveBeenCalled();
  });
});
