import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createDefaultIdentityDependencies } from '../identity-dependencies';
import { withDirectoryLock, type DirectoryLockOwner } from '../microvm/directory-lock';
import { resolveAndValidateVmmAccount } from '../vmm-account-validation';
import {
  composeDeviceAcl,
  describeDeviceAclShape,
  deviceAclArgument,
  namedUserAclUid,
  parseDeviceAcl,
  sameDeviceAcl,
  type CloudHypervisorDevicePath,
} from './device-acl';

const ACCOUNT_PREFIX = 'awfvmm-';
const ACCOUNT_LOCK_DIRECTORY = '/run/awf-cloud-hypervisor/.account-lock';
const DEVICE_ACL_LOCK_DIRECTORY = '/run/awf-cloud-hypervisor/.device-acl-lock';
const ACCOUNT_LOCK_RETRY_MS = 25;
const ACCOUNT_LOCK_TIMEOUT_MS = 10_000;
const DEVICE_ACL_LOCK_TIMEOUT_MS = 60_000;
const INCOMPLETE_LOCK_STALE_MS = 1_000;
const VMM_DEVICE_PATHS = ['/dev/kvm', '/dev/net/tun'] as const;

export interface CloudHypervisorVmmIdentity {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
}

export interface CloudHypervisorVmmIdentityToolPaths {
  readonly getfacl: string;
  readonly groupdel: string;
  readonly getent: string;
  readonly id: string;
  readonly ip: string;
  readonly setfacl: string;
  readonly useradd: string;
  readonly userdel: string;
}

export interface CloudHypervisorVmmIdentityObserver {
  prepareAccount(name: string): Promise<void>;
  captureIdentity(identity: CloudHypervisorVmmIdentity): Promise<void>;
  prepareAcl(
    path: CloudHypervisorDevicePath,
    baseline: readonly string[],
    temporaryUids: readonly number[],
  ): Promise<void>;
  releaseAcl(path: CloudHypervisorDevicePath): Promise<void>;
}

export interface CloudHypervisorVmmIdentityDependencies {
  mkdir(directory: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  writeFile(filePath: string, contents: string, options?: { flag?: string; mode?: number }): Promise<void>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  rm(filePath: string, options: { recursive: true; force: true }): Promise<void>;
  rmdir(directory: string): Promise<void>;
  lstat(filePath: string): Promise<{
    uid: number;
    gid: number;
    ino?: number;
    mtimeMs?: number;
  }>;
  run(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>;
  sleep(milliseconds: number): Promise<void>;
  pid: number;
  processStartTime(pid: number): Promise<string | undefined>;
}

const defaultDependencies: CloudHypervisorVmmIdentityDependencies =
  createDefaultIdentityDependencies(readProcessStartTime);

type LockOwner = DirectoryLockOwner;

export class CloudHypervisorVmmIdentityManager {
  private identity: CloudHypervisorVmmIdentity | undefined;
  private provisionalAccountName: string | undefined;
  private readonly accessedAclPaths = new Set<CloudHypervisorDevicePath>();
  private readonly aclPaths = new Set<string>();
  private readonly aclBaselines = new Map<CloudHypervisorDevicePath, string[]>();
  private readonly aclTemporaryUids = new Map<CloudHypervisorDevicePath, number[]>();

  constructor(
    private readonly runId: string,
    private readonly tools: CloudHypervisorVmmIdentityToolPaths,
    private readonly dependencies: CloudHypervisorVmmIdentityDependencies = defaultDependencies,
    private readonly observer?: CloudHypervisorVmmIdentityObserver,
  ) {}

  async allocate(): Promise<CloudHypervisorVmmIdentity> {
    if (this.identity) return this.identity;
    return this.withAccountLock(async () => {
      if (this.identity) return this.identity;
      if (this.provisionalAccountName) {
        throw new Error(
          `Cloud Hypervisor VMM account cleanup is still pending: ${this.provisionalAccountName}`,
        );
      }
      const name = createAccountName();
      if (await this.accountExists(name)) {
        throw new Error(`Cloud Hypervisor VMM account already exists: ${name}`);
      }
      try {
        await this.observer?.prepareAccount(name);
        await this.dependencies.run(this.tools.useradd, [
          '--system',
          '--user-group',
          '--no-create-home',
          '--home-dir', '/nonexistent',
          '--shell', '/usr/sbin/nologin',
          '--comment', `AWF Cloud Hypervisor ${this.runId}`,
          name,
        ]);
        this.provisionalAccountName = name;
        const identity = await this.resolveAndValidateAccount(name);
        await this.observer?.captureIdentity(identity);
        this.identity = identity;
        this.provisionalAccountName = undefined;
        return identity;
      } catch (error) {
        if (await this.accountExists(name)) {
          this.provisionalAccountName = name;
        }
        if (this.provisionalAccountName) {
          try {
            await this.removeAccountState(name);
            this.provisionalAccountName = undefined;
          } catch (rollbackError) {
            throw new Error(
              `Cloud Hypervisor VMM account allocation failed: ${formatError(error)}; ` +
              `rollback also failed: ${formatError(rollbackError)}`,
            );
          }
        }
        throw error;
      }
    });
  }

  async withDeviceAccess<T>(operation: () => Promise<T>, includeTun = true): Promise<T> {
    const identity = this.requireIdentity();
    return this.withDeviceAclLock(async () => {
      if (this.identity !== identity) {
        throw new Error('Cloud Hypervisor VMM identity changed before device ACL grant');
      }
      let result: T | undefined;
      let operationError: unknown;
      try {
        await this.grantDeviceAccessLocked(identity, includeTun);
        result = await operation();
      } catch (error) {
        operationError = error;
      }
      try {
        await this.restoreDeviceAccessLocked();
      } catch (revokeError) {
        if (operationError) {
          throw new Error(
            `Cloud Hypervisor device operation failed: ${formatError(operationError)}; ` +
            `ACL revocation also failed: ${formatError(revokeError)}`,
          );
        }
        throw revokeError;
      }
      try {
        await this.releaseDeviceAclIntentLocked();
      } catch (releaseError) {
        if (operationError) {
          throw new Error(
            `Cloud Hypervisor device operation failed: ${formatError(operationError)}; ` +
            `ACL cleanup completion also failed: ${formatError(releaseError)}`,
          );
        }
        throw releaseError;
      }
      if (operationError) throw operationError;
      return result as T;
    });
  }

  async validateOwnedPaths(paths: readonly string[]): Promise<void> {
    const identity = this.requireIdentity();
    for (const ownedPath of paths) {
      const stats = await this.dependencies.lstat(ownedPath);
      if (stats.uid !== identity.uid || stats.gid !== identity.gid) {
        throw new Error(
          `Cloud Hypervisor VMM path ownership mismatch for ${ownedPath}: ` +
          `expected ${identity.uid}:${identity.gid}, got ${stats.uid}:${stats.gid}`,
        );
      }
    }
  }

  async validateTapOwnership(ipPath: string, namespaceName: string, tapName: string): Promise<void> {
    const identity = this.requireIdentity();
    const { stdout } = await this.dependencies.run(ipPath, [
      'netns', 'exec', namespaceName,
      ipPath, '-details', 'tuntap', 'show', 'dev', tapName,
    ]);
    const tapLine = stdout.split(/\r?\n/).find((line) => line.startsWith(`${tapName}:`));
    if (!tapLine) {
      throw new Error(`Cloud Hypervisor TAP ${namespaceName}/${tapName} was not found`);
    }
    const fields = tapLine.trim().split(/\s+/);
    const userIndex = fields.indexOf('user');
    const groupIndex = fields.indexOf('group');
    if (
      userIndex < 0 ||
      fields[userIndex + 1] !== String(identity.uid) ||
      groupIndex < 0 ||
      fields[groupIndex + 1] !== String(identity.gid)
    ) {
      throw new Error(
        `Cloud Hypervisor TAP ownership mismatch for ${namespaceName}/${tapName}`,
      );
    }
  }

  async cleanup(): Promise<void> {
    const identity = this.identity;
    const provisionalAccountName = this.provisionalAccountName;
    if (!identity && !provisionalAccountName) return;
    await this.withAccountLock(async () => {
      if (identity && this.identity !== identity) return;
      if (!identity && provisionalAccountName) {
        if (this.provisionalAccountName !== provisionalAccountName) return;
        await this.removeAccountState(provisionalAccountName);
        this.provisionalAccountName = undefined;
        return;
      }
      if (!identity) return;
      await this.withDeviceAclLock(async () => {
        const current = await this.resolveAndValidateAccount(identity.name);
        if (current.uid !== identity.uid || current.gid !== identity.gid) {
          throw new Error(
            `Refusing to remove reused Cloud Hypervisor VMM account ${identity.name}`,
          );
        }
        await this.prepareAccountDeletionAclIntentLocked();
        const restoredTargets = await this.restoreDeviceAccessLocked();
        let deletionError: unknown;
        try {
          await this.removeValidatedAccountState(identity);
        } catch (error) {
          deletionError = error;
        }
        let finalRestoreError: unknown;
        try {
          await this.restoreDeviceAccessLocked(restoredTargets);
        } catch (error) {
          finalRestoreError = error;
        }
        if (deletionError && finalRestoreError) {
          throw new Error(
            `Cloud Hypervisor VMM identity cleanup failed: ${formatError(deletionError)}; ` +
            `final ACL restoration also failed: ${formatError(finalRestoreError)}`,
          );
        }
        if (deletionError) throw deletionError;
        if (finalRestoreError) throw finalRestoreError;
        await this.releaseDeviceAclIntentLocked();
      });
      this.identity = undefined;
    });
  }

  private async grantDeviceAccessLocked(
    identity: CloudHypervisorVmmIdentity,
    includeTun: boolean,
  ): Promise<void> {
    for (const devicePath of includeTun ? VMM_DEVICE_PATHS : VMM_DEVICE_PATHS.slice(0, 1)) {
      const before = await this.dependencies.run(this.tools.getfacl, [
        '--absolute-names', '--numeric', devicePath,
      ]);
      const baseline = parseDeviceAcl(before.stdout);
      const temporaryUids = await resolveTemporaryVmmAclUids(
        baseline,
        this.tools,
        this.dependencies.run,
      );
      await this.observer?.prepareAcl(devicePath, baseline, temporaryUids);
      await this.dependencies.run(this.tools.setfacl, [
        '--modify', `user:${identity.uid}:rw`, devicePath,
      ]);
      this.aclPaths.add(devicePath);
      this.accessedAclPaths.add(devicePath);
      this.aclBaselines.set(devicePath, baseline);
      this.aclTemporaryUids.set(devicePath, temporaryUids);
      const { stdout } = await this.dependencies.run(this.tools.getfacl, [
        '--absolute-names', '--numeric', devicePath,
      ]);
      if (!stdout.split(/\r?\n/).includes(`user:${identity.uid}:rw-`)) {
        throw new Error(`Cloud Hypervisor VMM ACL validation failed for ${devicePath}`);
      }
    }
  }

  private async restoreDeviceAccessLocked(
    retainedTargets?: ReadonlyMap<CloudHypervisorDevicePath, readonly string[]>,
  ): Promise<Map<CloudHypervisorDevicePath, string[]>> {
    const errors: unknown[] = [];
    const restoredTargets = new Map<CloudHypervisorDevicePath, string[]>();
    for (const devicePath of [...this.aclPaths].reverse()) {
      try {
        const baseline = this.aclBaselines.get(devicePath as CloudHypervisorDevicePath);
        if (!baseline) {
          throw new Error(`Cloud Hypervisor VMM ACL baseline is missing for ${devicePath}`);
        }
        const retainedTarget = retainedTargets?.get(
          devicePath as CloudHypervisorDevicePath,
        );
        let restoredTarget: string[];
        if (retainedTarget) {
          restoredTarget = [...retainedTarget];
        } else {
          const currentResult = await this.dependencies.run(this.tools.getfacl, [
            '--absolute-names', '--numeric', devicePath,
          ]);
          const current = parseDeviceAcl(currentResult.stdout);
          const liveTemporaryUids = await resolveTemporaryVmmAclUids(
            current,
            this.tools,
            this.dependencies.run,
          );
          restoredTarget = composeDeviceAcl(
            baseline,
            current,
            this.requireIdentity().uid,
            this.aclTemporaryUids.get(devicePath as CloudHypervisorDevicePath) ?? [],
            liveTemporaryUids,
          );
        }
        restoredTargets.set(devicePath as CloudHypervisorDevicePath, restoredTarget);
        await this.dependencies.run(this.tools.setfacl, [
          `--set=${deviceAclArgument(restoredTarget)}`, devicePath,
        ]);
        const { stdout } = await this.dependencies.run(this.tools.getfacl, [
          '--absolute-names', '--numeric', devicePath,
        ]);
        const restored = parseDeviceAcl(stdout);
        if (!sameDeviceAcl(restored, restoredTarget)) {
          throw new Error(
            `Cloud Hypervisor VMM ACL restoration failed for ${devicePath}: ` +
            `before=${describeDeviceAclShape(restoredTarget)} ` +
            `after=${describeDeviceAclShape(restored)}`,
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `Cloud Hypervisor VMM ACL cleanup failed: ${errors.map(formatError).join('; ')}`,
      );
    }
    return restoredTargets;
  }

  private async releaseDeviceAclIntentLocked(): Promise<void> {
    for (const devicePath of [...this.aclPaths].reverse()) {
      await this.observer?.releaseAcl(devicePath as CloudHypervisorDevicePath);
      this.aclPaths.delete(devicePath);
      this.aclBaselines.delete(devicePath as CloudHypervisorDevicePath);
      this.aclTemporaryUids.delete(devicePath as CloudHypervisorDevicePath);
    }
  }

  private async prepareAccountDeletionAclIntentLocked(): Promise<void> {
    const identity = this.requireIdentity();
    for (const devicePath of this.accessedAclPaths) {
      if (this.aclPaths.has(devicePath)) continue;
      const currentResult = await this.dependencies.run(this.tools.getfacl, [
        '--absolute-names', '--numeric', devicePath,
      ]);
      const baseline = parseDeviceAcl(currentResult.stdout);
      const temporaryUids = await resolveTemporaryVmmAclUids(
        baseline,
        this.tools,
        this.dependencies.run,
      );
      await this.observer?.prepareAcl(devicePath, baseline, temporaryUids);
      this.aclPaths.add(devicePath);
      this.aclBaselines.set(devicePath, baseline);
      this.aclTemporaryUids.set(devicePath, temporaryUids);
      if (baseline.some((entry) => namedUserAclUid(entry) === identity.uid)) {
        throw new Error(
          `Cloud Hypervisor VMM ACL still grants access to ${identity.uid} on ${devicePath}`,
        );
      }
    }
  }

  private async removeAccountState(name: string): Promise<void> {
    if (await this.accountExists(name)) {
      await this.dependencies.run(this.tools.userdel, [name]);
    }
    if (await this.groupExists(name)) {
      await this.dependencies.run(this.tools.groupdel, [name]);
    }
  }

  private async removeValidatedAccountState(
    identity: CloudHypervisorVmmIdentity,
  ): Promise<void> {
    await this.dependencies.run(this.tools.userdel, [identity.name]);
    if (await this.accountExists(identity.name)) {
      throw new Error(
        `Cloud Hypervisor VMM account deletion could not be verified: ${identity.name}`,
      );
    }
    if (!await this.groupExists(identity.name)) return;
    const { stdout } = await this.dependencies.run(this.tools.getent, ['group', identity.name]);
    const fields = stdout.trim().split(':');
    if (
      fields.length !== 4 ||
      fields[0] !== identity.name ||
      fields[2] !== String(identity.gid) ||
      fields[3] !== ''
    ) {
      throw new Error(`Cloud Hypervisor VMM group identity changed: ${identity.name}`);
    }
    await this.dependencies.run(this.tools.groupdel, [identity.name]);
    if (await this.groupExists(identity.name)) {
      throw new Error(
        `Cloud Hypervisor VMM group deletion could not be verified: ${identity.name}`,
      );
    }
  }

  private async groupExists(name: string): Promise<boolean> {
    try {
      await this.dependencies.run(this.tools.getent, ['group', name]);
      return true;
    } catch (error) {
      if ((error as { exitCode?: unknown }).exitCode === 2) return false;
      throw error;
    }
  }

  private async resolveAndValidateAccount(name: string): Promise<CloudHypervisorVmmIdentity> {
    return resolveAndValidateVmmAccount({
      name,
      accountLabel: 'Cloud Hypervisor VMM',
      tools: this.tools,
      run: this.dependencies.run,
      parsePositiveInteger,
    });
  }

  private async accountExists(name: string): Promise<boolean> {
    try {
      await this.dependencies.run(this.tools.id, ['-u', name]);
      return true;
    } catch (error) {
      if ((error as { exitCode?: unknown }).exitCode === 1) return false;
      throw error;
    }
  }


  private requireIdentity(): CloudHypervisorVmmIdentity {
    if (!this.identity) throw new Error('Cloud Hypervisor VMM identity has not been allocated');
    return this.identity;
  }

  private async withAccountLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLock(ACCOUNT_LOCK_DIRECTORY, ACCOUNT_LOCK_TIMEOUT_MS, operation);
  }

  async withDeviceAclLock<T>(
    operation: () => Promise<T>,
    lockDirectory = DEVICE_ACL_LOCK_DIRECTORY,
  ): Promise<T> {
    return this.withLock(lockDirectory, DEVICE_ACL_LOCK_TIMEOUT_MS, operation);
  }

  private async withLock<T>(
    lockDirectory: string,
    timeoutMs: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withDirectoryLock({
      lockDirectory,
      timeoutMs,
      retryMs: ACCOUNT_LOCK_RETRY_MS,
      dependencies: this.dependencies,
      startTimeErrorMessage: 'Cannot determine AWF process start time for VMM identity lock',
      timeoutErrorMessage: 'Timed out waiting for the Cloud Hypervisor VMM identity lock',
      reclaimStaleLock: (directory) => this.reclaimStaleLock(directory),
      removeOwnedLock: (directory, owner) => this.removeOwnedLock(directory, owner),
      operation,
    });
  }

  private async reclaimStaleLock(lockDirectory: string): Promise<void> {
    const reaperDirectory = path.join(lockDirectory, '.reaper');
    let initialStats: Awaited<ReturnType<CloudHypervisorVmmIdentityDependencies['lstat']>>;
    try {
      initialStats = await this.dependencies.lstat(lockDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let owner = await this.readLockOwner(lockDirectory);
    if (
      !owner &&
      (initialStats.mtimeMs === undefined ||
        Date.now() - initialStats.mtimeMs < INCOMPLETE_LOCK_STALE_MS)
    ) {
      return;
    }
    if (owner) {
      const liveStartTime = await this.dependencies.processStartTime(owner.pid);
      if (liveStartTime === owner.startTime) return;
    }
    if (!await this.tryClaimReaper(reaperDirectory, initialStats)) return;
    try {
      const currentStats = await this.dependencies.lstat(lockDirectory);
      if (
        initialStats.ino === undefined ||
        currentStats.ino === undefined ||
        currentStats.ino !== initialStats.ino
      ) return;
      owner = await this.readLockOwner(lockDirectory);
      if (owner) {
        const liveStartTime = await this.dependencies.processStartTime(owner.pid);
        if (liveStartTime === owner.startTime) return;
      } else if (
        initialStats.mtimeMs === undefined ||
        Date.now() - initialStats.mtimeMs < INCOMPLETE_LOCK_STALE_MS
      ) {
        return;
      }
      await this.dependencies.rm(lockDirectory, { recursive: true, force: true });
    } finally {
      await this.dependencies.rmdir(reaperDirectory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  private async readLockOwner(lockDirectory: string): Promise<LockOwner | undefined> {
    try {
      const parsed = JSON.parse(
        await this.dependencies.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'),
      ) as LockOwner;
      return isLockOwner(parsed) ? parsed : undefined;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        error instanceof SyntaxError
      ) return undefined;
      throw error;
    }
  }

  private async tryClaimReaper(
    reaperDirectory: string,
    lockStats: Awaited<ReturnType<CloudHypervisorVmmIdentityDependencies['lstat']>>,
  ): Promise<boolean> {
    try {
      await this.dependencies.mkdir(reaperDirectory, { mode: 0o700 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      try {
        const reaperStats = await this.dependencies.lstat(reaperDirectory);
        if (
          lockStats.ino !== undefined &&
          reaperStats.mtimeMs !== undefined &&
          Date.now() - reaperStats.mtimeMs >= INCOMPLETE_LOCK_STALE_MS
        ) {
          await this.dependencies.rmdir(reaperDirectory);
        }
      } catch (reaperError) {
        if ((reaperError as NodeJS.ErrnoException).code !== 'ENOENT') throw reaperError;
      }
      return false;
    }
  }

  private async removeOwnedLock(lockDirectory: string, owner: LockOwner): Promise<void> {
    const current = JSON.parse(
      await this.dependencies.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'),
    ) as LockOwner;
    if (!isSameLockOwner(owner, current)) {
      throw new Error('Cloud Hypervisor VMM account lock ownership changed unexpectedly');
    }
    await this.dependencies.rm(lockDirectory, { recursive: true, force: true });
  }
}

export async function resolveTemporaryVmmAclUids(
  entries: readonly string[],
  tools: Pick<CloudHypervisorVmmIdentityToolPaths, 'getent' | 'id'>,
  run: CloudHypervisorVmmIdentityDependencies['run'],
): Promise<number[]> {
  const temporaryUids: number[] = [];
  for (const entry of entries) {
    const uid = namedUserAclUid(entry);
    if (uid === undefined) continue;
    let passwdResult: { stdout: string; stderr: string; exitCode?: number };
    try {
      passwdResult = await run(tools.getent, ['passwd', String(uid)]);
    } catch (error) {
      if ((error as { exitCode?: unknown }).exitCode === 2) continue;
      throw error;
    }
    if (passwdResult.exitCode === 2) continue;
    if (passwdResult.exitCode !== undefined && passwdResult.exitCode !== 0) {
      throw new Error(
        `Could not classify Cloud Hypervisor device ACL uid ${uid}: ` +
        `${passwdResult.stderr.trim()}`,
      );
    }
    const passwd = passwdResult.stdout.trim().split(':');
    const name = passwd[0] ?? '';
    if (!/^awfvmm-[a-f0-9]{20}$/.test(name)) continue;
    if (passwd[2] !== String(uid)) {
      throw new Error(`Cloud Hypervisor device ACL account uid changed: ${name}`);
    }
    const identity = await resolveAndValidateVmmAccount({
      name,
      accountLabel: 'Cloud Hypervisor VMM',
      tools,
      run: async (command, args) => {
        const result = await run(command, args) as {
          stdout: string;
          stderr: string;
          exitCode?: number;
        };
        if (result.exitCode !== undefined && result.exitCode !== 0) {
          throw Object.assign(new Error(result.stderr.trim()), { exitCode: result.exitCode });
        }
        return result;
      },
      parsePositiveInteger,
      assertPasswdState: (fields) => {
        if (!fields[4].startsWith('AWF Cloud Hypervisor')) throw new Error('invalid comment');
      },
    });
    if (identity.uid !== uid) {
      throw new Error(`Cloud Hypervisor device ACL account uid changed: ${name}`);
    }
    temporaryUids.push(uid);
  }
  return temporaryUids;
}

export function withCloudHypervisorDeviceAclLock<T>(
  tools: CloudHypervisorVmmIdentityToolPaths,
  operation: () => Promise<T>,
  dependencies: Partial<CloudHypervisorVmmIdentityDependencies> = {},
  lockDirectory = DEVICE_ACL_LOCK_DIRECTORY,
): Promise<T> {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  if (!dependencies.processStartTime && dependencies.readFile) {
    resolvedDependencies.processStartTime = (pid) =>
      readProcessStartTime(pid, resolvedDependencies.readFile);
  }
  const manager = new CloudHypervisorVmmIdentityManager(
    'device-acl-recovery',
    tools,
    resolvedDependencies,
  );
  return manager.withDeviceAclLock(operation, lockDirectory);
}

export function createAccountName(): string {
  return `${ACCOUNT_PREFIX}${randomBytes(10).toString('hex')}`;
}

/** @internal Exposed only for focused lock-owner tests. */
export const cloudHypervisorVmmIdentityTestHelpers = {
  defaultRun: defaultDependencies.run,
  defaultSleep: defaultDependencies.sleep,
  formatError,
  isLockOwner,
  isSameLockOwner,
  parseProcessStatStartTime,
  parsePositiveInteger,
  readProcessStartTime,
};

async function readProcessStartTime(
  pid: number,
  readFile: (filePath: string, encoding: 'utf8') => Promise<string> =
    (filePath, encoding) => fs.readFile(filePath, encoding),
): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return parseProcessStatStartTime(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseProcessStatStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).split(' ');
  return fields[19]?.trim();
}

function parsePositiveInteger(value: string, label: string): number {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Cloud Hypervisor VMM account returned an invalid ${label}: ${trimmed}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Cloud Hypervisor VMM account returned an unsafe ${label}: ${trimmed}`);
  }
  return parsed;
}

function isLockOwner(value: LockOwner): boolean {
  return Number.isSafeInteger(value?.pid) && value.pid > 0 &&
    typeof value.startTime === 'string' && /^\d+$/.test(value.startTime) &&
    typeof value.nonce === 'string' && /^[a-f0-9]{32}$/.test(value.nonce);
}

function isSameLockOwner(left: LockOwner, right: LockOwner): boolean {
  return isLockOwner(left) && isLockOwner(right) &&
    left.pid === right.pid && left.startTime === right.startTime && left.nonce === right.nonce;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
