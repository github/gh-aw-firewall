import { randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import type { MicrovmNetworkPlan } from '../microvm/network';
import type { CloudHypervisorRunPaths } from './manager-types';

const CLEANUP_DIRECTORY_NAME = 'pending-cleanup';
const RECORD_VERSION = 1;
const PROCESS_STOP_WAIT_MS = 2_000;
const PROCESS_STOP_INTERVAL_MS = 50;
const PROCESS_IDENTITY_WAIT_MS = 2_000;
const PROCESS_IDENTITY_INTERVAL_MS = 10;
const CGROUP_REMOVAL_WAIT_MS = 5_000;
const CGROUP_REMOVAL_INTERVAL_MS = 100;

interface FileIdentity {
  readonly device: string;
  readonly inode: string;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly executableIdentity: FileIdentity;
  readonly uid: number;
  readonly gid: number;
  readonly networkNamespace: string;
}

interface InterfaceIdentity {
  readonly name: string;
  readonly namespace?: string;
  readonly ifindex: number;
}

interface MountIdentity {
  readonly mountId: number;
  readonly device: string;
  readonly root: string;
  readonly mountPoint: string;
  readonly filesystemType: string;
  readonly source: string;
}

interface RecordedProcess {
  readonly state: 'pending' | 'live';
  readonly executable: string;
  readonly socketPath: string;
  readonly sourcePath?: string;
  readonly identity?: ProcessIdentity;
}

interface CleanupRecord {
  readonly version: 1;
  readonly runId: string;
  readonly owner: ProcessIdentity;
  readonly cloudHypervisorBinary: string;
  readonly paths: {
    readonly runDirectory: string;
    readonly cgroupPath: string;
    readonly virtiofsdShareDirectory: string;
  };
  readonly network: {
    readonly namespaceName: string;
    readonly netnsPath: string;
    readonly hostVethName: string;
    readonly namespaceVethName: string;
    readonly tapName: string;
    readonly infrastructureBridge: string;
    readonly hostForwardRuleComment: string;
  };
  readonly identities: {
    runDirectory?: FileIdentity;
    cgroup?: FileIdentity;
    virtiofsdShareDirectory?: FileIdentity;
    netns?: FileIdentity;
    hostVeth?: InterfaceIdentity;
    namespaceVeth?: InterfaceIdentity;
    tap?: InterfaceIdentity;
  };
  readonly processes: Record<string, RecordedProcess>;
  mounts: MountIdentity[];
  updatedAt: string;
}

export type CloudHypervisorNetworkResource =
  'netns' | 'hostVeth' | 'namespaceVeth' | 'tap';

export interface CloudHypervisorCleanupHandle {
  captureNetworkResource(resource: CloudHypervisorNetworkResource): Promise<void>;
  captureRunDirectory(): Promise<void>;
  captureCgroup(): Promise<void>;
  captureVirtiofsdResources(): Promise<void>;
  prepareProcess(
    key: string,
    executable: string,
    socketPath: string,
    sourcePath?: string,
  ): Promise<void>;
  captureProcess(key: string, pid: number): Promise<void>;
  complete(): Promise<void>;
}

export interface CloudHypervisorCleanupRegistry {
  reapPending(ipPath: string, umountPath: string): Promise<void>;
  create(
    paths: CloudHypervisorRunPaths,
    plan: MicrovmNetworkPlan,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle>;
}

export interface CleanupRegistryDependencies {
  readonly rootDirectory?: string;
  readonly effectiveUid?: number;
  readonly processId?: number;
  readonly readFile?: typeof fs.readFile;
  readonly readlink?: typeof fs.readlink;
  readonly realpath?: typeof fs.realpath;
  readonly lstat?: typeof fs.lstat;
  readonly stat?: typeof fs.stat;
  readonly mkdir?: typeof fs.mkdir;
  readonly readdir?: typeof fs.readdir;
  readonly rename?: typeof fs.rename;
  readonly link?: typeof fs.link;
  readonly unlink?: typeof fs.unlink;
  readonly rm?: typeof fs.rm;
  readonly rmdir?: typeof fs.rmdir;
  readonly open?: typeof fs.open;
  readonly kill?: typeof process.kill;
  readonly run?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface ResolvedDependencies {
  readonly rootDirectory: string;
  readonly effectiveUid: number;
  readonly processId: number;
  readonly readFile: typeof fs.readFile;
  readonly readlink: typeof fs.readlink;
  readonly realpath: typeof fs.realpath;
  readonly lstat: typeof fs.lstat;
  readonly stat: typeof fs.stat;
  readonly mkdir: typeof fs.mkdir;
  readonly readdir: typeof fs.readdir;
  readonly rename: typeof fs.rename;
  readonly link: typeof fs.link;
  readonly unlink: typeof fs.unlink;
  readonly rm: typeof fs.rm;
  readonly rmdir: typeof fs.rmdir;
  readonly open: typeof fs.open;
  readonly kill: typeof process.kill;
  readonly run: NonNullable<CleanupRegistryDependencies['run']>;
  readonly sleep: NonNullable<CleanupRegistryDependencies['sleep']>;
}

export class DurableCloudHypervisorCleanupRegistry implements CloudHypervisorCleanupRegistry {
  private readonly dependencies: ResolvedDependencies;

  constructor(dependencies: CleanupRegistryDependencies = {}) {
    const runRoot = dependencies.rootDirectory ?? '/run/awf-cloud-hypervisor';
    this.dependencies = {
      rootDirectory: path.join(runRoot, CLEANUP_DIRECTORY_NAME),
      effectiveUid: dependencies.effectiveUid ?? process.geteuid?.() ?? -1,
      processId: dependencies.processId ?? process.pid,
      readFile: dependencies.readFile ?? fs.readFile,
      readlink: dependencies.readlink ?? fs.readlink,
      realpath: dependencies.realpath ?? fs.realpath,
      lstat: dependencies.lstat ?? fs.lstat,
      stat: dependencies.stat ?? fs.stat,
      mkdir: dependencies.mkdir ?? fs.mkdir,
      readdir: dependencies.readdir ?? fs.readdir,
      rename: dependencies.rename ?? fs.rename,
      link: dependencies.link ?? fs.link,
      unlink: dependencies.unlink ?? fs.unlink,
      rm: dependencies.rm ?? fs.rm,
      rmdir: dependencies.rmdir ?? fs.rmdir,
      open: dependencies.open ?? fs.open,
      kill: dependencies.kill ?? process.kill,
      run: dependencies.run ?? runCommand,
      sleep: dependencies.sleep ?? ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
  }

  async reapPending(ipPath: string, umountPath: string): Promise<void> {
    await this.ensureRegistryDirectory();
    const names = await this.dependencies.readdir(this.dependencies.rootDirectory);
    const errors: string[] = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9_.-]+\.json$/.test(name)) continue;
      const recordPath = path.join(this.dependencies.rootDirectory, name);
      try {
        const record = await this.readRecord(recordPath);
        if (await this.processMatches(record.owner)) continue;
        const release = await this.claim(recordPath);
        if (!release) continue;
        try {
          await this.reapRecord(recordPath, record, ipPath, umountPath);
        } finally {
          await release();
        }
      } catch (error) {
        errors.push(`${recordPath}: ${formatError(error)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `Cloud Hypervisor stale cleanup is incomplete; retained recovery records: ${errors.join('; ')}`,
      );
    }
  }

  async create(
    paths: CloudHypervisorRunPaths,
    plan: MicrovmNetworkPlan,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle> {
    await this.ensureRegistryDirectory();
    assertSafeRecordPaths(paths, plan);
    const recordPath = path.join(this.dependencies.rootDirectory, `${paths.runId}.json`);
    const owner = await this.captureProcessIdentity(this.dependencies.processId);
    const binary = await this.dependencies.realpath(cloudHypervisorBinary);
    const record: CleanupRecord = {
      version: RECORD_VERSION,
      runId: paths.runId,
      owner,
      cloudHypervisorBinary: binary,
      paths: {
        runDirectory: paths.runDirectory,
        cgroupPath: paths.cgroupPath,
        virtiofsdShareDirectory: paths.virtiofsdShareDirectory,
      },
      network: {
        namespaceName: plan.namespaceName,
        netnsPath: plan.netnsPath,
        hostVethName: plan.hostVethName,
        namespaceVethName: plan.namespaceVethName,
        tapName: plan.tapName,
        infrastructureBridge: plan.infrastructureBridge,
        hostForwardRuleComment: plan.hostForwardRuleComment,
      },
      identities: {},
      processes: {},
      mounts: [],
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecord(recordPath, record, true);
    return this.createHandle(recordPath, record, ipPath);
  }

  private createHandle(
    recordPath: string,
    record: CleanupRecord,
    ipPath: string,
  ): CloudHypervisorCleanupHandle {
    const update = async (): Promise<void> => {
      record.updatedAt = new Date().toISOString();
      await this.writeRecord(recordPath, record, false);
    };
    return {
      captureNetworkResource: async (resource) => {
        switch (resource) {
          case 'netns':
            record.identities.netns = await this.captureFileIdentity(record.network.netnsPath);
            break;
          case 'hostVeth':
            record.identities.hostVeth = await this.captureInterfaceIdentity(
              ipPath, record.network.hostVethName,
            );
            break;
          case 'namespaceVeth':
            record.identities.namespaceVeth = await this.captureInterfaceIdentity(
              ipPath, record.network.namespaceVethName, record.network.namespaceName,
            );
            break;
          case 'tap':
            record.identities.tap = await this.captureInterfaceIdentity(
              ipPath, record.network.tapName, record.network.namespaceName,
            );
            break;
        }
        await update();
      },
      captureRunDirectory: async () => {
        record.identities.runDirectory = await this.captureFileIdentity(record.paths.runDirectory);
        await update();
      },
      captureCgroup: async () => {
        record.identities.cgroup = await this.captureFileIdentity(record.paths.cgroupPath);
        await update();
      },
      captureVirtiofsdResources: async () => {
        if (await pathExists(record.paths.virtiofsdShareDirectory, this.dependencies.lstat)) {
          record.identities.virtiofsdShareDirectory = await this.captureFileIdentity(
            record.paths.virtiofsdShareDirectory,
          );
          record.mounts = (await this.readMounts()).filter((mount) =>
            mount.mountPoint === record.paths.virtiofsdShareDirectory ||
            mount.mountPoint.startsWith(`${record.paths.virtiofsdShareDirectory}${path.sep}`),
          );
        }
        await update();
      },
      prepareProcess: async (key, executable, socketPath, sourcePath) => {
        assertSafeProcessKey(key);
        // The key is restricted to a non-prototypal identifier alphabet above.
        // eslint-disable-next-line security/detect-object-injection
        record.processes[key] = {
          state: 'pending',
          executable: await this.dependencies.realpath(executable),
          socketPath,
          ...(sourcePath ? { sourcePath } : {}),
        };
        await update();
      },
      captureProcess: async (key, pid) => {
        assertSafeProcessKey(key);
        // The key is restricted to a non-prototypal identifier alphabet above.
        // eslint-disable-next-line security/detect-object-injection
        const pending = record.processes[key];
        if (!pending) throw new Error(`Cleanup identity was not prepared for process "${key}"`);
        const expectedNetworkNamespace = key === 'vmm'
          ? `net:[${record.identities.netns?.inode}]`
          : undefined;
        const requiresPrivateNetworkNamespace = key.startsWith('virtiofsd-');
        const deadline = Date.now() + PROCESS_IDENTITY_WAIT_MS;
        let identity: ProcessIdentity;
        for (;;) {
          identity = await this.captureProcessIdentity(pid);
          if (
            identity.executable === pending.executable &&
            (
              expectedNetworkNamespace === undefined ||
              identity.networkNamespace === expectedNetworkNamespace
            ) &&
            (
              !requiresPrivateNetworkNamespace ||
              identity.networkNamespace !== record.owner.networkNamespace
            )
          ) break;
          if (Date.now() >= deadline) {
            throw new Error(`Process "${key}" did not match its prepared cleanup identity`);
          }
          // execa returns after fork; allow the trusted ip -> setpriv -> target
          // exec chain to finish before requiring the final executable/netns.
          await this.dependencies.sleep(PROCESS_IDENTITY_INTERVAL_MS);
        }
        // eslint-disable-next-line security/detect-object-injection
        record.processes[key] = { ...pending, state: 'live', identity };
        await update();
      },
      complete: async () => {
        await this.dependencies.unlink(recordPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      },
    };
  }

  private async reapRecord(
    recordPath: string,
    record: CleanupRecord,
    ipPath: string,
    umountPath: string,
  ): Promise<void> {
    await this.validateRecordResources(record, ipPath);
    for (const [key, recorded] of Object.entries(record.processes)) {
      if (recorded.state === 'pending' || !recorded.identity) {
        throw new Error(`process "${key}" launch identity was never committed`);
      }
      if (await this.processMatches(recorded.identity, recorded)) {
        await this.stopProcess(recorded.identity, recorded);
      }
    }
    await this.unmountVirtiofsdResources(record, umountPath);
    await this.deleteNetwork(record, ipPath);
    await removeExactDirectory(
      record.paths.cgroupPath, record.identities.cgroup, this.dependencies, false,
    );
    await this.assertNoMountsUnder(record.paths.runDirectory);
    await removeExactDirectory(
      record.paths.runDirectory, record.identities.runDirectory, this.dependencies, true,
    );
    await this.assertNoMountsUnder(record.paths.virtiofsdShareDirectory);
    await removeExactDirectory(
      record.paths.virtiofsdShareDirectory,
      record.identities.virtiofsdShareDirectory,
      this.dependencies,
      true,
    );
    await this.dependencies.unlink(recordPath);
  }

  private async validateRecordResources(record: CleanupRecord, ipPath: string): Promise<void> {
    const netnsExists = await pathExists(record.network.netnsPath, this.dependencies.lstat);
    await this.validateFileIfPresent(record.network.netnsPath, record.identities.netns, 'netns');
    await this.validateFileIfPresent(
      record.paths.runDirectory, record.identities.runDirectory, 'run directory',
    );
    await this.validateFileIfPresent(record.paths.cgroupPath, record.identities.cgroup, 'cgroup');
    await this.validateFileIfPresent(
      record.paths.virtiofsdShareDirectory,
      record.identities.virtiofsdShareDirectory,
      'virtiofsd share directory',
    );
    await this.validateInterfaceIfPresent(
      ipPath, record.network.hostVethName, record.identities.hostVeth, undefined,
    );
    if (netnsExists) {
      await this.validateInterfaceIfPresent(
        ipPath,
        record.network.namespaceVethName,
        record.identities.namespaceVeth,
        record.network.namespaceName,
      );
      await this.validateInterfaceIfPresent(
        ipPath, record.network.tapName, record.identities.tap, record.network.namespaceName,
      );
    }
  }

  private async deleteNetwork(record: CleanupRecord, ipPath: string): Promise<void> {
    if (await this.interfaceExists(ipPath, record.network.hostVethName)) {
      await this.validateInterfaceIfPresent(
        ipPath,
        record.network.hostVethName,
        record.identities.hostVeth,
        undefined,
      );
      await this.runChecked(ipPath, ['link', 'delete', record.network.hostVethName]);
    }
    if (await pathExists(record.network.netnsPath, this.dependencies.lstat)) {
      await this.validateFileIfPresent(
        record.network.netnsPath,
        record.identities.netns,
        'netns',
      );
      await this.runChecked(ipPath, ['netns', 'delete', record.network.namespaceName]);
    }
    const rule = bridgeForwardRule(
      '-C',
      record.network.infrastructureBridge,
      record.network.hostForwardRuleComment,
    );
    const checked = await this.dependencies.run('iptables', rule);
    if (checked.exitCode === 0) {
      await this.runChecked('iptables', bridgeForwardRule(
        '-D',
        record.network.infrastructureBridge,
        record.network.hostForwardRuleComment,
      ));
    } else if (checked.exitCode !== 1) {
      throw new Error(
        `Could not revalidate per-run bridge rule: ${checked.stderr.trim() || checked.stdout.trim()}`,
      );
    }
  }

  private async stopProcess(identity: ProcessIdentity, recorded: RecordedProcess): Promise<void> {
    if (!this.tryKill(identity.pid, 'SIGTERM')) {
      if (await this.processMatches(identity, recorded)) {
        throw new Error(`process ${identity.pid} still matches after kill reported ESRCH`);
      }
      return;
    }
    const deadline = Date.now() + PROCESS_STOP_WAIT_MS;
    while (Date.now() < deadline) {
      if (!(await this.processMatches(identity, recorded))) return;
      await this.dependencies.sleep(PROCESS_STOP_INTERVAL_MS);
    }
    if (!(await this.processMatches(identity, recorded))) return;
    if (!this.tryKill(identity.pid, 'SIGKILL')) {
      if (await this.processMatches(identity, recorded)) {
        throw new Error(`process ${identity.pid} still matches after kill reported ESRCH`);
      }
      return;
    }
    for (let attempt = 0; attempt < PROCESS_STOP_WAIT_MS / PROCESS_STOP_INTERVAL_MS; attempt += 1) {
      if (!(await this.processMatches(identity, recorded))) return;
      await this.dependencies.sleep(PROCESS_STOP_INTERVAL_MS);
    }
    throw new Error(`identity-validated process ${identity.pid} did not exit`);
  }

  private tryKill(pid: number, signal: NodeJS.Signals): boolean {
    try {
      this.dependencies.kill(pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  }

  private async unmountVirtiofsdResources(
    record: CleanupRecord,
    umountPath: string,
  ): Promise<void> {
    for (const expected of [...record.mounts].sort(
      (left, right) => right.mountPoint.length - left.mountPoint.length,
    )) {
      const current = (await this.readMounts()).find(
        (mount) => mount.mountPoint === expected.mountPoint,
      );
      if (!current) continue;
      if (!sameMountIdentity(current, expected)) {
        throw new Error(`mount identity changed: ${expected.mountPoint}`);
      }
      await this.runChecked(umountPath, [expected.mountPoint]);
    }
  }

  private async readMounts(): Promise<MountIdentity[]> {
    const text = await this.dependencies.readFile('/proc/self/mountinfo', 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map(parseMountInfoLine);
  }

  private async assertNoMountsUnder(directory: string): Promise<void> {
    const remaining = (await this.readMounts()).filter((mount) =>
      mount.mountPoint === directory || mount.mountPoint.startsWith(`${directory}${path.sep}`),
    );
    if (remaining.length > 0) {
      throw new Error(
        `refusing recursive removal while mounts remain under ${directory}: ` +
        remaining.map((mount) => mount.mountPoint).join(', '),
      );
    }
  }

  private async validateFileIfPresent(
    filePath: string,
    expected: FileIdentity | undefined,
    label: string,
  ): Promise<void> {
    if (!(await pathExists(filePath, this.dependencies.lstat))) return;
    if (!expected) throw new Error(`${label} exists but its immutable identity was never committed`);
    const current = await this.captureFileIdentity(filePath);
    if (!sameFileIdentity(current, expected)) throw new Error(`${label} identity changed`);
  }

  private async validateInterfaceIfPresent(
    ipPath: string,
    name: string,
    expected: InterfaceIdentity | undefined,
    namespace: string | undefined,
  ): Promise<void> {
    const current = await this.tryCaptureInterfaceIdentity(ipPath, name, namespace);
    if (!current) return;
    if (!expected) throw new Error(`interface "${name}" exists but its identity was never committed`);
    if (current.ifindex !== expected.ifindex || current.namespace !== expected.namespace) {
      throw new Error(`interface "${name}" identity changed`);
    }
  }

  private async captureProcessIdentity(pid: number): Promise<ProcessIdentity> {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Unsafe process id: ${pid}`);
    const statText = await this.dependencies.readFile(`/proc/${pid}/stat`, 'utf8');
    const closingParen = statText.lastIndexOf(')');
    if (closingParen < 0) throw new Error(`Malformed /proc/${pid}/stat`);
    const fields = statText.slice(closingParen + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime) throw new Error(`Missing process start time for PID ${pid}`);
    const status = await this.dependencies.readFile(`/proc/${pid}/status`, 'utf8');
    const uid = parseStatusIdentity(status, 'Uid');
    const gid = parseStatusIdentity(status, 'Gid');
    const executableLink = `/proc/${pid}/exe`;
    const executable = (await this.dependencies.readlink(executableLink))
      .replace(/ \(deleted\)$/, '');
    return {
      pid,
      startTime,
      executable,
      executableIdentity: await this.captureFollowedFileIdentity(executableLink),
      uid,
      gid,
      networkNamespace: await this.dependencies.readlink(`/proc/${pid}/ns/net`),
    };
  }

  private async processMatches(
    expected: ProcessIdentity,
    recorded?: RecordedProcess,
  ): Promise<boolean> {
    try {
      const current = await this.captureProcessIdentity(expected.pid);
      if (
        current.startTime !== expected.startTime ||
        current.executable !== expected.executable ||
        !sameFileIdentity(current.executableIdentity, expected.executableIdentity) ||
        current.uid !== expected.uid ||
        current.gid !== expected.gid ||
        current.networkNamespace !== expected.networkNamespace
      ) return false;
      if (recorded) {
        const cmdline = await this.dependencies.readFile(`/proc/${expected.pid}/cmdline`, 'utf8');
        if (
          !cmdline.includes(recorded.socketPath) ||
          (recorded.sourcePath !== undefined && !cmdline.includes(recorded.sourcePath))
        ) return false;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async captureFileIdentity(filePath: string): Promise<FileIdentity> {
    const value = await this.dependencies.lstat(filePath, { bigint: true });
    return { device: value.dev.toString(), inode: value.ino.toString() };
  }

  private async captureFollowedFileIdentity(filePath: string): Promise<FileIdentity> {
    const value = await this.dependencies.stat(filePath, { bigint: true });
    return { device: value.dev.toString(), inode: value.ino.toString() };
  }

  private async captureInterfaceIdentity(
    ipPath: string,
    name: string,
    namespace?: string,
  ): Promise<InterfaceIdentity> {
    const identity = await this.tryCaptureInterfaceIdentity(ipPath, name, namespace);
    if (!identity) throw new Error(`Could not capture interface identity for "${name}"`);
    return identity;
  }

  private async tryCaptureInterfaceIdentity(
    ipPath: string,
    name: string,
    namespace?: string,
  ): Promise<InterfaceIdentity | undefined> {
    const args = namespace
      ? ['netns', 'exec', namespace, ipPath, '-json', 'link', 'show', 'dev', name]
      : ['-json', 'link', 'show', 'dev', name];
    const result = await this.dependencies.run(ipPath, args);
    if (result.exitCode !== 0) {
      if (/does not exist|cannot find device/i.test(result.stderr)) return undefined;
      throw new Error(`${ipPath} ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error(`Unexpected interface inspection for "${name}"`);
    }
    const item = parsed[0] as { ifindex?: unknown; ifname?: unknown };
    if (item.ifname !== name || !Number.isSafeInteger(item.ifindex)) {
      throw new Error(`Invalid interface inspection for "${name}"`);
    }
    return { name, ...(namespace ? { namespace } : {}), ifindex: item.ifindex as number };
  }

  private async interfaceExists(ipPath: string, name: string): Promise<boolean> {
    return (await this.tryCaptureInterfaceIdentity(ipPath, name)) !== undefined;
  }

  private async readRecord(recordPath: string): Promise<CleanupRecord> {
    const fileStat = await this.dependencies.lstat(recordPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.uid !== 0 ||
        (fileStat.mode & 0o777) !== 0o600) {
      throw new Error('cleanup record is not a root-owned mode-0600 regular file');
    }
    const parsed = JSON.parse(await this.dependencies.readFile(recordPath, 'utf8')) as CleanupRecord;
    validateRecord(parsed, recordPath, this.dependencies.rootDirectory);
    return parsed;
  }

  private async writeRecord(
    recordPath: string,
    record: CleanupRecord,
    exclusive: boolean,
  ): Promise<void> {
    const temporaryPath = `${recordPath}.tmp-${this.dependencies.processId}-${randomBytes(6).toString('hex')}`;
    const handle = await this.dependencies.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (exclusive) {
        try {
          await this.dependencies.link(temporaryPath, recordPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Cleanup record already exists for run "${record.runId}"`);
          }
          throw error;
        }
        await this.dependencies.unlink(temporaryPath);
      } else {
        await this.dependencies.rename(temporaryPath, recordPath);
      }
      const directory = await this.dependencies.open(this.dependencies.rootDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await this.dependencies.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async ensureRegistryDirectory(): Promise<void> {
    if (this.dependencies.effectiveUid !== 0) {
      throw new Error('Cloud Hypervisor cleanup registry requires effective uid 0');
    }
    await this.dependencies.mkdir(this.dependencies.rootDirectory, { recursive: true, mode: 0o700 });
    const value = await this.dependencies.lstat(this.dependencies.rootDirectory);
    if (
      !value.isDirectory() ||
      value.isSymbolicLink() ||
      value.uid !== 0 ||
      (value.mode & 0o777) !== 0o700
    ) {
      throw new Error(
        `Cloud Hypervisor cleanup registry has unsafe ownership or mode: ${this.dependencies.rootDirectory}`,
      );
    }
  }

  private async claim(recordPath: string): Promise<(() => Promise<void>) | undefined> {
    const lockPath = `${recordPath}.lock`;
    const owner = await this.captureProcessIdentity(this.dependencies.processId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.hasActiveRenamedClaim(recordPath)) return undefined;
      const temporaryPath = `${lockPath}.tmp-${this.dependencies.processId}-${randomBytes(6).toString('hex')}`;
      const handle = await this.dependencies.open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      let acquired = false;
      try {
        await this.dependencies.link(temporaryPath, lockPath);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        await this.dependencies.unlink(temporaryPath).catch(() => undefined);
      }
      if (acquired) {
        if (await this.hasActiveRenamedClaim(recordPath)) {
          await this.dependencies.unlink(lockPath).catch(() => undefined);
          return undefined;
        }
        return async () => {
          await this.dependencies.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        };
      }
      const before = await this.dependencies.lstat(lockPath, { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (!before) continue;
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.uid !== 0n ||
        (before.mode & 0o777n) !== 0o600n
      ) throw new Error(`cleanup claim has unsafe ownership or mode: ${lockPath}`);
      let existing: ProcessIdentity;
      try {
        existing = JSON.parse(await this.dependencies.readFile(lockPath, 'utf8')) as ProcessIdentity;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(`cleanup claim is unreadable; refusing to replace it: ${formatError(error)}`);
      }
      validateProcessIdentity(existing, 'cleanup claim owner');
      if (await this.processMatches(existing)) return undefined;
      const claimedPath = `${lockPath}-claimed-owner`;
      const claimedTemporaryPath = `${claimedPath}.tmp-${this.dependencies.processId}-${randomBytes(6).toString('hex')}`;
      const claimedHandle = await this.dependencies.open(claimedTemporaryPath, 'wx', 0o600);
      try {
        await claimedHandle.writeFile(`${JSON.stringify(owner)}\n`);
        await claimedHandle.sync();
      } finally {
        await claimedHandle.close();
      }
      try {
        await this.dependencies.link(claimedTemporaryPath, claimedPath);
      } catch (error) {
        await this.dependencies.unlink(claimedTemporaryPath).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
        throw error;
      }
      await this.dependencies.unlink(claimedTemporaryPath);
      const current = await this.dependencies.lstat(lockPath, { bigint: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (current && (before.dev !== current.dev || before.ino !== current.ino)) {
        await this.dependencies.unlink(claimedPath);
        return undefined;
      }
      if (current) await this.dependencies.unlink(lockPath);
      return async () => {
        await this.dependencies.unlink(claimedPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    }
    throw new Error(`could not atomically claim stale cleanup record: ${recordPath}`);
  }

  private async hasActiveRenamedClaim(recordPath: string): Promise<boolean> {
    const prefix = `${path.basename(recordPath)}.lock-claimed-`;
    for (const name of await this.dependencies.readdir(this.dependencies.rootDirectory)) {
      if (!name.startsWith(prefix)) continue;
      const claimPath = path.join(this.dependencies.rootDirectory, name);
      let owner: ProcessIdentity;
      try {
        owner = JSON.parse(await this.dependencies.readFile(claimPath, 'utf8')) as ProcessIdentity;
      } catch (error) {
        throw new Error(`cleanup claim is unreadable; refusing to replace it: ${formatError(error)}`);
      }
      validateProcessIdentity(owner, 'renamed cleanup claim owner');
      if (await this.processMatches(owner)) return true;
      await this.dependencies.unlink(claimPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return false;
  }

  private async runChecked(command: string, args: readonly string[]): Promise<void> {
    const result = await this.dependencies.run(command, args);
    if (result.exitCode !== 0) {
      throw new Error(
        `${command} ${args.join(' ')} failed with code ${result.exitCode}: ` +
        `${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // `command` is the absolute `ip` path returned by the root-only preflight.
  // eslint-disable-next-line local/no-unsafe-execa
  const result = await execa(command, [...args], {
    reject: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    extendEnv: false,
    timeout: 10_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function removeExactDirectory(
  directory: string,
  expected: FileIdentity | undefined,
  dependencies: ResolvedDependencies,
  recursive: boolean,
): Promise<void> {
  if (!(await pathExists(directory, dependencies.lstat))) return;
  if (!expected) throw new Error(`${directory} exists without a committed identity`);
  const current = await dependencies.lstat(directory, { bigint: true });
  if (
    current.dev.toString() !== expected.device ||
    current.ino.toString() !== expected.inode
  ) throw new Error(`${directory} identity changed`);
  if (recursive) {
    await dependencies.rm(directory, { recursive: true, force: false });
  } else {
    const deadline = Date.now() + CGROUP_REMOVAL_WAIT_MS;
    for (;;) {
      try {
        await dependencies.rmdir(directory);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          (code !== 'EBUSY' && code !== 'ENOTEMPTY') ||
          Date.now() >= deadline
        ) throw error;
        const retryIdentity = await dependencies.lstat(directory, { bigint: true });
        if (
          retryIdentity.dev.toString() !== expected.device ||
          retryIdentity.ino.toString() !== expected.inode
        ) throw new Error(`${directory} identity changed during cgroup drain`);
        await dependencies.sleep(CGROUP_REMOVAL_INTERVAL_MS);
      }
    }
  }
}

function validateRecord(
  record: CleanupRecord,
  recordPath: string,
  registryRoot: string,
): void {
  if (
    record?.version !== RECORD_VERSION ||
    !record.runId ||
    !/^[A-Za-z0-9_.-]+$/.test(record.runId) ||
    path.join(registryRoot, `${record.runId}.json`) !== recordPath
  ) throw new Error('invalid cleanup record identity');
  if (
    !record.paths?.runDirectory.endsWith(`/${record.runId}`) ||
    !record.paths?.cgroupPath.endsWith(`/${record.runId}`) ||
    !record.paths?.virtiofsdShareDirectory.endsWith(`/${record.runId}`) ||
    record.network?.netnsPath !== `/var/run/netns/${record.network.namespaceName}`
    || !/^awf-microvm-[0-9a-f]{12}$/.test(record.network.hostForwardRuleComment)
    || !/^[A-Za-z0-9_.-]{1,15}$/.test(record.network.infrastructureBridge)
  ) throw new Error('cleanup record paths are not run-scoped');
  validateProcessIdentity(record.owner, 'cleanup record owner');
  if (
    typeof record.processes !== 'object' ||
    record.processes === null ||
    Array.isArray(record.processes) ||
    !Array.isArray(record.mounts)
  ) throw new Error('cleanup record resource identities are malformed');
  for (const [key, processRecord] of Object.entries(record.processes)) {
    assertSafeProcessKey(key);
    if (
      (processRecord.state !== 'pending' && processRecord.state !== 'live') ||
      !path.isAbsolute(processRecord.executable) ||
      !path.isAbsolute(processRecord.socketPath) ||
      (processRecord.sourcePath !== undefined && !path.isAbsolute(processRecord.sourcePath)) ||
      (processRecord.state === 'live' && processRecord.identity === undefined)
    ) throw new Error(`cleanup process record is malformed: ${key}`);
    if (processRecord.identity) validateProcessIdentity(processRecord.identity, `process "${key}"`);
  }
  for (const mount of record.mounts) {
    if (
      !Number.isSafeInteger(mount.mountId) ||
      mount.mountId <= 0 ||
      !mount.device ||
      !path.isAbsolute(mount.mountPoint) ||
      (
        mount.mountPoint !== record.paths.virtiofsdShareDirectory &&
        !mount.mountPoint.startsWith(`${record.paths.virtiofsdShareDirectory}${path.sep}`)
      ) ||
      !mount.filesystemType ||
      !mount.source
    ) throw new Error('cleanup mount identity is malformed');
  }
}

function assertSafeRecordPaths(
  paths: CloudHypervisorRunPaths,
  plan: MicrovmNetworkPlan,
): void {
  if (
    plan.runId !== paths.runId ||
    !paths.runDirectory.startsWith(`${paths.runBaseDir}${path.sep}`) ||
    !paths.runDirectory.endsWith(`${path.sep}${paths.runId}`) ||
    !paths.cgroupPath.endsWith(`${path.sep}${paths.runId}`)
  ) throw new Error('Cloud Hypervisor cleanup resources are not scoped to one run');
}

function assertSafeProcessKey(key: string): void {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(key) ||
    key === '__proto__' ||
    key === 'constructor' ||
    key === 'prototype'
  ) throw new Error(`Unsafe cleanup process key: ${key}`);
}

function parseStatusIdentity(status: string, name: 'Uid' | 'Gid'): number {
  const line = status.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}:`));
  const identities = line?.slice(name.length + 1).trim().split(/\s+/);
  if (
    identities?.length !== 4 ||
    !identities.every((value) => /^\d+$/.test(value) && value === identities[0])
  ) {
    throw new Error(`Process ${name} identities are not stable`);
  }

  return Number(identities[0]);
}

function validateProcessIdentity(identity: ProcessIdentity, label: string): void {
  if (
    !identity ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 1 ||
    !/^\d+$/.test(identity.startTime) ||
    !path.isAbsolute(identity.executable) ||
    !/^\d+$/.test(identity.executableIdentity?.device) ||
    !/^\d+$/.test(identity.executableIdentity?.inode) ||
    !Number.isSafeInteger(identity.uid) ||
    identity.uid < 0 ||
    !Number.isSafeInteger(identity.gid) ||
    identity.gid < 0 ||
    !/^net:\[\d+\]$/.test(identity.networkNamespace)
  ) throw new Error(`${label} identity is malformed`);
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameMountIdentity(left: MountIdentity, right: MountIdentity): boolean {
  return left.mountId === right.mountId &&
    left.device === right.device &&
    left.root === right.root &&
    left.mountPoint === right.mountPoint &&
    left.filesystemType === right.filesystemType &&
    left.source === right.source;
}

function parseMountInfoLine(line: string): MountIdentity {
  const fields = line.split(' ');
  const separator = fields.indexOf('-');
  const mountId = Number(fields[0]);
  if (
    separator < 6 ||
    !Number.isSafeInteger(mountId) ||
    !fields[2] ||
    !fields[3] ||
    !fields[4] ||
    !fields[separator + 1] ||
    !fields[separator + 2]
  ) throw new Error('Malformed /proc/self/mountinfo entry');
  return {
    mountId,
    device: fields[2],
    root: decodeMountInfoPath(fields[3]),
    mountPoint: decodeMountInfoPath(fields[4]),
    filesystemType: fields[separator + 1],
    source: decodeMountInfoPath(fields[separator + 2]),
  };
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

async function pathExists(
  filePath: string,
  lstat: typeof fs.lstat,
): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bridgeForwardRule(
  operation: '-C' | '-D',
  bridge: string,
  comment: string,
): string[] {
  return [
    '-t', 'filter', operation, 'DOCKER-USER',
    '-i', bridge, '-o', bridge,
    '-m', 'comment', '--comment', comment,
    '-j', 'ACCEPT',
  ];
}
