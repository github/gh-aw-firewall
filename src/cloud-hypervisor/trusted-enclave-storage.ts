import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import type { WrapperConfig } from '../types';
import {
  CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED,
  type TrustedCloudHypervisorEnclaveStorageProvider,
} from '../enclave/cloud-hypervisor-lifecycle';
import {
  HOST_EXECUTOR_STORAGE_ROOT, hostExecutorStorageDirectory, hostExecutorVmRunId,
  type HostExecutorResourceJournal,
} from '../enclave/host-executor-journal';
import type { CloudHypervisorEnclaveHostServiceOptions } from '../enclave/cloud-hypervisor-host-service';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from '../enclave/host-executor-server';
import { createArtifactSnapshot } from './artifact-snapshot';
import { assertTrustedAncestorChain } from './artifact-trust';
import { ENCLAVE_STORAGE_SOURCE } from './enclave-storage';
import { resolveCloudHypervisorManagerDependencies } from './manager';
import { createCloudHypervisorRunPaths, type CloudHypervisorManagerDependencies } from './manager-types';
import type { CloudHypervisorHostToolPaths } from './preflight';
import { createBoundedEnclavePreflight } from './trusted-enclave-preflight';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES } from './workload-profile';
import { VirtiofsdManager } from './virtiofsd';
import { parseMountInfoLine } from './cleanup-identity';
import { evaluateGithubHostedRunnerEligibility } from './host-eligibility';
import {
  HostPreflightReporter, markHostPreflightError, type HostPreflightProgress,
} from './host-preflight-progress';

export interface TrustedEnclaveStorageHostDependencies {
  platform: string;
  arch: string;
  environment: NodeJS.ProcessEnv;
  uid: number;
  readFile(file: string): Promise<string>;
  access(file: string, mode: number): Promise<void>;
  lstat(file: string): Promise<{ isCharacterDevice(): boolean }>;
  openKvm(): Promise<void>;
}

const hostDependencies: TrustedEnclaveStorageHostDependencies = {
  platform: process.platform, arch: process.arch, environment: process.env,
  uid: process.getuid?.() ?? -1,
  readFile: (file) => fs.readFile(file, 'utf8'), access: fs.access,
  lstat: fs.lstat,
  openKvm: async () => {
    const handle = await fs.open('/dev/kvm', constants.O_RDWR | constants.O_NOFOLLOW);
    await handle.close();
  },
};

async function mount(tools: Pick<CloudHypervisorHostToolPaths, 'mount'>, args: string[]): Promise<void> {
  const result = await execa(tools.mount, args, { reject: false, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.exitCode !== 0) {
    throw markHostPreflightError(new Error(`Invocation storage mount failed: ${result.stderr.trim()}`), 'command-failed');
  }
}

/** Host-only integration: no configuration option can opt an unsupported runner in. */
export class ProductionTrustedCloudHypervisorEnclaveStorageProvider implements TrustedCloudHypervisorEnclaveStorageProvider {
  constructor(private readonly host = hostDependencies) { }

  async assertAvailable(_config: WrapperConfig, publish?: (progress: HostPreflightProgress) => void): Promise<void> {
    const report = new HostPreflightReporter('storage-admission', publish);
    const requireHost = (condition: boolean, message: string): void => {
      if (!condition) throw markHostPreflightError(new Error(message), 'requirement-not-met');
    };
    try {
      const host = this.host;
      await report.check('root', () => requireHost(host.uid === 0, 'Unsupported runner'));
      await report.check('runner-eligibility', () => {
        const eligibility = evaluateGithubHostedRunnerEligibility({
          platform: host.platform as NodeJS.Platform, arch: host.arch,
          githubActions: host.environment.GITHUB_ACTIONS,
          runnerEnvironment: host.environment.RUNNER_ENVIRONMENT,
          imageOs: host.environment.ImageOS,
        });
        if (!eligibility.eligible) {
          throw markHostPreflightError(new Error('Unsupported runner'), eligibility.code ?? 'unknown');
        }
      });
      await report.check('ubuntu-distribution', async () => {
        const release = await host.readFile('/etc/os-release');
        requireHost(/^ID=(?:"ubuntu"|ubuntu)$/m.test(release), 'Unsupported distribution');
      });
      await report.check('mount-capability', async () => {
        const capabilities = /^CapEff:\s+([0-9a-fA-F]{1,16})$/m.exec(await host.readFile('/proc/self/status'));
        requireHost(!!capabilities && (BigInt(`0x${capabilities[1]}`) & (1n << 21n)) !== 0n,
          'Required host mount capability unavailable');
      });
      await report.check('tmpfs-support', async () => {
        requireHost((await host.readFile('/proc/filesystems')).split('\n').some((line) => {
          const fields = line.trim().split(/\s+/);
          return fields.length === 2 && fields[0] === 'nodev' && fields[1] === 'tmpfs';
        }), 'Kernel tmpfs support unavailable');
      });
      await report.check('kvm-access', () => host.access('/dev/kvm', constants.R_OK | constants.W_OK));
      await report.check('kvm-device', async () =>
        requireHost((await host.lstat('/dev/kvm')).isCharacterDevice(), 'KVM device unavailable'));
      await report.check('kvm-open', () => host.openKvm());
      await report.check('cgroup-writable', () => host.access('/sys/fs/cgroup', constants.W_OK));
      await report.check('cgroup-controllers', async () => {
        const controllers = (await host.readFile('/sys/fs/cgroup/cgroup.controllers')).trim().split(/\s+/);
        requireHost(['cpu', 'memory', 'pids'].every((controller) => controllers.includes(controller)),
          'Required cgroup v2 controllers unavailable');
      });
    } catch (error) {
      const unavailable = new Error(CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED);
      Object.defineProperty(unavailable, 'cause', { value: error });
      throw unavailable;
    }
  }

  async prepareRun(options: CloudHypervisorEnclaveHostServiceOptions): Promise<Awaited<
    ReturnType<TrustedCloudHypervisorEnclaveStorageProvider['prepareRun']>
  >> {
    const active = new Set<string>();
    return {
      backendDependencies: {
        ...createBoundedEnclavePreflight(options, active),
        removeArtifactSnapshot: async () => undefined,
        prepareInvocationStorage: async (run, plan, journal, tools) => {
          const root = hostExecutorStorageDirectory(hostExecutorVmRunId(plan));
          active.add(root);
          let storage: Awaited<ReturnType<typeof prepareTrustedInvocationStorage>>;
          try {
            storage = await prepareTrustedInvocationStorage(run, plan, journal, tools);
          } catch (error) {
            await journal.closeStorage(tools.umount);
            active.delete(root);
            throw error;
          }
          return {
            ...storage,
            close: async () => {
              await storage.close();
              active.delete(root);
            },
          };
        },
      },
      close: async () => {
        if (active.size) throw new Error('Invocation storage cleanup is pending; enforcement is preserved');
      },
    };
  }
}

/** @internal Privileged probes use the same allocation, journal and sealing path as production. */
export async function prepareTrustedInvocationStorage(
  _run: HostExecutorRunState,
  plan: HostExecutorInvocationPlan,
  journal: HostExecutorResourceJournal,
  tools: Pick<CloudHypervisorHostToolPaths, 'mount' | 'umount'>,
  report = new HostPreflightReporter('bounded-runtime'),
): Promise<NonNullable<Awaited<ReturnType<NonNullable<
  import('./enclave-executor-types').HostEnclaveExecutorDependencies['prepareInvocationStorage']
>>>>> {
  const vmRunId = hostExecutorVmRunId(plan);
  const root = hostExecutorStorageDirectory(vmRunId);
  const profile = CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[plan.executorKind];
  await report.check('storage-ancestor', () => assertTrustedAncestorChain('invocation storage parent', path.dirname(HOST_EXECUTOR_STORAGE_ROOT), {
    uid: 0, access: fs.access, lstat: fs.lstat, sha256: async () => '',
  }));
  const base = path.dirname(HOST_EXECUTOR_STORAGE_ROOT);
  await report.check('storage-parent', async () => {
    try {
      await fs.mkdir(base, { mode: 0o711 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const baseIdentity = await fs.lstat(base);
    if (!baseIdentity.isDirectory() || baseIdentity.isSymbolicLink() || baseIdentity.uid !== 0 ||
      (baseIdentity.mode & 0o022) !== 0 || await fs.realpath(base) !== base) {
      throw markHostPreflightError(new Error('Untrusted invocation storage ancestor'),
        baseIdentity.isSymbolicLink() ? 'ancestor-symlink' : !baseIdentity.isDirectory() ? 'file-type' :
          baseIdentity.uid !== 0 ? 'ancestor-owner' : (baseIdentity.mode & 0o022) !== 0 ? 'ancestor-writable' : 'requirement-not-met');
    }
  });
  await report.check('storage-root', async () => {
    try {
      await fs.mkdir(HOST_EXECUTOR_STORAGE_ROOT, { mode: 0o711 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await assertTrustedAncestorChain('invocation storage', HOST_EXECUTOR_STORAGE_ROOT, {
      uid: 0, access: fs.access, lstat: fs.lstat, sha256: async () => '',
    });
    const parent = await fs.lstat(HOST_EXECUTOR_STORAGE_ROOT);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 ||
      (parent.mode & 0o777) !== 0o711 || await fs.realpath(HOST_EXECUTOR_STORAGE_ROOT) !== HOST_EXECUTOR_STORAGE_ROOT) {
      throw markHostPreflightError(new Error('Untrusted invocation storage parent'),
        parent.isSymbolicLink() ? 'file-symlink' : !parent.isDirectory() ? 'file-type' :
          parent.uid !== 0 ? 'file-owner' : 'requirement-not-met');
    }
    await journal.prepareStorage();
    await fs.mkdir(root, { mode: 0o711 });
    await journal.captureStorageDirectory();
  });
  await report.check('storage-tmpfs', async () => {
    await journal.prepareStorageMount(root);
    await mount(tools, ['-t', 'tmpfs', '-o',
      `size=${profile.writableStorageBytes},mode=0711,uid=0,gid=0,nosuid,nodev,noexec`,
      ENCLAVE_STORAGE_SOURCE, root]);
    await journal.captureStorageMount();
  });
  const state = path.join(root, 'state');
  const artifacts = path.join(root, 'artifacts');
  await report.check('storage-layout', async () => {
    await fs.mkdir(state, { mode: 0o700 });
    await fs.chown(state, profile.uid, profile.gid);
    await fs.mkdir(artifacts, { mode: 0o711 });
  });
  await report.check('storage-artifact-mount', async () => {
    await journal.prepareStorageMount(artifacts);
    await mount(tools, ['--bind', artifacts, artifacts]);
    await journal.captureStorageMount();
    await mount(tools, ['-o', 'remount,bind,rw,nosuid,nodev,exec', artifacts]);
  });
  await report.check('storage-run-mounts', async () => {
    for (const name of ['runs', 'cloud-hypervisor-rootfs']) {
      const directory = path.join(root, name);
      await fs.mkdir(directory, { mode: 0o711 });
      await journal.prepareStorageMount(directory);
      await mount(tools, ['--bind', directory, directory]);
      await journal.captureStorageMount();
      await mount(tools, ['-o', 'remount,bind,rw,nosuid,nodev,noexec', directory]);
    }
  });
  let snapshotMount: string | undefined;
  const verifyStorage = async (directory: string, maximumBytes: number, writable: readonly string[] = []): Promise<void> => {
    if (directory !== plan.invocationHostDir || maximumBytes !== profile.writableStorageBytes ||
      writable.some((candidate) => path.dirname(candidate) !== directory || path.normalize(candidate) !== candidate ||
        !['output', 'runtime', 'session-handoff', 'session-state'].includes(path.basename(candidate)))) {
      throw new Error('Writable paths escape invocation storage');
    }
    await journal.verifyStorage();
    const info = (await fs.readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n');
    const verifyOptions = (mountPoint: string, mode: 'rw' | 'ro', executable: boolean): void => {
      const matches = info.filter((line) => parseMountInfoLine(line).mountPoint === mountPoint);
      const options = matches[0]?.split(' ')[5].split(',') ?? [];
      if (matches.length !== 1 || ![mode, 'nosuid', 'nodev'].every((flag) => options.includes(flag)) ||
        options.includes('noexec') === executable) {
        throw markHostPreflightError(new Error('Invocation storage mount options changed'), 'storage-mount-options');
      }
    };
    for (const mountPoint of [root, directory, path.join(root, 'runs'), path.join(root, 'cloud-hypervisor-rootfs')]) {
      verifyOptions(mountPoint, 'rw', false);
    }
    verifyOptions(artifacts, 'rw', true);
    if (snapshotMount) verifyOptions(snapshotMount, 'ro', true);
    for (const candidate of [root, directory, ...writable]) {
      if (await fs.realpath(candidate) !== candidate) {
        throw markHostPreflightError(new Error('Invocation storage path changed'), 'storage-path-changed');
      }
      const identity = await fs.lstat(candidate);
      if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw markHostPreflightError(new Error('Invocation export is not a real directory'),
          identity.isSymbolicLink() ? 'file-symlink' : 'file-type');
      }
      const stat = await fs.statfs(candidate, { bigint: true });
      if (stat.type !== 0x01021994n || stat.blocks * stat.bsize !== BigInt(maximumBytes) ||
        (await fs.stat(candidate)).dev !== (await fs.stat(root)).dev) {
        throw markHostPreflightError(new Error('Invocation storage cap changed'), 'storage-cap-changed');
      }
    }
  };
  const managerDependencies = resolveCloudHypervisorManagerDependencies({
    createRunPaths: (binary: string, id?: string, identity?: Parameters<typeof createCloudHypervisorRunPaths>[2]) => {
      if (id !== vmRunId || identity?.invocationId !== plan.invocationId) throw new Error('VM storage identity mismatch');
      return createCloudHypervisorRunPaths(binary, id, identity, root);
    },
    createVirtiofsdManager: (...args: Parameters<CloudHypervisorManagerDependencies['createVirtiofsdManager']>) =>
      VirtiofsdManager.withStorageVerifier(async (exports, bytes) => {
        const writable = exports.filter((entry) => entry.mode === 'rw').map((entry) => entry.source);
        if (!writable.length) throw new Error('Bounded writable exports are missing');
        await verifyStorage(plan.invocationHostDir, bytes, writable);
      }, ...args),
  });
  return {
    workDir: root,
    managerDependencies,
    dependencies: {
      mountTmpfs: async (directory, bytes, uid, gid) => {
        if (directory !== plan.invocationHostDir || bytes !== profile.writableStorageBytes ||
          uid !== profile.uid || gid !== profile.gid) throw new Error('Invocation state identity mismatch');
        await journal.prepareStorageMount(directory);
        await mount(tools, ['--bind', state, directory]);
        await journal.captureStorageMount();
        await mount(tools, ['-o', 'remount,bind,rw,nosuid,nodev,noexec', directory]);
      },
      verifyStorage,
      createArtifactSnapshot: async (sources, copy, capture) => {
        const snapshotReport = report.fork('artifact-snapshot');
        const snapshot = await createArtifactSnapshot(sources, copy, capture, artifacts, snapshotReport);
        await snapshotReport.check('mount-intent', () => journal.prepareStorageMount(snapshot.directory));
        await snapshotReport.check('bind', () => mount(tools, ['--bind', snapshot.directory, snapshot.directory]));
        await snapshotReport.check('mount-capture', () => journal.captureStorageMount());
        await snapshotReport.check('readonly-exec', () =>
          mount(tools, ['-o', 'remount,bind,ro,nosuid,nodev,exec', snapshot.directory]));
        snapshotMount = snapshot.directory;
        await snapshotReport.check('sealed-storage', () =>
          verifyStorage(plan.invocationHostDir, profile.writableStorageBytes));
        return snapshot;
      },
      removeArtifactSnapshot: async (directory) => {
        if (directory !== snapshotMount) throw new Error('Unowned artifact snapshot');
        await journal.verifyStorage();
        const result = await execa(tools.umount, [directory], { reject: false, stdio: ['ignore', 'pipe', 'pipe'] });
        if (result.exitCode !== 0) throw new Error('Artifact snapshot remains busy');
        await journal.releaseStorageMount(directory);
        await fs.rm(directory, { recursive: true, force: true });
        snapshotMount = undefined;
      },
    },
    close: () => journal.closeStorage(tools.umount),
  };
}
