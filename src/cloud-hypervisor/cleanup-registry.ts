import { randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import type { MicrovmNetworkPlan } from '../microvm/network';
import type { CloudHypervisorRunPaths } from './manager-types';
import type { CloudHypervisorVmmIdentityToolPaths } from './vmm-identity';
import { createCleanupHandle } from './cleanup-handle';
import {
  assertSafeRecordPaths,
  validateProcessIdentity,
  validateRecord,
  CLEANUP_RECORD_VERSION,
  sameFileIdentity,
  sameMountIdentity,
  type CleanupRecord,
  type FileIdentity,
  type InterfaceIdentity,
  type MountIdentity,
  type ProcessIdentity,
  type RecordedProcess,
} from './cleanup-identity';
import {
  bridgeForwardRule,
  captureFileIdentity,
  captureInterfaceIdentity,
  captureProcessIdentity,
  interfaceExists,
  processMatches,
  readMounts,
  tryCaptureInterfaceIdentity,
  tryKill,
} from './cleanup-process';

const CLEANUP_DIRECTORY_NAME = 'pending-cleanup';
const PROCESS_STOP_WAIT_MS = 2_000;
const PROCESS_STOP_INTERVAL_MS = 50;
const CGROUP_REMOVAL_WAIT_MS = 5_000;
const CGROUP_REMOVAL_INTERVAL_MS = 100;

export type CloudHypervisorNetworkResource =
  'netns' | 'hostVeth' | 'namespaceVeth' | 'tap';

export interface CloudHypervisorCleanupHandle {
  captureNetworkPlan(plan: MicrovmNetworkPlan): Promise<void>;
  captureArtifactSnapshot(directory: string): Promise<void>;
  prepareVmmAccount(name: string): Promise<void>;
  captureVmmIdentity(identity: import('./vmm-identity').CloudHypervisorVmmIdentity): Promise<void>;
  prepareVmmAcl(path: string): Promise<void>;
  releaseVmmAcl(path: string): Promise<void>;
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
  reapPending(
    ipPath: string,
    umountPath: string,
    vmmTools?: CloudHypervisorVmmIdentityToolPaths,
  ): Promise<void>;
  createPending(
    paths: CloudHypervisorRunPaths,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle>;
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

  async reapPending(
    ipPath: string,
    umountPath: string,
    vmmTools?: CloudHypervisorVmmIdentityToolPaths,
  ): Promise<void> {
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
          await this.reapRecord(recordPath, record, ipPath, umountPath, vmmTools);
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
    return this.createRecord(paths, plan, cloudHypervisorBinary, ipPath);
  }

  async createPending(
    paths: CloudHypervisorRunPaths,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle> {
    return this.createRecord(paths, undefined, cloudHypervisorBinary, ipPath);
  }

  private async createRecord(
    paths: CloudHypervisorRunPaths,
    plan: MicrovmNetworkPlan | undefined,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle> {
    await this.ensureRegistryDirectory();
    assertSafeRecordPaths(paths, plan);
    const recordPath = path.join(this.dependencies.rootDirectory, `${paths.runId}.json`);
    const owner = await this.captureProcessIdentity(this.dependencies.processId);
    const binary = await this.dependencies.realpath(cloudHypervisorBinary);
    const record: CleanupRecord = {
      version: CLEANUP_RECORD_VERSION,
      runId: paths.runId,
      owner,
      cloudHypervisorBinary: binary,
      paths: {
        runDirectory: paths.runDirectory,
        cgroupPath: paths.cgroupPath,
        virtiofsdShareDirectory: paths.virtiofsdShareDirectory,
      },
      ...(plan ? { network: {
        namespaceName: plan.namespaceName,
        netnsPath: plan.netnsPath,
        hostVethName: plan.hostVethName,
        namespaceVethName: plan.namespaceVethName,
        tapName: plan.tapName,
        infrastructureBridge: plan.infrastructureBridge,
        hostForwardRuleComment: plan.hostForwardRuleComment,
      } } : {}),
      identities: {},
      processes: {},
      mounts: [],
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecord(recordPath, record, true);
    return createCleanupHandle({
      recordPath,
      record,
      ipPath,
      persist: () => this.writeRecord(recordPath, record, false),
      unlink: this.dependencies.unlink,
      realpath: this.dependencies.realpath,
      sleep: this.dependencies.sleep,
      pathExists: (filePath) => pathExists(filePath, this.dependencies.lstat),
      captureFileIdentity: (filePath) => this.captureFileIdentity(filePath),
      captureInterfaceIdentity: (commandPath, name, namespace) =>
        this.captureInterfaceIdentity(commandPath, name, namespace),
      captureProcessIdentity: (pid) => this.captureProcessIdentity(pid),
      readMounts: () => this.readMounts(),
    });
  }

  private async reapRecord(
    recordPath: string,
    record: CleanupRecord,
    ipPath: string,
    umountPath: string,
    vmmTools?: CloudHypervisorVmmIdentityToolPaths,
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
    if (record.network) await this.deleteNetwork(record, ipPath);
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
    if (record.paths.artifactSnapshotDirectory) {
      await this.assertNoMountsUnder(record.paths.artifactSnapshotDirectory);
      await removeExactDirectory(
        record.paths.artifactSnapshotDirectory,
        record.identities.artifactSnapshotDirectory,
        this.dependencies,
        true,
      );
    }
    await this.deleteVmmIdentity(record, vmmTools);
    await this.dependencies.unlink(recordPath);
  }

  private async validateRecordResources(record: CleanupRecord, ipPath: string): Promise<void> {
    const network = record.network;
    const netnsExists = network ? await pathExists(network.netnsPath, this.dependencies.lstat) : false;
    if (network) {
      await this.validateFileIfPresent(network.netnsPath, record.identities.netns, 'netns');
    }
    await this.validateFileIfPresent(
      record.paths.runDirectory, record.identities.runDirectory, 'run directory',
    );
    await this.validateFileIfPresent(record.paths.cgroupPath, record.identities.cgroup, 'cgroup');
    await this.validateFileIfPresent(
      record.paths.virtiofsdShareDirectory,
      record.identities.virtiofsdShareDirectory,
      'virtiofsd share directory',
    );
    if (record.paths.artifactSnapshotDirectory) {
      await this.validateFileIfPresent(
        record.paths.artifactSnapshotDirectory,
        record.identities.artifactSnapshotDirectory,
        'artifact snapshot directory',
      );
    }
    if (network) {
      await this.validateInterfaceIfPresent(
        ipPath, network.hostVethName, record.identities.hostVeth, undefined,
      );
    }
    if (network && netnsExists) {
      await this.validateInterfaceIfPresent(
        ipPath,
        network.namespaceVethName,
        record.identities.namespaceVeth,
        network.namespaceName,
      );
      await this.validateInterfaceIfPresent(
        ipPath, network.tapName, record.identities.tap, network.namespaceName,
      );
    }
  }

  private async deleteNetwork(record: CleanupRecord, ipPath: string): Promise<void> {
    const network = requireNetwork(record);
    if (await this.interfaceExists(ipPath, network.hostVethName)) {
      await this.validateInterfaceIfPresent(
        ipPath,
        network.hostVethName,
        record.identities.hostVeth,
        undefined,
      );
      await this.runChecked(ipPath, ['link', 'delete', network.hostVethName]);
    }
    if (await pathExists(network.netnsPath, this.dependencies.lstat)) {
      await this.validateFileIfPresent(
        network.netnsPath,
        record.identities.netns,
        'netns',
      );
      await this.runChecked(ipPath, ['netns', 'delete', network.namespaceName]);
    }
    const rule = bridgeForwardRule(
      '-C',
      network.infrastructureBridge,
      network.hostForwardRuleComment,
    );
    const checked = await this.dependencies.run('iptables', rule);
    if (checked.exitCode === 0) {
      await this.runChecked('iptables', bridgeForwardRule(
        '-D',
        network.infrastructureBridge,
        network.hostForwardRuleComment,
      ));
    } else if (checked.exitCode !== 1) {
      throw new Error(
        `Could not revalidate per-run bridge rule: ${checked.stderr.trim() || checked.stdout.trim()}`,
      );
    }
  }

  private async deleteVmmIdentity(
    record: CleanupRecord,
    tools: CloudHypervisorVmmIdentityToolPaths | undefined,
  ): Promise<void> {
    const identity = record.vmmIdentity;
    if (!identity) return;
    if (!tools) throw new Error('VMM cleanup tools are unavailable for a recorded account');
    if (identity.aclPaths.length > 0 && identity.state !== 'live') {
      throw new Error(`VMM ACL intent lacks a committed numeric identity: ${identity.name}`);
    }
    if (identity.state === 'live') {
      for (const aclPath of [...identity.aclPaths].reverse()) {
        let acl = await this.dependencies.run(tools.getfacl, [
          '--absolute-names', '--numeric', aclPath,
        ]);
        if (acl.exitCode !== 0) {
          throw new Error(`VMM ACL revalidation failed for ${aclPath}: ${acl.stderr.trim()}`);
        }
        if (acl.stdout.split(/\r?\n/).some((line) => line.startsWith(`user:${identity.uid}:`))) {
          await this.runChecked(tools.setfacl, ['--remove', `user:${identity.uid}`, aclPath]);
          acl = await this.dependencies.run(tools.getfacl, ['--absolute-names', '--numeric', aclPath]);
          if (
            acl.exitCode !== 0 ||
            acl.stdout.split(/\r?\n/).some((line) => line.startsWith(`user:${identity.uid}:`))
          ) throw new Error(`VMM ACL removal validation failed for ${aclPath}`);
        }
      }
    }
    let expectedGid = identity.state === 'live' ? identity.gid : undefined;
    const passwd = await this.dependencies.run(tools.getent, ['passwd', identity.name]);
    if (passwd.exitCode === 0) {
      const fields = passwd.stdout.trim().split(':');
      if (
        fields.length !== 7 ||
        fields[0] !== identity.name ||
        fields[4] !== `AWF Cloud Hypervisor ${record.runId}` ||
        fields[5] !== '/nonexistent' ||
        fields[6] !== '/usr/sbin/nologin' ||
        (identity.state === 'live' &&
          (fields[2] !== String(identity.uid) || fields[3] !== String(identity.gid)))
      ) throw new Error(`VMM account identity changed: ${identity.name}`);
      const uid = Number(fields[2]);
      const gid = Number(fields[3]);
      if (
        !Number.isSafeInteger(uid) ||
        uid <= 0 ||
        !Number.isSafeInteger(gid) ||
        gid <= 0
      ) {
        throw new Error(`VMM account uid is invalid: ${identity.name}`);
      }
      expectedGid = gid;
      if (identity.state === 'live') {
        const [currentUid, currentGid, currentGroups] = await Promise.all([
          this.dependencies.run(tools.id, ['-u', identity.name]),
          this.dependencies.run(tools.id, ['-g', identity.name]),
          this.dependencies.run(tools.id, ['-G', identity.name]),
        ]);
        if (
          currentUid.exitCode !== 0 ||
          currentUid.stdout.trim() !== String(identity.uid) ||
          currentGid.exitCode !== 0 ||
          currentGid.stdout.trim() !== String(identity.gid) ||
          currentGroups.exitCode !== 0 ||
          currentGroups.stdout.trim() !== String(identity.gid)
        ) throw new Error(`VMM account runtime identity changed: ${identity.name}`);
      }
      await this.runChecked(tools.userdel, [identity.name]);
      const removed = await this.dependencies.run(tools.id, ['-u', identity.name]);
      if (removed.exitCode !== 1) {
        throw new Error(`VMM account deletion could not be verified: ${identity.name}`);
      }
    } else if (passwd.exitCode !== 2) {
      throw new Error(`Could not revalidate VMM account ${identity.name}: ${passwd.stderr.trim()}`);
    }
    const group = await this.dependencies.run(tools.getent, ['group', identity.name]);
    if (group.exitCode === 0) {
      const fields = group.stdout.trim().split(':');
      if (
        expectedGid === undefined ||
        fields.length !== 4 ||
        fields[0] !== identity.name ||
        fields[2] !== String(expectedGid) ||
        fields[3] !== ''
      ) {
        throw new Error(`VMM group identity changed: ${identity.name}`);
      }
      await this.runChecked(tools.groupdel, [identity.name]);
      const removed = await this.dependencies.run(tools.getent, ['group', identity.name]);
      if (removed.exitCode !== 2) {
        throw new Error(`VMM group deletion could not be verified: ${identity.name}`);
      }
    } else if (group.exitCode !== 2) {
      throw new Error(`Could not revalidate VMM group ${identity.name}: ${group.stderr.trim()}`);
    }
  }

  private async stopProcess(identity: ProcessIdentity, recorded: RecordedProcess): Promise<void> {
    if (!tryKill(this.dependencies.kill, identity.pid, 'SIGTERM')) {
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
    if (!tryKill(this.dependencies.kill, identity.pid, 'SIGKILL')) {
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

  private async unmountVirtiofsdResources(
    record: CleanupRecord,
    umountPath: string,
  ): Promise<void> {
    for (const expected of [...record.mounts].sort(
      (left, right) => right.mountPoint.length - left.mountPoint.length,
    )) {
      const current = (await this.readMounts()).find((mount) => mount.mountPoint === expected.mountPoint);
      if (!current) continue;
      if (!sameMountIdentity(current, expected)) {
        throw new Error(`mount identity changed: ${expected.mountPoint}`);
      }
      await this.runChecked(umountPath, [expected.mountPoint]);
    }
  }

  private async readMounts(): Promise<MountIdentity[]> {
    return readMounts(this.dependencies.readFile);
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
    return captureProcessIdentity(this.dependencies, pid);
  }

  private async processMatches(expected: ProcessIdentity, recorded?: RecordedProcess): Promise<boolean> {
    return processMatches(this.dependencies, expected, recorded);
  }

  private async captureFileIdentity(filePath: string): Promise<FileIdentity> {
    return captureFileIdentity(this.dependencies.lstat, filePath);
  }

  private async captureInterfaceIdentity(
    ipPath: string,
    name: string,
    namespace?: string,
  ): Promise<InterfaceIdentity> {
    return captureInterfaceIdentity(this.dependencies.run, ipPath, name, namespace);
  }

  private async tryCaptureInterfaceIdentity(
    ipPath: string,
    name: string,
    namespace?: string,
  ): Promise<InterfaceIdentity | undefined> {
    return tryCaptureInterfaceIdentity(this.dependencies.run, ipPath, name, namespace);
  }

  private async interfaceExists(ipPath: string, name: string): Promise<boolean> {
    return interfaceExists(this.dependencies.run, ipPath, name);
  }

  private async readRecord(recordPath: string): Promise<CleanupRecord> {
    const fileStat = await this.dependencies.lstat(recordPath);
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      fileStat.uid !== 0 ||
      (fileStat.mode & 0o777) !== 0o600
    ) {
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
      await handle.writeFile(`${JSON.stringify(record, null, 2)}
`);
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
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
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
        await handle.writeFile(`${JSON.stringify(owner)}
`);
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
        await claimedHandle.writeFile(`${JSON.stringify(owner)}
`);
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
    return;
  }
  const deadline = Date.now() + CGROUP_REMOVAL_WAIT_MS;
  for (;;) {
    try {
      await dependencies.rmdir(directory);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'ENOTEMPTY') || Date.now() >= deadline) throw error;
      const retryIdentity = await dependencies.lstat(directory, { bigint: true });
      if (
        retryIdentity.dev.toString() !== expected.device ||
        retryIdentity.ino.toString() !== expected.inode
      ) throw new Error(`${directory} identity changed during cgroup drain`);
      await dependencies.sleep(CGROUP_REMOVAL_INTERVAL_MS);
    }
  }
}

function requireNetwork(record: CleanupRecord): NonNullable<CleanupRecord['network']> {
  if (!record.network) throw new Error('Cleanup network plan is not committed');
  return record.network;
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
