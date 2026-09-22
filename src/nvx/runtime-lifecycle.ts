import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import {
  createMicrovmNetworkPlan,
  generateMicrovmNftRuleset,
  type MicrovmControlPeer,
  type MicrovmNetworkPlan,
  type MicrovmNetworkPlanOptions,
} from '../microvm/network';
import {
  buildNvxConstrainedLaunchCommand,
  computeNvxCgroupLimits,
  type NvxCgroupLimits,
  type NvxLaunchCommand,
} from './confinement';
import type { NvxCleanupDeviceAclIdentity } from './cleanup-record';
import type { NvxFilesystemBundle } from './filesystem-builder';
import type { NvxOneShotExecutionRequest } from './one-shot-adapter';
import {
  NVX_GUEST_ARTIFACT_ROOT,
  assertNvxRunLayout,
  createNvxRunLayout,
  toNvxGuestRunPath,
  type NvxRunLayout,
} from './run-layout';

const ACCOUNT_PREFIX = 'awfnvx-';
const ACCOUNT_LOCK_DIRECTORY = '/run/awf-nvx/.account-lock';
const DEVICE_ACL_LOCK_DIRECTORY = '/run/awf-nvx/.device-acl-lock';
const LOCK_RETRY_MS = 25;
const ACCOUNT_LOCK_TIMEOUT_MS = 10_000;
const DEVICE_ACL_LOCK_TIMEOUT_MS = 60_000;
const INCOMPLETE_LOCK_STALE_MS = 1_000;
type NvxDevicePath = NvxCleanupDeviceAclIdentity['path'];
const NVX_DEVICE_PATHS: readonly NvxDevicePath[] = ['/dev/kvm'];
const NVX_HOST_PIDS_MAX = 256;
const CGROUP_V2_CONTROLLERS = '+cpu +memory +pids';

export interface NvxVmmIdentity {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
}

export interface NvxRuntimeToolPaths {
  readonly bwrap: string;
  readonly flock: string;
  readonly getfacl: string;
  readonly getent: string;
  readonly groupdel: string;
  readonly id: string;
  readonly ip: string;
  readonly iptables: string;
  readonly nft: string;
  readonly setfacl: string;
  readonly setpriv: string;
  readonly sysctl: string;
  readonly useradd: string;
  readonly userdel: string;
}

export interface NvxRuntimeLifecycleDependencies {
  mkdir(directory: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  writeFile(filePath: string, contents: string, options?: { flag?: string; mode?: number }): Promise<void>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  rm(filePath: string, options: { recursive: true; force: true }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rmdir(directory: string): Promise<void>;
  lstat(filePath: string): Promise<{ uid: number; gid: number; dev?: number | bigint; ino?: number | bigint; mtimeMs?: number }>;
  run(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>;
  sleep(milliseconds: number): Promise<void>;
  pid: number;
  processStartTime(pid: number): Promise<string | undefined>;
}

export interface NvxRuntimeLifecycleObserver {
  prepareAccount(name: string): Promise<void>;
  captureIdentity(identity: NvxVmmIdentity): Promise<void>;
  prepareDeviceAcl(identity: NvxCleanupDeviceAclIdentity): Promise<void>;
  releaseDeviceAcl(identity: NvxCleanupDeviceAclIdentity): Promise<void>;
}

export interface NvxCgroupDependencies {
  mkdir(directory: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  writeFile(filePath: string, contents: string): Promise<void>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  rmdir(directory: string): Promise<void>;
}

export interface NvxPhase3dLaunchPlan {
  readonly layout: NvxRunLayout;
  readonly identity: NvxVmmIdentity;
  readonly cgroupLimits: NvxCgroupLimits;
  readonly networkPlan: MicrovmNetworkPlan;
  readonly networkRuleset: string;
  readonly launchCommand: NvxLaunchCommand;
  readonly outcomePath: string;
}

const defaultDependencies: NvxRuntimeLifecycleDependencies = {
  mkdir: fs.mkdir,
  writeFile: fs.writeFile,
  readFile: fs.readFile,
  rm: fs.rm,
  rename: fs.rename,
  rmdir: fs.rmdir,
  lstat: fs.lstat,
  run: async (command, args) => {
    const result = await execa(command, [...args], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      extendEnv: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${command} ${args.join(' ')} exited with code ${result.exitCode}: ` +
        `${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pid: process.pid,
  processStartTime: readProcessStartTime,
};

interface NvxDeviceAclGrant {
  readonly identity: NvxCleanupDeviceAclIdentity;
  readonly state: 'pending' | 'granted';
}

export class NvxVmmIdentityManager {
  private identity: NvxVmmIdentity | undefined;
  private provisionalAccountName: string | undefined;
  private readonly aclIdentities = new Map<string, NvxDeviceAclGrant>();

  constructor(
    private readonly runId: string,
    private readonly tools: NvxRuntimeToolPaths,
    private readonly dependencies: NvxRuntimeLifecycleDependencies = defaultDependencies,
    private readonly observer?: NvxRuntimeLifecycleObserver,
  ) {
    createNvxRunLayout(runId);
  }

  async allocate(): Promise<NvxVmmIdentity> {
    if (this.identity) return this.identity;
    return this.withLock(ACCOUNT_LOCK_DIRECTORY, ACCOUNT_LOCK_TIMEOUT_MS, async () => {
      if (this.identity) return this.identity;
      if (this.provisionalAccountName) {
        throw new Error(`NVX VMM account cleanup is still pending: ${this.provisionalAccountName}`);
      }
      const name = createNvxAccountName(this.runId);
      if (await this.accountExists(name)) throw new Error(`NVX VMM account already exists: ${name}`);
      try {
        await this.observer?.prepareAccount(name);
        await this.dependencies.run(this.tools.useradd, [
          '--system',
          '--user-group',
          '--no-create-home',
          '--home-dir', '/nonexistent',
          '--shell', '/usr/sbin/nologin',
          '--comment', `AWF NVX ${this.runId}`,
          name,
        ]);
        this.provisionalAccountName = name;
        const identity = await this.resolveAndValidateAccount(name);
        await this.observer?.captureIdentity(identity);
        this.identity = identity;
        this.provisionalAccountName = undefined;
        return identity;
      } catch (error) {
        if (await this.accountExists(name)) this.provisionalAccountName = name;
        if (this.provisionalAccountName) {
          try {
            await this.removeAccountState(name);
            this.provisionalAccountName = undefined;
          } catch (rollbackError) {
            throw new Error(
              `NVX VMM account allocation failed: ${formatError(error)}; ` +
              `rollback also failed: ${formatError(rollbackError)}`,
            );
          }
        }
        throw error;
      }
    });
  }

  async withDeviceAccess<T>(
    operation: (deviceAcls: readonly NvxCleanupDeviceAclIdentity[]) => Promise<T>,
    devicePaths: readonly NvxDevicePath[] = NVX_DEVICE_PATHS,
  ): Promise<T> {
    const identity = this.requireIdentity();
    const requested = dedupeDevices(devicePaths);
    return this.withLock(DEVICE_ACL_LOCK_DIRECTORY, DEVICE_ACL_LOCK_TIMEOUT_MS, async () => {
      if (this.identity !== identity) throw new Error('NVX VMM identity changed before device ACL grant');
      let result: T | undefined;
      let operationError: unknown;
      try {
        const acls = await this.grantDeviceAccessLocked(identity, requested);
        result = await operation(acls);
      } catch (error) {
        operationError = error;
      }
      try {
        await this.revokeDeviceAccessLocked(identity);
      } catch (revokeError) {
        if (operationError) {
          throw new Error(
            `NVX device operation failed: ${formatError(operationError)}; ` +
            `ACL revocation also failed: ${formatError(revokeError)}`,
          );
        }
        throw revokeError;
      }
      if (operationError) throw operationError;
      return result as T;
    });
  }

  async cleanup(): Promise<void> {
    const identity = this.identity;
    const provisionalAccountName = this.provisionalAccountName;
    if (!identity && !provisionalAccountName) return;
    await this.withLock(ACCOUNT_LOCK_DIRECTORY, ACCOUNT_LOCK_TIMEOUT_MS, async () => {
      if (!identity && provisionalAccountName) {
        if (this.provisionalAccountName !== provisionalAccountName) return;
        await this.removeAccountState(provisionalAccountName);
        this.provisionalAccountName = undefined;
        return;
      }
      if (!identity || this.identity !== identity) return;
      const current = await this.resolveAndValidateAccount(identity.name);
      if (current.uid !== identity.uid || current.gid !== identity.gid) {
        throw new Error(`Refusing to remove reused NVX VMM account ${identity.name}`);
      }
      await this.withLock(
        DEVICE_ACL_LOCK_DIRECTORY,
        DEVICE_ACL_LOCK_TIMEOUT_MS,
        () => this.revokeDeviceAccessLocked(identity),
      );
      await this.removeAccountState(identity.name);
      this.identity = undefined;
    });
  }

  private async grantDeviceAccessLocked(
    identity: NvxVmmIdentity,
    devicePaths: readonly NvxDevicePath[],
  ): Promise<readonly NvxCleanupDeviceAclIdentity[]> {
    const granted: NvxCleanupDeviceAclIdentity[] = [];
    for (const devicePath of devicePaths) {
      const deviceIdentity = await this.captureDeviceIdentity(devicePath, identity.uid);
      // Record the pending grant before `setfacl` runs so that a failure in
      // `setfacl`, `getfacl`, `lstat`, or validation still revokes the device.
      this.aclIdentities.set(devicePath, { identity: deviceIdentity, state: 'pending' });
      await this.observer?.prepareDeviceAcl(deviceIdentity);
      await this.dependencies.run(this.tools.setfacl, [
        '--modify', `user:${identity.uid}:rw`, devicePath,
      ]);
      const verified = await this.verifyDeviceAcl(deviceIdentity);
      this.aclIdentities.set(devicePath, { identity: verified, state: 'granted' });
      granted.push(verified);
    }
    return granted;
  }

  private async revokeDeviceAccessLocked(identity: NvxVmmIdentity): Promise<void> {
    const errors: unknown[] = [];
    for (const [devicePath, grant] of [...this.aclIdentities.entries()].reverse()) {
      try {
        const current = await this.captureDeviceIdentity(grant.identity.path, identity.uid);
        if (
          current.device !== grant.identity.device ||
          current.inode !== grant.identity.inode
        ) {
          throw new Error(`NVX device identity changed for ${devicePath}`);
        }
        // An absent ACL means the grant never landed (or was already removed);
        // only a changed device identity blocks revocation.
        if (await this.deviceAclPresent(grant.identity.path, identity.uid)) {
          await this.dependencies.run(this.tools.setfacl, [
            '--remove', `user:${identity.uid}`, grant.identity.path,
          ]);
          if (await this.deviceAclPresent(grant.identity.path, identity.uid)) {
            throw new Error(`NVX VMM ACL removal validation failed for ${grant.identity.path}`);
          }
        }
        await this.observer?.releaseDeviceAcl(grant.identity);
        this.aclIdentities.delete(devicePath);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0 || this.aclIdentities.size > 0) {
      throw new Error(`NVX VMM ACL cleanup failed: ${errors.map(formatError).join('; ')}`);
    }
  }

  private async deviceAclPresent(devicePath: string, uid: number): Promise<boolean> {
    const { stdout } = await this.dependencies.run(this.tools.getfacl, [
      '--absolute-names', '--numeric', devicePath,
    ]);
    return stdout.split(/\r?\n/).some((line) => line.startsWith(`user:${uid}:`));
  }

  private async verifyDeviceAcl(
    expected: NvxCleanupDeviceAclIdentity,
  ): Promise<NvxCleanupDeviceAclIdentity> {
    const current = await this.captureDeviceIdentity(expected.path, expected.uid);
    if (
      current.device !== expected.device ||
      current.inode !== expected.inode
    ) {
      throw new Error(`NVX device identity changed for ${expected.path}`);
    }
    const { stdout } = await this.dependencies.run(this.tools.getfacl, [
      '--absolute-names', '--numeric', expected.path,
    ]);
    if (!stdout.split(/\r?\n/).includes(`user:${expected.uid}:rw-`)) {
      throw new Error(`NVX VMM ACL validation failed for ${expected.path}`);
    }
    return current;
  }

  private async captureDeviceIdentity(
    devicePath: NvxDevicePath,
    uid: number,
  ): Promise<NvxCleanupDeviceAclIdentity> {
    const stats = await this.dependencies.lstat(devicePath);
    return {
      path: devicePath,
      device: String(stats.dev ?? 0),
      inode: String(stats.ino ?? 0),
      uid,
      permissions: 'rw-',
    };
  }

  private async resolveAndValidateAccount(name: string): Promise<NvxVmmIdentity> {
    const [
      { stdout: uidText },
      { stdout: gidText },
      { stdout: groupsText },
      { stdout: passwdText },
    ] = await Promise.all([
      this.dependencies.run(this.tools.id, ['-u', name]),
      this.dependencies.run(this.tools.id, ['-g', name]),
      this.dependencies.run(this.tools.id, ['-G', name]),
      this.dependencies.run(this.tools.getent, ['passwd', name]),
    ]);
    const uid = parsePositiveInteger(uidText, 'uid');
    const gid = parsePositiveInteger(gidText, 'gid');
    const groups = groupsText.trim().split(/\s+/).filter(Boolean)
      .map((value) => parsePositiveInteger(value, 'supplementary group'));
    if (groups.length !== 1 || groups[0] !== gid) {
      throw new Error(`NVX VMM account ${name} inherited supplementary groups: ${groups.join(' ')}`);
    }
    const passwd = passwdText.trim().split(':');
    if (
      passwd.length !== 7 ||
      passwd[0] !== name ||
      passwd[2] !== String(uid) ||
      passwd[3] !== String(gid) ||
      passwd[5] !== '/nonexistent' ||
      passwd[6] !== '/usr/sbin/nologin' ||
      !passwd[4].includes(this.runId)
    ) {
      throw new Error(`NVX VMM account ${name} has unsafe passwd state`);
    }
    return { name, uid, gid };
  }

  private async removeAccountState(name: string): Promise<void> {
    if (await this.accountExists(name)) await this.dependencies.run(this.tools.userdel, [name]);
    if (await this.groupExists(name)) await this.dependencies.run(this.tools.groupdel, [name]);
  }

  private async accountExists(name: string): Promise<boolean> {
    try {
      await this.dependencies.run(this.tools.id, ['-u', name]);
      return true;
    } catch {
      return false;
    }
  }

  private async groupExists(name: string): Promise<boolean> {
    try {
      await this.dependencies.run(this.tools.getent, ['group', name]);
      return true;
    } catch {
      return false;
    }
  }

  private requireIdentity(): NvxVmmIdentity {
    if (!this.identity) throw new Error('NVX VMM identity has not been allocated');
    return this.identity;
  }

  private async withLock<T>(
    lockDirectory: string,
    timeoutMs: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.dependencies.mkdir(path.dirname(lockDirectory), { recursive: true, mode: 0o711 });
    const startTime = await this.dependencies.processStartTime(this.dependencies.pid);
    if (!startTime) throw new Error('Cannot determine AWF process start time for NVX lifecycle lock');
    const owner = {
      pid: this.dependencies.pid,
      startTime,
      nonce: randomBytes(16).toString('hex'),
    };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let acquired = false;
      try {
        await this.dependencies.mkdir(lockDirectory, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (acquired) {
        try {
          await this.dependencies.writeFile(
            path.join(lockDirectory, 'owner.json'),
            `${JSON.stringify(owner)}\n`,
            { flag: 'wx', mode: 0o600 },
          );
          return await operation();
        } finally {
          await this.removeOwnedLock(lockDirectory, owner);
        }
      }
      await this.reclaimStaleLock(lockDirectory);
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the NVX lifecycle lock');
      await this.dependencies.sleep(LOCK_RETRY_MS);
    }
  }

  private async reclaimStaleLock(lockDirectory: string): Promise<void> {
    let initialStats: Awaited<ReturnType<NvxRuntimeLifecycleDependencies['lstat']>>;
    try {
      initialStats = await this.dependencies.lstat(lockDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const owner = await this.readLockOwner(lockDirectory);
    if (
      owner &&
      await this.dependencies.processStartTime(owner.pid) === owner.startTime
    ) return;
    if (
      !owner &&
      (initialStats.mtimeMs === undefined ||
        Date.now() - initialStats.mtimeMs < INCOMPLETE_LOCK_STALE_MS)
    ) return;
    // Claim the exact directory that was inspected by moving it aside
    // atomically; only the winner of the rename may delete it.
    const quarantinePath = `${lockDirectory}.stale-${randomBytes(16).toString('hex')}`;
    try {
      await this.dependencies.rename(lockDirectory, quarantinePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return;
      throw error;
    }
    const quarantined = await this.dependencies.lstat(quarantinePath);
    const quarantinedOwner = await this.readLockOwner(quarantinePath);
    const sameInode =
      String(quarantined.dev ?? '') === String(initialStats.dev ?? '') &&
      String(quarantined.ino ?? '') === String(initialStats.ino ?? '');
    const sameOwner =
      quarantinedOwner?.pid === owner?.pid &&
      quarantinedOwner?.startTime === owner?.startTime;
    const ownerIsLive = quarantinedOwner !== undefined &&
      (await this.dependencies.processStartTime(quarantinedOwner.pid)) === quarantinedOwner.startTime;
    if (!sameInode || !sameOwner || ownerIsLive) {
      try {
        await this.dependencies.rename(quarantinePath, lockDirectory);
      } catch {
        // The lock path was recreated by another holder; leave it untouched.
      }
      throw new Error('NVX lifecycle lock reclamation raced with another lock owner');
    }
    await this.dependencies.rm(quarantinePath, { recursive: true, force: true });
  }

  private async readLockOwner(lockDirectory: string): Promise<{ pid: number; startTime: string } | undefined> {
    try {
      const parsed = JSON.parse(
        await this.dependencies.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'),
      ) as { pid?: unknown; startTime?: unknown };
      const pid = parsed.pid;
      if (typeof pid === 'number' && Number.isSafeInteger(pid) && typeof parsed.startTime === 'string') {
        return { pid, startTime: parsed.startTime };
      }
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  private async removeOwnedLock(
    lockDirectory: string,
    owner: { readonly pid: number; readonly startTime: string; readonly nonce: string },
  ): Promise<void> {
    const current = JSON.parse(
      await this.dependencies.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'),
    ) as typeof owner;
    if (
      current.pid !== owner.pid ||
      current.startTime !== owner.startTime ||
      current.nonce !== owner.nonce
    ) {
      throw new Error('NVX lifecycle lock ownership changed unexpectedly');
    }
    await this.dependencies.rm(lockDirectory, { recursive: true, force: true });
  }
}

export class NvxCgroupManager {
  private created = false;

  constructor(
    readonly cgroupPath: string,
    private readonly limits: NvxCgroupLimits,
    private readonly dependencies: NvxCgroupDependencies = {
      mkdir: (directory, options) => fs.mkdir(directory, options),
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rmdir: fs.rmdir,
    },
  ) {}

  async setup(): Promise<void> {
    const parentDir = path.dirname(this.cgroupPath);
    const rootDir = path.dirname(parentDir);
    if (rootDir !== '/sys/fs/cgroup') {
      throw new Error(`NVX cgroup path must be /sys/fs/cgroup/<parent>/<run>: ${this.cgroupPath}`);
    }
    await this.dependencies.writeFile(path.join(rootDir, 'cgroup.subtree_control'), CGROUP_V2_CONTROLLERS);
    await this.dependencies.mkdir(parentDir, { recursive: true, mode: 0o700 });
    await this.dependencies.writeFile(path.join(parentDir, 'cgroup.subtree_control'), CGROUP_V2_CONTROLLERS);
    await this.dependencies.mkdir(this.cgroupPath, { mode: 0o700 });
    this.created = true;
    await this.writeAndVerifyLimit('memory.max', this.limits.memoryMax);
    await this.writeAndVerifyLimit('cpu.max', this.limits.cpuMax);
    await this.writeAndVerifyLimit('pids.max', this.limits.pidsMax);
  }

  async assignProcessTree(pids: readonly number[]): Promise<void> {
    const unique = [...new Set(pids)];
    if (unique.length < 1 || unique.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
      throw new Error('NVX cgroup assignment requires positive process IDs');
    }
    for (const pid of unique) {
      await this.dependencies.writeFile(path.join(this.cgroupPath, 'cgroup.procs'), String(pid));
    }
    const observed = parseNumericLines(
      await this.dependencies.readFile(path.join(this.cgroupPath, 'cgroup.procs'), 'utf8'),
    );
    if (observed.join(',') !== unique.sort((a, b) => a - b).join(',')) {
      throw new Error(`NVX cgroup membership mismatch: ${observed.join(',')}`);
    }
  }

  async cleanup(): Promise<void> {
    if (!this.created) return;
    const members = parseNumericLines(
      await this.dependencies.readFile(path.join(this.cgroupPath, 'cgroup.procs'), 'utf8'),
    );
    if (members.length > 0) {
      throw new Error(`Refusing to remove non-empty NVX cgroup: ${members.join(',')}`);
    }
    await this.dependencies.rmdir(this.cgroupPath);
    this.created = false;
  }

  private async writeAndVerifyLimit(fileName: string, value: string): Promise<void> {
    const filePath = path.join(this.cgroupPath, fileName);
    await this.dependencies.writeFile(filePath, value);
    const observed = (await this.dependencies.readFile(filePath, 'utf8')).trim();
    if (observed !== value) throw new Error(`NVX cgroup ${fileName} mismatch: ${observed}`);
  }
}

export function createNvxNetworkPlan(
  runId: string,
  options: MicrovmNetworkPlanOptions,
): MicrovmNetworkPlan {
  const plan = createMicrovmNetworkPlan(runId, options);
  return bindNvxNetworkPlan(runId, plan);
}

export function bindNvxNetworkPlan(
  runId: string,
  plan: MicrovmNetworkPlan,
): MicrovmNetworkPlan {
  const layout = createNvxRunLayout(runId);
  if (plan.runId !== runId) {
    throw new Error('NVX network allocation is not bound to the run identity');
  }
  return {
    ...plan,
    namespaceName: layout.networkNamespace,
    netnsPath: `/var/run/netns/${layout.networkNamespace}`,
    nftTableName: `awf_nvx_${plan.resourceToken}`,
  };
}

export function buildNvxPhase3dLaunchPlan(options: {
  readonly runId: string;
  readonly tools: NvxRuntimeToolPaths;
  readonly identity: NvxVmmIdentity;
  readonly filesystem: NvxFilesystemBundle;
  readonly execution: Omit<NvxOneShotExecutionRequest, 'nvxRoot' | 'filesystem' | 'network'>;
  readonly network: {
    readonly infrastructureBridge: string;
    readonly enableApiProxy: boolean;
    readonly controlPeers?: readonly MicrovmControlPeer[];
  };
  readonly networkPlan?: MicrovmNetworkPlan;
}): NvxPhase3dLaunchPlan {
  const layout = createNvxRunLayout(options.runId);
  assertNvxRunLayout(layout);
  if (path.resolve(options.filesystem.runDirectory) !== layout.runDirectory) {
    throw new Error(
      'NVX filesystem bundle must be staged in the canonical run directory ' +
      `${layout.runDirectory} (build it with useCanonicalRunDirectory)`,
    );
  }
  const networkPlan = options.networkPlan ?? createNvxNetworkPlan(options.runId, {
      infrastructureBridge: options.network.infrastructureBridge,
      enableApiProxy: options.network.enableApiProxy,
      tapOwnerUid: options.identity.uid,
      tapOwnerGid: options.identity.gid,
      controlPeers: options.network.controlPeers,
      createTap: false,
    });
  if (
    networkPlan.runId !== options.runId ||
    networkPlan.namespaceName !== layout.networkNamespace ||
    networkPlan.tapOwnerUid !== options.identity.uid ||
    networkPlan.tapOwnerGid !== options.identity.gid
  ) {
    throw new Error('NVX launch plan network allocation is not bound to the run identity');
  }
  const cgroupLimits = computeNvxCgroupLimits({
    guestMemoryMib: options.execution.memoryMib ?? 512,
    vcpuCount: 1,
    hostPidsMax: NVX_HOST_PIDS_MAX,
  });
  const outcomePath = path.join(layout.runDirectory, 'outcome.json');
  const guestFilesystem = toNvxGuestFilesystemBundle(layout, options.filesystem);
  const guestOutcomePath = toNvxGuestRunPath(layout, outcomePath);
  const openvmmArguments = buildDirectOpenvmmArguments({
    ...options.execution,
    nvxRoot: NVX_GUEST_ARTIFACT_ROOT,
    filesystem: guestFilesystem,
    network: {
      guestAddress: `${networkPlan.guestIp}/${networkPlan.guestPrefixLength}`,
      egressAllow: networkPlan.allowedEndpoints.map(
        (endpoint) => `${endpoint.ip}/32:tcp:${endpoint.port}`,
      ),
    },
  }, guestOutcomePath);
  return {
    layout,
    identity: options.identity,
    cgroupLimits,
    networkPlan,
    networkRuleset: generateMicrovmNftRuleset(networkPlan),
    launchCommand: buildNvxConstrainedLaunchCommand({
      tools: {
        ip: options.tools.ip,
        bwrap: options.tools.bwrap,
        setpriv: options.tools.setpriv,
      },
      namespaceName: layout.networkNamespace,
      identity: options.identity,
      nvxRoot: layout.artifactSnapshotDirectory,
      runDirectory: layout.runDirectory,
      systemReadOnlyPaths: [
        '/usr',
        '/bin',
        '/sbin',
        '/lib',
        '/lib64',
        '/etc/resolv.conf',
        '/etc/ssl',
        '/run/systemd/resolve',
      ],
      openvmmArguments,
    }),
    outcomePath,
  };
}

export function buildDirectOpenvmmArguments(
  request: NvxOneShotExecutionRequest,
  outcomePath: string,
): readonly string[] {
  const uid = request.workloadUid ?? 65534;
  const gid = request.workloadGid ?? 65534;
  const layerAddresses = {
    distro: '0xd0003000',
    runtime: '0xd0004000',
    custom: '0xd0005000',
  } as const;
  const ordered = [...request.filesystem.layers].sort(
    (left, right) =>
      ['distro', 'runtime', 'custom'].indexOf(left.role) -
      ['distro', 'runtime', 'custom'].indexOf(right.role),
  );
  const args: string[] = ['--machine', 'microvm', '--paused'];
  for (const layer of ordered) {
    args.push(
      '--microvm-sandbox-block',
      `${layer.role}:file:${layer.path},ro`,
    );
  }
  args.push(
    '--microvm-sandbox-block',
    `scratch:file:${request.filesystem.scratch.path}`,
    '--microvm-workload-identity',
    `${uid}:${gid}`,
    '--microvm-lifecycle',
    'one-shot',
    '--single-process',
    '--hypervisor',
    'kvm',
    '--memory',
    `${request.memoryMib ?? 512}M`,
    '--kernel',
    path.join(request.nvxRoot, 'vmlinux'),
    '--initrd',
    path.join(request.nvxRoot, 'initramfs.cpio.gz'),
    '--cmdline',
    buildDirectKernelCommandLine(request, ordered, layerAddresses),
    '--net',
    request.network.guestAddress,
    '--network-profile',
    'portable',
    '--network-egress',
    'deny',
    '--network-ingress',
    'deny',
  );
  for (const rule of request.network.egressAllow ?? []) {
    args.push('--network-egress-allow', rule);
  }
  for (const rule of request.network.egressDeny ?? []) {
    args.push('--network-egress-deny', rule);
  }
  const forwards = request.network.hostLoopbackForwards ?? [];
  args.push(
    '--host-loopback', forwards.length > 0 ? 'allow' : 'deny',
  );
  if (request.network.proxyAddress !== undefined) {
    args.push('--network-proxy', request.network.proxyAddress);
  }
  for (const forward of forwards) args.push('--host-loopback-forward', forward);
  args.push('--microvm-report', outcomePath);
  return args;
}

function buildDirectKernelCommandLine(
  request: NvxOneShotExecutionRequest,
  layers: readonly NvxFilesystemBundle['layers'][number][],
  addresses: Readonly<Record<'distro' | 'runtime' | 'custom', string>>,
): string {
  const tokens = ['nvx_sandbox=1'];
  for (const layer of layers) {
    tokens.push(`nvx_layer=${layer.role},${addresses[layer.role]},${layer.uuid}`);
  }
  tokens.push(
    'nvx_scratch=0xd0006000,ext4',
    `nvx_entrypoint=${request.entrypoint}`,
    `nvx_hostname=${request.hostname ?? 'awf-nvx'}`,
  );
  for (const argument of request.args ?? []) tokens.push(`nvx_arg=${argument}`);
  if (request.memoryMaxBytes !== undefined) {
    tokens.push(`nvx_memory_max=${request.memoryMaxBytes}`);
  }
  if (request.pidsMax !== undefined) {
    if (request.pidsMax >= Number.MAX_SAFE_INTEGER) {
      throw new Error('NVX process limit is too large for the sandbox PID 1 allowance');
    }
    tokens.push(`nvx_pids_max=${request.pidsMax + 1}`);
  }
  const commandLine = tokens.join(' ');
  if (Buffer.byteLength(commandLine) + 1 > 1024) {
    throw new Error('NVX sandbox kernel command line exceeds its 1024-byte x86 budget');
  }
  return commandLine;
}

function toNvxGuestFilesystemBundle(
  layout: NvxRunLayout,
  bundle: NvxFilesystemBundle,
): NvxFilesystemBundle {
  return {
    ...bundle,
    runDirectory: toNvxGuestRunPath(layout, bundle.runDirectory),
    manifestPath: toNvxGuestRunPath(layout, bundle.manifestPath),
    layers: bundle.layers.map((layer) => ({
      ...layer,
      path: toNvxGuestRunPath(layout, layer.path),
    })),
    scratch: {
      ...bundle.scratch,
      path: toNvxGuestRunPath(layout, bundle.scratch.path),
    },
  };
}

export function createNvxAccountName(runId: string): string {
  createNvxRunLayout(runId);
  return `${ACCOUNT_PREFIX}${runId.slice(0, 10)}${randomBytes(5).toString('hex')}`;
}

function dedupeDevices(
  devicePaths: readonly NvxDevicePath[],
): readonly NvxDevicePath[] {
  const seen = new Set<string>();
  return devicePaths.filter((devicePath) => {
    if (!NVX_DEVICE_PATHS.includes(devicePath)) throw new Error(`Unsupported NVX device ACL path: ${devicePath}`);
    if (seen.has(devicePath)) return false;
    seen.add(devicePath);
    return true;
  });
}

function parseNumericLines(contents: string): number[] {
  return contents.split('\n').filter(Boolean).map((value) => {
    if (!/^\d+$/.test(value)) throw new Error(`NVX cgroup PID is malformed: ${value}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`NVX cgroup PID is unsafe: ${value}`);
    return parsed;
  }).sort((a, b) => a - b);
}

function parsePositiveInteger(value: string, label: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`NVX ${label} is malformed`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`NVX ${label} is unsafe`);
  return parsed;
}

async function readProcessStartTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    return fields[19];
  } catch {
    return undefined;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
