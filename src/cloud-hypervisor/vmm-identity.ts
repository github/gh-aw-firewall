import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';

const ACCOUNT_PREFIX = 'awfvmm-';
const ACCOUNT_LOCK_DIRECTORY = '/run/awf-cloud-hypervisor/.account-lock';
const ACCOUNT_REAPER_DIRECTORY = path.join(ACCOUNT_LOCK_DIRECTORY, '.reaper');
const ACCOUNT_LOCK_RETRY_MS = 25;
const ACCOUNT_LOCK_TIMEOUT_MS = 10_000;
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
  prepareAcl(path: string): Promise<void>;
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

const defaultDependencies: CloudHypervisorVmmIdentityDependencies = {
  mkdir: fs.mkdir,
  writeFile: fs.writeFile,
  readFile: fs.readFile,
  rm: fs.rm,
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

interface LockOwner {
  readonly pid: number;
  readonly startTime: string;
  readonly nonce: string;
}

export class CloudHypervisorVmmIdentityManager {
  private identity: CloudHypervisorVmmIdentity | undefined;
  private provisionalAccountName: string | undefined;
  private readonly aclPaths = new Set<string>();

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

  async grantDeviceAccess(): Promise<void> {
    const identity = this.requireIdentity();
    await this.withAccountLock(async () => {
      if (this.identity !== identity) {
        throw new Error('Cloud Hypervisor VMM identity changed before device ACL grant');
      }
      for (const devicePath of VMM_DEVICE_PATHS) {
        await this.observer?.prepareAcl(devicePath);
        await this.dependencies.run(this.tools.setfacl, [
          '--modify', `user:${identity.uid}:rw`, devicePath,
        ]);
        this.aclPaths.add(devicePath);
        const { stdout } = await this.dependencies.run(this.tools.getfacl, [
          '--absolute-names', '--numeric', devicePath,
        ]);
        if (!stdout.split(/\r?\n/).includes(`user:${identity.uid}:rw-`)) {
          throw new Error(`Cloud Hypervisor VMM ACL validation failed for ${devicePath}`);
        }
      }
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
      const current = await this.resolveAndValidateAccount(identity.name);
      if (current.uid !== identity.uid || current.gid !== identity.gid) {
        throw new Error(
          `Refusing to remove reused Cloud Hypervisor VMM account ${identity.name}`,
        );
      }
      const errors: unknown[] = [];
      for (const devicePath of [...this.aclPaths].reverse()) {
        try {
          await this.dependencies.run(this.tools.setfacl, [
            '--remove', `user:${identity.uid}`, devicePath,
          ]);
          const { stdout } = await this.dependencies.run(this.tools.getfacl, [
            '--absolute-names', '--numeric', devicePath,
          ]);
          if (stdout.split(/\r?\n/).some((line) => line.startsWith(`user:${identity.uid}:`))) {
            throw new Error(`Cloud Hypervisor VMM ACL removal validation failed for ${devicePath}`);
          }
          this.aclPaths.delete(devicePath);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0 || this.aclPaths.size > 0) {
        throw new Error(
          `Cloud Hypervisor VMM ACL cleanup failed: ${errors.map(formatError).join('; ')}`,
        );
      }
      await this.removeAccountState(identity.name);
      this.identity = undefined;
    });
  }

  private async removeAccountState(name: string): Promise<void> {
    if (await this.accountExists(name)) {
      await this.dependencies.run(this.tools.userdel, [name]);
    }
    if (await this.groupExists(name)) {
      await this.dependencies.run(this.tools.groupdel, [name]);
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

  private async resolveAndValidateAccount(name: string): Promise<CloudHypervisorVmmIdentity> {
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
    const groups = groupsText.trim().split(/\s+/).filter(Boolean).map((value) =>
      parsePositiveInteger(value, 'supplementary group'));
    if (groups.length !== 1 || groups[0] !== gid) {
      throw new Error(
        `Cloud Hypervisor VMM account ${name} inherited supplementary groups: ${groups.join(' ')}`,
      );
    }
    const passwd = passwdText.trim().split(':');
    if (
      passwd.length !== 7 ||
      passwd[0] !== name ||
      passwd[2] !== String(uid) ||
      passwd[3] !== String(gid) ||
      passwd[5] !== '/nonexistent' ||
      passwd[6] !== '/usr/sbin/nologin'
    ) {
      throw new Error(`Cloud Hypervisor VMM account ${name} has unsafe passwd state`);
    }
    return { name, uid, gid };
  }

  private async accountExists(name: string): Promise<boolean> {
    try {
      await this.dependencies.run(this.tools.id, ['-u', name]);
      return true;
    } catch {
      return false;
    }
  }


  private requireIdentity(): CloudHypervisorVmmIdentity {
    if (!this.identity) throw new Error('Cloud Hypervisor VMM identity has not been allocated');
    return this.identity;
  }

  private async withAccountLock<T>(operation: () => Promise<T>): Promise<T> {
    const parent = path.dirname(ACCOUNT_LOCK_DIRECTORY);
    await this.dependencies.mkdir(parent, { recursive: true, mode: 0o711 });
    const startTime = await this.dependencies.processStartTime(this.dependencies.pid);
    if (!startTime) throw new Error('Cannot determine AWF process start time for VMM account lock');
    const owner: LockOwner = {
      pid: this.dependencies.pid,
      startTime,
      nonce: randomBytes(16).toString('hex'),
    };
    const deadline = Date.now() + ACCOUNT_LOCK_TIMEOUT_MS;
    for (;;) {
      let acquired = false;
      try {
        await this.dependencies.mkdir(ACCOUNT_LOCK_DIRECTORY, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (acquired) {
        try {
          await this.dependencies.writeFile(
            path.join(ACCOUNT_LOCK_DIRECTORY, 'owner.json'),
            `${JSON.stringify(owner)}\n`,
            { flag: 'wx', mode: 0o600 },
          );
          return await operation();
        } finally {
          await this.removeOwnedLock(owner);
        }
      }
      await this.reclaimStaleLock();
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the Cloud Hypervisor VMM account lock');
      }
      await this.dependencies.sleep(ACCOUNT_LOCK_RETRY_MS);
    }
  }

  private async reclaimStaleLock(): Promise<void> {
    let initialStats: Awaited<ReturnType<CloudHypervisorVmmIdentityDependencies['lstat']>>;
    try {
      initialStats = await this.dependencies.lstat(ACCOUNT_LOCK_DIRECTORY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let owner = await this.readLockOwner();
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
    if (!await this.tryClaimReaper(initialStats)) return;
    try {
      const currentStats = await this.dependencies.lstat(ACCOUNT_LOCK_DIRECTORY);
      if (
        initialStats.ino === undefined ||
        currentStats.ino === undefined ||
        currentStats.ino !== initialStats.ino
      ) return;
      owner = await this.readLockOwner();
      if (owner) {
        const liveStartTime = await this.dependencies.processStartTime(owner.pid);
        if (liveStartTime === owner.startTime) return;
      } else if (
        initialStats.mtimeMs === undefined ||
        Date.now() - initialStats.mtimeMs < INCOMPLETE_LOCK_STALE_MS
      ) {
        return;
      }
      await this.dependencies.rm(ACCOUNT_LOCK_DIRECTORY, { recursive: true, force: true });
    } finally {
      await this.dependencies.rmdir(ACCOUNT_REAPER_DIRECTORY).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  private async readLockOwner(): Promise<LockOwner | undefined> {
    try {
      const parsed = JSON.parse(
        await this.dependencies.readFile(path.join(ACCOUNT_LOCK_DIRECTORY, 'owner.json'), 'utf8'),
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
    lockStats: Awaited<ReturnType<CloudHypervisorVmmIdentityDependencies['lstat']>>,
  ): Promise<boolean> {
    try {
      await this.dependencies.mkdir(ACCOUNT_REAPER_DIRECTORY, { mode: 0o700 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      try {
        const reaperStats = await this.dependencies.lstat(ACCOUNT_REAPER_DIRECTORY);
        if (
          lockStats.ino !== undefined &&
          reaperStats.mtimeMs !== undefined &&
          Date.now() - reaperStats.mtimeMs >= INCOMPLETE_LOCK_STALE_MS
        ) {
          await this.dependencies.rmdir(ACCOUNT_REAPER_DIRECTORY);
        }
      } catch (reaperError) {
        if ((reaperError as NodeJS.ErrnoException).code !== 'ENOENT') throw reaperError;
      }
      return false;
    }
  }

  private async removeOwnedLock(owner: LockOwner): Promise<void> {
    const current = JSON.parse(
      await this.dependencies.readFile(path.join(ACCOUNT_LOCK_DIRECTORY, 'owner.json'), 'utf8'),
    ) as LockOwner;
    if (!isSameLockOwner(owner, current)) {
      throw new Error('Cloud Hypervisor VMM account lock ownership changed unexpectedly');
    }
    await this.dependencies.rm(ACCOUNT_LOCK_DIRECTORY, { recursive: true, force: true });
  }
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
  readFile: typeof fs.readFile = fs.readFile,
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
  return fields[19];
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
