import { promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import type { MicrovmNetworkPlan } from '../microvm/network';
import {
  NVX_CLEANUP_SCHEMA_VERSION,
  type NvxCleanupDeviceAclIdentity,
  type NvxCleanupFileIdentity,
  type NvxCleanupInterfaceIdentity,
  type NvxCleanupProcessIdentity,
  type NvxCleanupRecord,
} from './cleanup-record';
import { NvxCleanupStore, type NvxCleanupStoreDependencies } from './cleanup-store';
import { createNvxRunLayout, type NvxRunLayout } from './run-layout';
import type { NvxVmmIdentity } from './runtime-lifecycle';

export interface NvxCleanupToolPaths {
  readonly getent: string;
  readonly groupdel: string;
  readonly id: string;
  readonly ip: string;
  readonly iptables: string;
  readonly setfacl: string;
  readonly userdel: string;
}

export interface NvxCleanupRegistryDependencies {
  readonly store: NvxCleanupStore;
  readonly pid: number;
  lstat: typeof fs.lstat;
  stat: typeof fs.stat;
  readFile: typeof fs.readFile;
  readlink: typeof fs.readlink;
  rm: typeof fs.rm;
  rmdir: typeof fs.rmdir;
  kill: typeof process.kill;
  sleep(milliseconds: number): Promise<void>;
  run(command: string, args: readonly string[]): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface NvxCleanupHandle {
  readonly record: NvxCleanupRecord;
  captureArtifactSnapshot(directory: string): Promise<void>;
  prepareAccount(name: string): Promise<void>;
  captureIdentity(identity: NvxVmmIdentity): Promise<void>;
  prepareDeviceAcl(identity: NvxCleanupDeviceAclIdentity): Promise<void>;
  releaseDeviceAcl(identity: NvxCleanupDeviceAclIdentity): Promise<void>;
  captureNetworkPlan(plan: MicrovmNetworkPlan): Promise<void>;
  captureNetworkResource(resource: 'netns' | 'hostVeth' | 'namespaceVeth' | 'tap'): Promise<void>;
  captureRunDirectory(): Promise<void>;
  captureCgroup(): Promise<void>;
  captureProcess(kind: 'launcher' | 'openvmm', pid: number): Promise<NvxCleanupProcessIdentity>;
  captureMountNamespace(inode: string): Promise<void>;
  complete(): Promise<void>;
}

export interface NvxCleanupRegistry {
  reapPending(tools: NvxCleanupToolPaths): Promise<void>;
  createPending(runId: string, ipPath?: string): Promise<NvxCleanupHandle>;
}

function defaultDependencies(): NvxCleanupRegistryDependencies {
  const processMatches = async (identity: NvxCleanupProcessIdentity): Promise<boolean> => {
    try {
      const current = await captureProcessIdentity(process.pid === identity.pid
        ? process.pid
        : identity.pid);
      return sameProcess(current, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const storeDependencies: Partial<NvxCleanupStoreDependencies> = { processMatches };
  return {
    store: new NvxCleanupStore(storeDependencies),
    pid: process.pid,
    lstat: fs.lstat,
    stat: fs.stat,
    readFile: fs.readFile,
    readlink: fs.readlink,
    rm: fs.rm,
    rmdir: fs.rmdir,
    kill: process.kill,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    run: async (command, args) => {
      const result = await execa(command, [...args], {
        reject: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        extendEnv: false,
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

export class DurableNvxCleanupRegistry implements NvxCleanupRegistry {
  constructor(
    private readonly dependencies: NvxCleanupRegistryDependencies = defaultDependencies(),
  ) {}

  async createPending(runId: string, ipPath = '/usr/sbin/ip'): Promise<NvxCleanupHandle> {
    const layout = createNvxRunLayout(runId);
    const record: NvxCleanupRecord = {
      schemaVersion: NVX_CLEANUP_SCHEMA_VERSION,
      runId,
      owner: await captureProcessIdentity(this.dependencies.pid, this.dependencies),
      resources: { deviceAcls: [] },
      stages: {
        accountCreated: false,
        artifactSnapshotCreated: false,
        cgroupCreated: false,
        deviceAclsGranted: false,
        networkCreated: false,
        processStarted: false,
        runDirectoryCreated: false,
      },
      updatedAt: new Date().toISOString(),
    };
    await this.dependencies.store.create(record);
    return this.createHandle(layout, record, ipPath);
  }

  async reapPending(tools: NvxCleanupToolPaths): Promise<void> {
    const errors: string[] = [];
    for (const recordPath of await this.dependencies.store.list()) {
      try {
        const record = await this.dependencies.store.read(recordPath);
        if (await this.processMatches(record.owner)) continue;
        const owner = await captureProcessIdentity(this.dependencies.pid, this.dependencies);
        const release = await this.dependencies.store.claim(recordPath, owner);
        if (!release) continue;
        try {
          await this.cleanupRecord(record, tools);
          await this.dependencies.store.remove(record.runId);
        } finally {
          await release();
        }
      } catch (error) {
        errors.push(`${recordPath}: ${formatError(error)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`NVX stale cleanup is incomplete; retained records: ${errors.join('; ')}`);
    }
  }

  private createHandle(
    layout: NvxRunLayout,
    record: NvxCleanupRecord,
    ipPath: string,
  ): NvxCleanupHandle {
    const update = async (): Promise<void> => {
      record.updatedAt = new Date().toISOString();
      await this.dependencies.store.update(record);
    };
    return {
      record,
      captureArtifactSnapshot: async (directory) => {
        if (path.resolve(directory) !== layout.artifactSnapshotDirectory) {
          throw new Error('NVX artifact snapshot is outside the run layout');
        }
        record.resources.artifactSnapshot = await this.captureFile(directory);
        record.stages.artifactSnapshotCreated = true;
        await update();
      },
      prepareAccount: async (name) => {
        if (record.vmmIdentity) throw new Error('NVX cleanup account is already prepared');
        record.vmmIdentity = { state: 'pending', name };
        await update();
      },
      captureIdentity: async (identity) => {
        if (record.vmmIdentity?.state !== 'pending' || record.vmmIdentity.name !== identity.name) {
          throw new Error('NVX cleanup account does not match its pending identity');
        }
        record.vmmIdentity = { state: 'live', ...identity };
        record.stages.accountCreated = true;
        await update();
      },
      prepareDeviceAcl: async (identity) => {
        if (!record.resources.deviceAcls.some(({ path: aclPath }) => aclPath === identity.path)) {
          record.resources.deviceAcls.push(identity);
        }
        record.stages.deviceAclsGranted = record.resources.deviceAcls.length > 0;
        await update();
      },
      releaseDeviceAcl: async (identity) => {
        const index = record.resources.deviceAcls.findIndex(({ path: aclPath }) =>
          aclPath === identity.path);
        if (index >= 0) record.resources.deviceAcls.splice(index, 1);
        record.stages.deviceAclsGranted = record.resources.deviceAcls.length > 0;
        await update();
      },
      captureNetworkPlan: async (plan) => {
        if (plan.runId !== record.runId || plan.namespaceName !== layout.networkNamespace) {
          throw new Error('NVX cleanup network plan is not bound to the run');
        }
        record.network = {
          resourceToken: plan.resourceToken,
          namespaceName: plan.namespaceName,
          netnsPath: plan.netnsPath,
          hostVethName: plan.hostVethName,
          namespaceVethName: plan.namespaceVethName,
          tapName: plan.tapName,
          infrastructureBridge: plan.infrastructureBridge,
          hostForwardRuleComment: plan.hostForwardRuleComment,
        };
        if (plan.reservationPath) {
          record.resources.networkReservation = await this.captureFile(plan.reservationPath);
        }
        await update();
      },
      captureNetworkResource: async (resource) => {
        const network = requireNetwork(record);
        if (resource === 'netns') {
          record.resources.networkNamespace = await this.captureFile(network.netnsPath);
          record.stages.networkCreated = true;
        } else {
          const identity = await this.captureInterface(
            network[resource === 'hostVeth'
              ? 'hostVethName'
              : resource === 'namespaceVeth'
                ? 'namespaceVethName'
                : 'tapName'],
            resource === 'hostVeth' ? undefined : network.namespaceName,
            ipPath,
          );
          record.resources[resource] = identity;
        }
        await update();
      },
      captureRunDirectory: async () => {
        record.resources.runDirectory = await this.captureFile(layout.runDirectory);
        record.stages.runDirectoryCreated = true;
        await update();
      },
      captureCgroup: async () => {
        record.resources.cgroup = await this.captureFile(layout.cgroupPath);
        record.stages.cgroupCreated = true;
        await update();
      },
      captureProcess: async (kind, pid) => {
        const identity = await captureProcessIdentity(pid, this.dependencies);
        record.resources[kind] = identity;
        if (kind === 'launcher') record.stages.processStarted = true;
        await update();
        return identity;
      },
      captureMountNamespace: async (inode) => {
        if (!/^\d+$/.test(inode)) throw new Error('NVX mount namespace inode is invalid');
        record.resources.mountNamespaceInode = inode;
        await update();
      },
      complete: () => this.dependencies.store.remove(record.runId),
    };
  }

  private async cleanupRecord(record: NvxCleanupRecord, tools: NvxCleanupToolPaths): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { errors.push(error); }
    };
    await attempt(() => this.stopRecordedProcesses(record));
    await attempt(() => this.removeNetwork(record, tools.ip, tools.iptables));
    await attempt(() => this.removeExactFile(record.resources.networkReservation));
    await attempt(() => this.removeExactDirectory(record.resources.cgroup, false));
    await attempt(() => this.removeExactDirectory(record.resources.runDirectory, true));
    await attempt(() => this.removeExactDirectory(record.resources.artifactSnapshot, true));
    await attempt(() => this.removeIdentity(record, tools));
    if (errors.length > 0) throw new Error(errors.map(formatError).join('; '));
  }

  private async stopRecordedProcesses(record: NvxCleanupRecord): Promise<void> {
    for (const identity of [record.resources.openvmm, record.resources.launcher]) {
      if (!identity || !(await this.processMatches(identity))) continue;
      this.dependencies.kill(identity.pid, 'SIGTERM');
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const live = await Promise.all(
        [record.resources.openvmm, record.resources.launcher]
          .filter((value): value is NvxCleanupProcessIdentity => value !== undefined)
          .map((identity) => this.processMatches(identity)),
      );
      if (live.every((value) => !value)) return;
      await this.dependencies.sleep(50);
    }
    for (const identity of [record.resources.openvmm, record.resources.launcher]) {
      if (identity && await this.processMatches(identity)) this.dependencies.kill(identity.pid, 'SIGKILL');
    }
    for (const identity of [record.resources.openvmm, record.resources.launcher]) {
      if (identity && await this.processMatches(identity)) {
        throw new Error(`NVX process ${identity.pid} did not terminate`);
      }
    }
  }

  private async removeNetwork(
    record: NvxCleanupRecord,
    ipPath: string,
    iptablesPath: string,
  ): Promise<void> {
    if (!record.network) return;
    const network = record.network;
    const reservation = record.resources.networkReservation;
    const hostVeth = await this.tryCaptureInterface(network.hostVethName, undefined, ipPath);
    const netnsExists = await exists(network.netnsPath, this.dependencies.lstat);
    if (hostVeth || netnsExists) {
      if (!reservation) {
        throw new Error('NVX network exists without a committed reservation identity');
      }
      if (path.basename(reservation.path) !== `${network.resourceToken}.json`) {
        throw new Error('NVX network reservation is not bound to the resource token');
      }
      await this.assertFileIdentity(reservation);
    }
    if (hostVeth) {
      if (record.resources.hostVeth && !sameInterface(hostVeth, record.resources.hostVeth)) {
        throw new Error('NVX host veth identity changed');
      }
    }
    if (netnsExists) {
      if (record.resources.networkNamespace) {
        await this.assertFileIdentity(record.resources.networkNamespace);
      }
      for (const [name, expected] of [
        [network.namespaceVethName, record.resources.namespaceVeth],
        [network.tapName, record.resources.tap],
      ] as const) {
        const current = await this.tryCaptureInterface(name, network.namespaceName, ipPath);
        if (current && expected && !sameInterface(current, expected)) {
          throw new Error(`NVX interface identity changed: ${name}`);
        }
      }
    }
    if (hostVeth) {
      await this.runChecked(ipPath, ['link', 'delete', network.hostVethName]);
    }
    if (netnsExists) {
      await this.runChecked(ipPath, ['netns', 'delete', network.namespaceName]);
    }
    const check = bridgeForwardRule(
      '-C', network.infrastructureBridge, network.hostForwardRuleComment,
    );
    const checked = await this.dependencies.run(iptablesPath, check);
    if (checked.exitCode === 0) {
      await this.runChecked(iptablesPath, bridgeForwardRule(
        '-D', network.infrastructureBridge, network.hostForwardRuleComment,
      ));
    } else if (checked.exitCode !== 1) {
      throw new Error(`Could not revalidate NVX bridge rule: ${checked.stderr || checked.stdout}`);
    }
  }

  private async removeIdentity(record: NvxCleanupRecord, tools: NvxCleanupToolPaths): Promise<void> {
    const identity = record.vmmIdentity;
    if (!identity) return;
    if (identity.state === 'live' && identity.uid !== undefined && identity.gid !== undefined) {
      for (const acl of record.resources.deviceAcls) {
        const current = await this.captureFile(acl.path);
        if (current.device !== acl.device || current.inode !== acl.inode || acl.uid !== identity.uid) {
          throw new Error(`NVX device identity changed for ${acl.path}`);
        }
        await this.runChecked(tools.setfacl, ['--remove', `user:${identity.uid}`, acl.path]);
      }
    }

    const passwd = await this.dependencies.run(tools.getent, ['passwd', identity.name]);
    const group = await this.dependencies.run(tools.getent, ['group', identity.name]);
    const expected = identity.state === 'live'
      ? { uid: identity.uid!, gid: identity.gid! }
      : undefined;
    let observed: { uid: number; gid: number } | undefined;
    if (passwd.exitCode === 0) {
      observed = validatePendingAccountPasswd(passwd.stdout, identity.name, record.runId);
      if (
        expected &&
        (observed.uid !== expected.uid || observed.gid !== expected.gid)
      ) {
        throw new Error(`Refusing to remove reused NVX account ${identity.name}`);
      }
      const groups = await this.dependencies.run(tools.id, ['-G', identity.name]);
      if (
        groups.exitCode !== 0 ||
        groups.stdout.trim() !== String(observed.gid)
      ) {
        throw new Error(`NVX account ${identity.name} has unexpected supplementary groups`);
      }
    } else if (passwd.stderr.trim()) {
      throw new Error(`Could not validate NVX account ${identity.name}: ${passwd.stderr}`);
    }
    if (group.exitCode === 0) {
      validatePendingAccountGroup(
        group.stdout,
        identity.name,
        expected?.gid ?? observed?.gid,
      );
    } else if (group.stderr.trim()) {
      throw new Error(`Could not validate NVX group ${identity.name}: ${group.stderr}`);
    }
    if (passwd.exitCode === 0) {
      await this.runChecked(tools.userdel, [identity.name]);
    }
    if (group.exitCode === 0) {
      const remainingGroup = await this.dependencies.run(tools.getent, [
        'group', identity.name,
      ]);
      if (remainingGroup.exitCode === 0) {
        validatePendingAccountGroup(
          remainingGroup.stdout,
          identity.name,
          expected?.gid ?? observed?.gid,
        );
        await this.runChecked(tools.groupdel, [identity.name]);
      } else if (remainingGroup.stderr.trim()) {
        throw new Error(
          `Could not revalidate NVX group ${identity.name}: ${remainingGroup.stderr}`,
        );
      }
    }
  }

  private async removeExactDirectory(
    expected: NvxCleanupFileIdentity | undefined,
    recursive: boolean,
  ): Promise<void> {
    if (!expected || !(await exists(expected.path, this.dependencies.lstat))) return;
    await this.assertFileIdentity(expected);
    if (recursive) {
      await this.dependencies.rm(expected.path, { recursive: true, force: false });
    } else {
      await this.dependencies.rmdir(expected.path);
    }
  }

  private async removeExactFile(expected: NvxCleanupFileIdentity | undefined): Promise<void> {
    if (!expected || !(await exists(expected.path, this.dependencies.lstat))) return;
    await this.assertFileIdentity(expected);
    await this.dependencies.rm(expected.path, { force: false });
  }

  private async assertFileIdentity(expected: NvxCleanupFileIdentity | undefined): Promise<void> {
    if (!expected) throw new Error('NVX resource exists without a committed identity');
    const current = await this.captureFile(expected.path);
    if (current.device !== expected.device || current.inode !== expected.inode) {
      throw new Error(`NVX resource identity changed: ${expected.path}`);
    }
  }

  private async captureFile(filePath: string): Promise<NvxCleanupFileIdentity> {
    const stat = await this.dependencies.lstat(filePath, { bigint: true });
    return { path: filePath, device: stat.dev.toString(), inode: stat.ino.toString() };
  }

  private async captureInterface(
    name: string,
    namespace?: string,
    ipPath = '/usr/sbin/ip',
  ): Promise<NvxCleanupInterfaceIdentity> {
    const value = await this.tryCaptureInterface(name, namespace, ipPath);
    if (!value) throw new Error(`Could not capture NVX interface ${name}`);
    return value;
  }

  private async tryCaptureInterface(
    name: string,
    namespace?: string,
    ipPath = '/usr/sbin/ip',
  ): Promise<NvxCleanupInterfaceIdentity | undefined> {
    const args = namespace
      ? ['netns', 'exec', namespace, ipPath, '-json', 'link', 'show', 'dev', name]
      : ['-json', 'link', 'show', 'dev', name];
    const result = await this.dependencies.run(ipPath, args);
    if (result.exitCode !== 0) return undefined;
    const parsed = JSON.parse(result.stdout) as Array<{ ifname?: string; ifindex?: number }>;
    if (parsed.length !== 1 || parsed[0].ifname !== name || !Number.isSafeInteger(parsed[0].ifindex)) {
      throw new Error(`Invalid NVX interface identity for ${name}`);
    }
    return { name, ...(namespace ? { namespace } : {}), ifindex: parsed[0].ifindex as number };
  }

  private async processMatches(expected: NvxCleanupProcessIdentity): Promise<boolean> {
    try {
      return sameProcess(await captureProcessIdentity(expected.pid, this.dependencies), expected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async runChecked(command: string, args: readonly string[]): Promise<void> {
    const result = await this.dependencies.run(command, args);
    if (result.exitCode !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
  }
}

async function captureProcessIdentity(
  pid: number,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'readFile' | 'readlink' | 'stat'> = {
    readFile: fs.readFile,
    readlink: fs.readlink,
    stat: fs.stat,
  },
): Promise<NvxCleanupProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Unsafe NVX process id: ${pid}`);
  const statText = await dependencies.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = statText.slice(statText.lastIndexOf(')') + 2).trim().split(/\s+/);
  const status = await dependencies.readFile(`/proc/${pid}/status`, 'utf8');
  const executableLink = `/proc/${pid}/exe`;
  const executableStat = await dependencies.stat(executableLink, { bigint: true });
  return {
    pid,
    startTimeTicks: fields[19],
    executable: (await dependencies.readlink(executableLink)).replace(/ \(deleted\)$/, ''),
    executableDevice: executableStat.dev.toString(),
    executableInode: executableStat.ino.toString(),
    uid: parseStatusIdentity(status, 'Uid'),
    gid: parseStatusIdentity(status, 'Gid'),
    networkNamespace: await dependencies.readlink(`/proc/${pid}/ns/net`),
  };
}

function parseStatusIdentity(status: string, field: 'Uid' | 'Gid'): number {
  const values = status.split(/\r?\n/)
    .find((line) => line.startsWith(`${field}:`))
    ?.slice(field.length + 1).trim().split(/\s+/);
  if (!values || values.length !== 4 || values.some((value) => value !== values[0])) {
    throw new Error(`NVX process ${field} identities are unstable`);
  }
  return Number(values[0]);
}

function sameProcess(
  left: NvxCleanupProcessIdentity,
  right: NvxCleanupProcessIdentity,
): boolean {
  return left.pid === right.pid &&
    left.startTimeTicks === right.startTimeTicks &&
    left.executable === right.executable &&
    left.executableDevice === right.executableDevice &&
    left.executableInode === right.executableInode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.networkNamespace === right.networkNamespace;
}

function sameInterface(
  current: NvxCleanupInterfaceIdentity,
  expected: NvxCleanupInterfaceIdentity | undefined,
): boolean {
  return expected !== undefined &&
    current.name === expected.name &&
    current.namespace === expected.namespace &&
    current.ifindex === expected.ifindex;
}

function requireNetwork(record: NvxCleanupRecord): NonNullable<NvxCleanupRecord['network']> {
  if (!record.network) throw new Error('NVX cleanup network plan is not committed');
  return record.network;
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

function validatePendingAccountPasswd(
  contents: string,
  name: string,
  runId: string,
): { uid: number; gid: number } {
  const fields = contents.trim().split(':');
  if (
    fields.length !== 7 ||
    fields[0] !== name ||
    !/^\d+$/.test(fields[2]) ||
    !/^\d+$/.test(fields[3]) ||
    fields[4] !== `AWF NVX ${runId}` ||
    fields[5] !== '/nonexistent' ||
    fields[6] !== '/usr/sbin/nologin'
  ) {
    throw new Error(`Refusing to remove unverified pending NVX account ${name}`);
  }
  return { uid: Number(fields[2]), gid: Number(fields[3]) };
}

function validatePendingAccountGroup(
  contents: string,
  name: string,
  expectedGid: number | undefined,
): void {
  const fields = contents.trim().split(':');
  if (
    fields.length !== 4 ||
    fields[0] !== name ||
    !/^\d+$/.test(fields[2]) ||
    fields[3] !== '' ||
    expectedGid === undefined ||
    Number(fields[2]) !== expectedGid
  ) {
    throw new Error(`Refusing to remove unverified pending NVX group ${name}`);
  }
}

async function exists(filePath: string, lstat: typeof fs.lstat): Promise<boolean> {
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
