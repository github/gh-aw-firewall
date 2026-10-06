import { promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import type { WrapperConfig } from '../types';
import {
  hostExecutorStorageDirectory, hostExecutorVmRunId, type HostExecutorResourceJournal,
} from '../enclave/host-executor-journal';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from '../enclave/host-executor-server';
import { CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED } from '../enclave/cloud-hypervisor-lifecycle';
import { createArtifactSnapshot } from './artifact-snapshot';
import {
  ProductionTrustedCloudHypervisorEnclaveStorageProvider, prepareTrustedInvocationStorage,
  type TrustedEnclaveStorageHostDependencies,
} from './trusted-enclave-storage';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES as profiles } from './workload-profile';
import type { CloudHypervisorHostToolPaths } from './preflight';
import { HostPreflightReporter, type HostPreflightProgress } from './host-preflight-progress';

jest.mock('execa');
jest.mock('./artifact-snapshot', () => ({
  ...jest.requireActual('./artifact-snapshot'), createArtifactSnapshot: jest.fn(),
}));

const config = {} as WrapperConfig;
function host(overrides: Partial<TrustedEnclaveStorageHostDependencies> = {}): TrustedEnclaveStorageHostDependencies {
  return {
    platform: 'linux', arch: 'x64', uid: 0,
    environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', ImageOS: 'ubuntu24' },
    readFile: jest.fn(async (file) => {
      if (file === '/etc/os-release') return 'ID=ubuntu\n';
      if (file === '/proc/self/status') return 'CapEff:\t0000000000200000\n';
      if (file === '/proc/filesystems') return 'nodev\ttmpfs\n';
      return 'cpu memory pids\n';
    }),
    lstat: jest.fn(async () => ({ isCharacterDevice: () => true })),
    openKvm: jest.fn(async () => undefined),
    access: jest.fn(async () => undefined), ...overrides,
  };
}

describe('production trusted enclave storage availability', () => {
  const unreadable = Object.assign(new Error('/private/SECRET\nBearer credential'), { code: 'EACCES' });
  const changedFile = (file: string, content: string) => {
    const original = host();
    return { readFile: async (candidate: string) => candidate === file ? content : original.readFile(candidate) };
  };
  const deniedFile = (file: string) => {
    const original = host();
    return { access: async (candidate: string, mode: number) => {
      if (candidate === file) throw unreadable;
      return original.access(candidate, mode);
    } };
  };

  it.each([
    { check: 'root', reason: 'requirement-not-met', override: { uid: 1000 } },
    { check: 'runner-eligibility', reason: 'platform-unsupported', override: { platform: 'darwin' } },
    { check: 'runner-eligibility', reason: 'architecture-unsupported', override: { arch: 'arm64' } },
    { check: 'runner-eligibility', reason: 'github-actions-required', override: { environment: {} } },
    { check: 'runner-eligibility', reason: 'runner-not-github-hosted', override: { environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' } } },
    { check: 'runner-eligibility', reason: 'ubuntu-image-required', override: { environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' } } },
    { check: 'ubuntu-distribution', reason: 'requirement-not-met', override: changedFile('/etc/os-release', 'ID=debian\n') },
    { check: 'mount-capability', reason: 'requirement-not-met', override: changedFile('/proc/self/status', 'CapEff:\t0000000000000000\n') },
    { check: 'mount-capability', reason: 'requirement-not-met', override: changedFile('/proc/self/status', 'CapEff:invalid\n') },
    { check: 'tmpfs-support', reason: 'requirement-not-met', override: changedFile('/proc/filesystems', 'nodev\tproc\n') },
    { check: 'kvm-access', reason: 'EACCES', override: deniedFile('/dev/kvm') },
    { check: 'kvm-device', reason: 'requirement-not-met', override: { lstat: async () => ({ isCharacterDevice: () => false }) } },
    { check: 'kvm-open', reason: 'EACCES', override: { openKvm: async () => { throw unreadable; } } },
    { check: 'cgroup-writable', reason: 'EACCES', override: deniedFile('/sys/fs/cgroup') },
    { check: 'cgroup-controllers', reason: 'requirement-not-met', override: changedFile('/sys/fs/cgroup/cgroup.controllers', 'cpu memory\n') },
    { check: 'ubuntu-distribution', reason: 'unknown', override: { readFile: async () => { throw new Error('unsupported SECRET'); } } },
  ])('identifies the real $check gate ($reason) before storage or gateway execution', async ({ check, reason, override }) => {
    const published: HostPreflightProgress[] = [];
    const dependencies = host(override);
    const provider = new ProductionTrustedCloudHypervisorEnclaveStorageProvider(dependencies);
    const prepare = jest.spyOn(provider, 'prepareRun');
    await expect(provider.assertAvailable(config, (value) => published.push(value)))
      .rejects.toThrow(CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED);
    const last = published[published.length - 1];
    const ids = last.checks.map((item) => item.id);
    expect(last).toEqual({
      schemaVersion: 1, scope: 'storage-admission',
      checks: ids.map((id, index) => ({
        id, result: index < ids.indexOf(check as typeof id) ? 'passed' : id === check ? 'failed' : 'not-attempted',
        reason: id === check ? reason : 'none',
      })),
    });
    expect(last.checks.some((item) => item.result === 'attempted')).toBe(false);
    expect(JSON.stringify(published)).not.toMatch(/private|SECRET|Bearer|credential/);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(['/etc/os-release', '/proc/self/status', '/proc/filesystems', '/sys/fs/cgroup/cgroup.controllers'])(
    'reports failed prerequisite reads at their origin without disclosing %s', async (file) => {
      const original = host();
      const dependencies = host({ readFile: async (candidate) => {
        if (candidate === file) throw unreadable;
        return original.readFile(candidate);
      } });
      const publish = jest.fn();
      await expect(new ProductionTrustedCloudHypervisorEnclaveStorageProvider(dependencies).assertAvailable(config, publish))
        .rejects.toMatchObject({ cause: unreadable });
      const record = publish.mock.calls[publish.mock.calls.length - 1][0] as HostPreflightProgress;
      expect(record.checks.filter((check) => check.result === 'failed')).toHaveLength(1);
      expect(record.checks.find((check) => check.result === 'failed')?.reason).toBe('EACCES');
      expect(JSON.stringify(record)).not.toContain(file);
    },
  );

  it('admits only the supported GitHub-hosted Ubuntu KVM/cgroup-v2 root host', async () => {
    const dependencies = host();
    await expect(new ProductionTrustedCloudHypervisorEnclaveStorageProvider(dependencies).assertAvailable(config))
      .resolves.toBeUndefined();
    expect(dependencies.access).toHaveBeenCalledWith('/dev/kvm', 6);
    expect(dependencies.access).toHaveBeenCalledWith('/sys/fs/cgroup', 2);
    expect(dependencies.openKvm).toHaveBeenCalled();
  });

  it.each([
    { platform: 'darwin' }, { arch: 'arm64' }, { uid: 1000 },
    { environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' } },
    { readFile: async () => 'ID=debian\n' },
    { readFile: async (file: string) => file === '/etc/os-release' ? 'ID=ubuntu\n' : 'cpu\n' },
    { access: async () => { throw new Error('KVM or writable cgroup unavailable'); } },
    { environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' } },
    { readFile: async (file: string) => file === '/etc/os-release' ? 'ID=ubuntu\n' : 'CapEff:\t0000000000000000\n' },
    { lstat: async () => ({ isCharacterDevice: () => false }) },
    { openKvm: async () => { throw new Error('device policy blocks KVM'); } },
  ])('retains the exact unavailable/no-fallback admission error: %j', async (overrides) => {
    await expect(new ProductionTrustedCloudHypervisorEnclaveStorageProvider(host(overrides)).assertAvailable(config))
      .rejects.toThrow(CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED);
  });

  it.each([
    ['/proc/self/status', 'CapEff:\t0000000000000000\n'],
    ['/proc/filesystems', 'nodev\tproc\n'],
  ])('rejects missing mount prerequisite %s before opening KVM or creating storage', async (file, contents) => {
    const original = host();
    const dependencies = host({
      ...original,
      readFile: async (candidate) => candidate === file ? contents : original.readFile(candidate),
    });
    await expect(new ProductionTrustedCloudHypervisorEnclaveStorageProvider(dependencies).assertAvailable(config))
      .rejects.toThrow(CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED);
    expect(dependencies.openKvm).not.toHaveBeenCalled();
    expect(dependencies.access).not.toHaveBeenCalled();
  });
});

describe('invocation-wide kernel-enforced storage', () => {
  const tools = { mount: '/trusted/mount', umount: '/trusted/umount' } as CloudHypervisorHostToolPaths;
  afterEach(() => jest.restoreAllMocks());

  it.each([
    'storage-ancestor', 'storage-parent', 'storage-root', 'storage-tmpfs',
    'storage-layout', 'storage-artifact-mount', 'storage-run-mounts',
  ])('identifies the actual allocation gate %s without publishing a filesystem path', async (gate) => {
    const plan = {
      runId: 'a'.repeat(32), entryId: 'script', invocationId: 'b'.repeat(32), executorKind: 'script',
      invocationHostDir: '/private/invocations/script/invocation',
    } as HostExecutorInvocationPlan;
    const root = hostExecutorStorageDirectory(hostExecutorVmRunId(plan));
    const failure = Object.assign(new Error('/private/SECRET\nBearer token'), { code: 'EPERM' });
    const journal = {
      prepareStorage: jest.fn(), captureStorageDirectory: jest.fn(),
      prepareStorageMount: jest.fn(), captureStorageMount: jest.fn(),
    } as unknown as HostExecutorResourceJournal;
    const paths: Record<string, string> = {
      'storage-parent': '/run/awf-cloud-hypervisor',
      'storage-root': '/run/awf-cloud-hypervisor/enclave-storage',
      'storage-layout': `${root}/state`, 'storage-run-mounts': `${root}/runs`,
    };
    jest.spyOn(fs, 'mkdir').mockImplementation(async (file) => {
      if (String(file) === paths[gate]) throw failure;
      return undefined;
    });
    jest.spyOn(fs, 'lstat').mockImplementation(async (file) => {
      if (gate === 'storage-ancestor' && file === '/run') throw failure;
      return { uid: 0, mode: 0o40711, isDirectory: () => true, isSymbolicLink: () => false } as Awaited<ReturnType<typeof fs.lstat>>;
    });
    jest.spyOn(fs, 'realpath').mockImplementation(async (file) => String(file));
    jest.spyOn(fs, 'chown').mockResolvedValue(undefined);
    (execa as unknown as jest.Mock).mockImplementation(async (_tool, args: string[]) => {
      if ((gate === 'storage-tmpfs' && args[0] === '-t')
        || (gate === 'storage-artifact-mount' && args.includes(`${root}/artifacts`))) throw failure;
      return { exitCode: 0, stderr: '' };
    });
    const publish = jest.fn();
    await expect(prepareTrustedInvocationStorage({} as HostExecutorRunState, plan, journal, tools,
      new HostPreflightReporter('bounded-runtime', publish))).rejects.toBe(failure);
    const record = publish.mock.calls[publish.mock.calls.length - 1][0] as HostPreflightProgress;
    expect(record.checks.filter((check) => check.result === 'failed'))
      .toEqual([{ id: gate, result: 'failed', reason: 'EPERM' }]);
    expect(record.checks.find((check) => check.id === 'cloud-hypervisor-version')?.result).toBe('not-attempted');
    expect(JSON.stringify(record)).not.toMatch(/private|SECRET|Bearer|token/);
  });

  it('keeps run admission cleanup blocked when invocation allocation fails partway', async () => {
    jest.spyOn(fs, 'lstat').mockResolvedValue({
      uid: 0, mode: 0o40711, isSymbolicLink: () => false,
    } as Awaited<ReturnType<typeof fs.lstat>>);
    jest.spyOn(fs, 'mkdir').mockRejectedValue(new Error('mount setup unavailable'));
    const provider = new ProductionTrustedCloudHypervisorEnclaveStorageProvider(host());
    const prepared = await provider.prepareRun({} as Parameters<typeof provider.prepareRun>[0]);
    const plan = {
      runId: 'a'.repeat(32), entryId: 'script', invocationId: 'b'.repeat(32), executorKind: 'script',
      invocationHostDir: `/private/invocations/script/${'b'.repeat(32)}`,
    } as HostExecutorInvocationPlan;
    await expect(prepared.backendDependencies!.prepareInvocationStorage!(
      {} as HostExecutorRunState, plan, {
        closeStorage: jest.fn().mockRejectedValue(new Error('mount setup unavailable')),
      } as unknown as HostExecutorResourceJournal, tools,
    )).rejects.toThrow('mount setup unavailable');
    await expect(prepared.close()).rejects.toThrow('enforcement is preserved');
  });

  it('releases the run guard after identity-journal cleanup of a failed allocation succeeds', async () => {
    jest.spyOn(fs, 'lstat').mockResolvedValue({
      uid: 0, mode: 0o40711, isSymbolicLink: () => false,
    } as Awaited<ReturnType<typeof fs.lstat>>);
    jest.spyOn(fs, 'mkdir').mockRejectedValue(new Error('early allocation failure'));
    const provider = new ProductionTrustedCloudHypervisorEnclaveStorageProvider(host());
    const prepared = await provider.prepareRun({} as Parameters<typeof provider.prepareRun>[0]);
    const plan = {
      runId: 'a'.repeat(32), entryId: 'script', invocationId: 'b'.repeat(32), executorKind: 'script',
    } as HostExecutorInvocationPlan;
    const closeStorage = jest.fn().mockResolvedValue(undefined);
    await expect(prepared.backendDependencies!.prepareInvocationStorage!(
      {} as HostExecutorRunState, plan, { closeStorage } as unknown as HostExecutorResourceJournal, tools,
    )).rejects.toThrow('early allocation failure');
    expect(closeStorage).toHaveBeenCalledWith(tools.umount);
    await expect(prepared.close()).resolves.toBeUndefined();
  });

  it.each(['script', 'agent'] as const)('accounts for every %s path on one superblock, with sealed exec artifacts', async (role) => {
    const plan = {
      runId: 'a'.repeat(32), entryId: role, invocationId: 'b'.repeat(32), executorKind: role,
      invocationHostDir: `/private/invocations/${role}/${'b'.repeat(32)}`,
    } as HostExecutorInvocationPlan;
    const run = {} as HostExecutorRunState;
    const root = hostExecutorStorageDirectory(hostExecutorVmRunId(plan));
    const snapshotDirectory = path.join(root, 'artifacts', 'run-fixture');
    const journal = {
      prepareStorage: jest.fn(), captureStorageDirectory: jest.fn(),
      prepareStorageMount: jest.fn(), captureStorageMount: jest.fn(),
      verifyStorage: jest.fn(), closeStorage: jest.fn(),
      releaseStorageMount: jest.fn(),
    } as unknown as HostExecutorResourceJournal;
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'chown').mockResolvedValue(undefined);
    jest.spyOn(fs, 'rm').mockResolvedValue(undefined);
    jest.spyOn(fs, 'lstat').mockResolvedValue({
      isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o40711,
    } as Awaited<ReturnType<typeof fs.lstat>>);
    jest.spyOn(fs, 'realpath').mockImplementation(async (value) => String(value));
    jest.spyOn(fs, 'stat').mockResolvedValue({ dev: 50 } as Awaited<ReturnType<typeof fs.stat>>);
    jest.spyOn(fs, 'statfs').mockResolvedValue({
      type: 0x01021994n, bsize: 4096n, blocks: BigInt(profiles[role].writableStorageBytes / 4096),
    } as Awaited<ReturnType<typeof fs.statfs>>);
    const readMounts = jest.spyOn(fs, 'readFile').mockResolvedValue(
      `901 1 0:50 / ${root} rw,nosuid,nodev,noexec - tmpfs awf-enclave-invocation rw\n` +
      `902 1 0:50 /state ${plan.invocationHostDir} rw,nosuid,nodev,noexec - tmpfs awf-enclave-invocation rw\n` +
      `903 1 0:50 /runs ${root}/runs rw,nosuid,nodev,noexec - tmpfs awf-enclave-invocation rw\n` +
      `904 1 0:50 /cloud-hypervisor-rootfs ${root}/cloud-hypervisor-rootfs rw,nosuid,nodev,noexec - tmpfs awf-enclave-invocation rw\n` +
      `905 1 0:50 /artifacts ${root}/artifacts rw,nosuid,nodev - tmpfs awf-enclave-invocation rw\n` +
      `906 1 0:50 /artifacts/run-fixture ${snapshotDirectory} ro,nosuid,nodev - tmpfs awf-enclave-invocation rw\n`,
    );
    const command = execa as unknown as jest.Mock;
    command.mockResolvedValue({ exitCode: 0, stderr: '' });
    (createArtifactSnapshot as jest.Mock).mockImplementation(async (sources, _copy, capture, stagingRoot) => {
      expect(stagingRoot).toBe(path.join(root, 'artifacts'));
      await capture?.(snapshotDirectory);
      return { ...sources, directory: snapshotDirectory };
    });

    const allocation = await prepareTrustedInvocationStorage(run, plan, journal, tools);
    expect(fs.mkdir).toHaveBeenCalledWith('/run/awf-cloud-hypervisor', { mode: 0o711 });
    expect(fs.mkdir).toHaveBeenCalledWith('/run/awf-cloud-hypervisor/enclave-storage', { mode: 0o711 });
    expect(command).toHaveBeenCalledWith(tools.mount, [
      '-t', 'tmpfs', '-o',
      `size=${profiles[role].writableStorageBytes},mode=0711,uid=0,gid=0,nosuid,nodev,noexec`,
      'awf-enclave-invocation', root,
    ], expect.anything());
    await allocation.dependencies.mountTmpfs!(
      plan.invocationHostDir, profiles[role].writableStorageBytes, profiles[role].uid, profiles[role].gid, tools,
    );
    await allocation.dependencies.verifyStorage!(plan.invocationHostDir, profiles[role].writableStorageBytes,
      ['output', 'runtime', ...(role === 'agent' ? ['session-handoff', 'session-state'] : [])]
        .map((name) => path.join(plan.invocationHostDir, name)));
    await allocation.dependencies.createArtifactSnapshot!({
      cloudHypervisorBinary: '/trusted/cloud-hypervisor', virtiofsdBinary: '/trusted/virtiofsd',
      kernelPath: '/trusted/kernel', rootfsPath: '/trusted/rootfs', supervisorPath: '/trusted/supervisor',
      manifestPath: '/trusted/manifest', bundlePath: '/trusted/bundle',
    }, jest.fn(), jest.fn());
    expect(command).toHaveBeenCalledWith(tools.mount,
      ['-o', 'remount,bind,ro,nosuid,nodev,exec', snapshotDirectory], expect.anything());
    expect(command).toHaveBeenCalledWith(tools.mount,
      ['-o', 'remount,bind,rw,nosuid,nodev,noexec', plan.invocationHostDir], expect.anything());
    const info = String(await fs.readFile('/proc/self/mountinfo', 'utf8'));
    for (const mountPoint of [root, plan.invocationHostDir, `${root}/runs`, `${root}/cloud-hypervisor-rootfs`]) {
      readMounts.mockResolvedValue(info.split('\n').map((line) =>
        line.includes(` ${mountPoint} `) ? line.replace(',noexec', '') : line).join('\n'));
      await expect(allocation.dependencies.verifyStorage!(plan.invocationHostDir,
        profiles[role].writableStorageBytes)).rejects.toThrow('mount options changed');
    }
    readMounts.mockResolvedValue(info.replace(` ${snapshotDirectory} ro,`, ` ${snapshotDirectory} rw,`));
    await expect(allocation.dependencies.verifyStorage!(plan.invocationHostDir,
      profiles[role].writableStorageBytes)).rejects.toThrow('mount options changed');
    readMounts.mockResolvedValue(info);
    const output = path.join(plan.invocationHostDir, 'output');
    jest.spyOn(fs, 'realpath').mockImplementation(async (value) => String(value) === output ? '/outside' : String(value));
    await expect(allocation.dependencies.verifyStorage!(plan.invocationHostDir,
      profiles[role].writableStorageBytes, [output])).rejects.toThrow('storage path changed');
    jest.spyOn(fs, 'realpath').mockImplementation(async (value) => String(value));
    await allocation.dependencies.removeArtifactSnapshot!(snapshotDirectory);
    expect(journal.releaseStorageMount).toHaveBeenCalledWith(snapshotDirectory);
    expect(allocation.workDir).toBe(root);
    const paths = allocation.managerDependencies.createRunPaths!('/snapshot/cloud-hypervisor', hostExecutorVmRunId(plan), {
      kind: `${role}-enclave`, ownerId: role, invocationId: plan.invocationId,
    });
    for (const socket of [paths.apiSocketPath, paths.vsockSocketPath, path.join(paths.runDirectory, 'virtiofs-5.sock')]) {
      expect(Buffer.byteLength(socket)).toBeLessThan(108);
    }
    for (const directory of [paths.runDirectory, paths.rootfsPath, paths.kernelPath, paths.apiSocketPath,
      paths.vsockSocketPath, paths.logPath, paths.serialLogPath, paths.virtiofsdShareDirectory,
      path.join(allocation.workDir, 'cloud-hypervisor-rootfs', paths.runId)]) {
      expect(directory.startsWith(`${root}/`)).toBe(true);
    }
    await expect(allocation.dependencies.verifyStorage!(plan.invocationHostDir,
      profiles[role].writableStorageBytes, ['/outside/output'])).rejects.toThrow('escape');
    await expect(allocation.dependencies.mountTmpfs!('/outside', profiles[role].writableStorageBytes,
      profiles[role].uid, profiles[role].gid, tools)).rejects.toThrow('mismatch');
    (journal.closeStorage as jest.Mock).mockRejectedValueOnce(new Error('busy mount'));
    await expect(allocation.close()).rejects.toThrow('busy mount');
    expect(journal.closeStorage).toHaveBeenCalledWith(tools.umount);
    expect(command.mock.calls.filter(([, args]) => (args as string[]).some((arg) => /lazy|^-l$/.test(arg)))).toEqual([]);
    await allocation.close();
  });
});
