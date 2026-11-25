import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { createDefaultIdentityDependencies } from '../identity-dependencies';
import {
  reclaimStaleDirectoryLock,
  removeOwnedDirectoryLock,
  withDirectoryLock,
} from '../microvm/directory-lock';
import { formatError, parsePositiveInteger, readProcessStartTime } from '../microvm/identity-utils';
import { resolveAndValidateVmmAccount } from '../vmm-account-validation';
import type { NvxCleanupDeviceAclIdentity } from './cleanup-record';
import { createNvxRunLayout } from './run-layout';

const ACCOUNT_PREFIX = 'awfnvx-';
const ACCOUNT_LOCK_DIRECTORY = '/run/awf-nvx/.account-lock';
const DEVICE_ACL_LOCK_DIRECTORY = '/run/awf-nvx/.device-acl-lock';
const LOCK_RETRY_MS = 25;
const ACCOUNT_LOCK_TIMEOUT_MS = 10_000;
const DEVICE_ACL_LOCK_TIMEOUT_MS = 60_000;
type NvxDevicePath = NvxCleanupDeviceAclIdentity['path'];
const NVX_DEVICE_PATHS: readonly NvxDevicePath[] = ['/dev/kvm'];

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

const defaultDependencies: NvxRuntimeLifecycleDependencies = {
  ...createDefaultIdentityDependencies(readProcessStartTime),
  rename: fs.rename,
};

async function withLifecycleLock<T>(
  dependencies: NvxRuntimeLifecycleDependencies,
  lockDirectory: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  return withDirectoryLock({
    lockDirectory,
    timeoutMs,
    retryMs: LOCK_RETRY_MS,
    dependencies,
    startTimeErrorMessage: 'Cannot determine AWF process start time for NVX lifecycle lock',
    timeoutErrorMessage: 'Timed out waiting for the NVX lifecycle lock',
    reclaimStaleLock: (directory) => reclaimStaleDirectoryLock(dependencies, directory),
    removeOwnedLock: (directory, owner) => removeOwnedDirectoryLock(
      dependencies, directory, owner, 'NVX lifecycle lock ownership changed unexpectedly',
      { timeoutMs, retryMs: LOCK_RETRY_MS },
    ),
    operation,
  });
}

export function withNvxDeviceAclLock<T>(
  operation: () => Promise<T>,
  dependencies: NvxRuntimeLifecycleDependencies = defaultDependencies,
): Promise<T> {
  return withLifecycleLock(
    dependencies,
    DEVICE_ACL_LOCK_DIRECTORY,
    DEVICE_ACL_LOCK_TIMEOUT_MS,
    operation,
  );
}

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
    return withLifecycleLock(this.dependencies, ACCOUNT_LOCK_DIRECTORY, ACCOUNT_LOCK_TIMEOUT_MS, async () => {
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
    const acls = await withNvxDeviceAclLock(async () => {
      if (this.identity !== identity) throw new Error('NVX VMM identity changed before device ACL grant');
      try {
        return await this.grantDeviceAccessLocked(identity, requested);
      } catch (error) {
        try {
          await this.revokeDeviceAccessLocked(identity);
        } catch (revokeError) {
          throw new Error(
            `NVX device ACL grant failed: ${formatError(error)}; ` +
            `ACL revocation also failed: ${formatError(revokeError)}`,
          );
        }
        throw error;
      }
    }, this.dependencies);
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation(acls);
    } catch (error) {
      operationError = error;
    }
    try {
      await withNvxDeviceAclLock(() => this.revokeDeviceAccessLocked(identity), this.dependencies);
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
  }

  async cleanup(): Promise<void> {
    const identity = this.identity;
    const provisionalAccountName = this.provisionalAccountName;
    if (!identity && !provisionalAccountName) return;
    await withLifecycleLock(this.dependencies, ACCOUNT_LOCK_DIRECTORY, ACCOUNT_LOCK_TIMEOUT_MS, async () => {
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
      await withNvxDeviceAclLock(() => this.revokeDeviceAccessLocked(identity), this.dependencies);
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
    return resolveAndValidateVmmAccount({
      name,
      accountLabel: 'NVX VMM',
      tools: this.tools,
      run: this.dependencies.run,
      parsePositiveInteger,
      assertPasswdState: (passwd) => {
        if (!passwd[4].includes(this.runId)) {
          throw new Error('unsafe passwd state');
        }
      },
    });
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
