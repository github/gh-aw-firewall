import * as path from 'path';
import type { MicrovmNetworkPlan } from '../microvm/network';

export const CLEANUP_RECORD_VERSION = 1;

export interface FileIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly executableIdentity: FileIdentity;
  readonly uid: number;
  readonly gid: number;
  readonly networkNamespace: string;
}

export interface InterfaceIdentity {
  readonly name: string;
  readonly namespace?: string;
  readonly ifindex: number;
}

export interface MountIdentity {
  readonly mountId: number;
  readonly device: string;
  readonly root: string;
  readonly mountPoint: string;
  readonly filesystemType: string;
  readonly source: string;
}

export interface RecordedProcess {
  readonly state: 'pending' | 'live';
  readonly executable: string;
  readonly socketPath: string;
  readonly sourcePath?: string;
  readonly identity?: ProcessIdentity;
}

export interface CleanupRecord {
  readonly version: 1;
  readonly runId: string;
  readonly owner: ProcessIdentity;
  readonly cloudHypervisorBinary: string;
  readonly paths: {
    readonly runDirectory: string;
    readonly cgroupPath: string;
    readonly virtiofsdShareDirectory: string;
    artifactSnapshotDirectory?: string;
  };
  network?: {
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
    artifactSnapshotDirectory?: FileIdentity;
    netns?: FileIdentity;
    hostVeth?: InterfaceIdentity;
    namespaceVeth?: InterfaceIdentity;
    tap?: InterfaceIdentity;
  };
  readonly processes: Record<string, RecordedProcess>;
  vmmIdentity?: {
    state: 'pending' | 'live';
    name: string;
    uid?: number;
    gid?: number;
    aclPaths: string[];
  };
  mounts: MountIdentity[];
  updatedAt: string;
}

export function validateRecord(
  record: CleanupRecord,
  recordPath: string,
  registryRoot: string,
): void {
  if (
    record?.version !== CLEANUP_RECORD_VERSION ||
    !record.runId ||
    !/^[A-Za-z0-9_.-]+$/.test(record.runId) ||
    path.join(registryRoot, `${record.runId}.json`) !== recordPath
  ) throw new Error('invalid cleanup record identity');
  if (
    !record.paths?.runDirectory.endsWith(`/${record.runId}`) ||
    !record.paths?.cgroupPath.endsWith(`/${record.runId}`) ||
    !record.paths?.virtiofsdShareDirectory.endsWith(`/${record.runId}`) ||
    (record.paths.artifactSnapshotDirectory !== undefined && (
      path.dirname(record.paths.artifactSnapshotDirectory) !== path.join(
        path.dirname(path.dirname(record.paths.runDirectory)),
        'trusted-artifacts',
      ) ||
      !/^run-[A-Za-z0-9_-]+$/.test(path.basename(record.paths.artifactSnapshotDirectory))
    )) ||
    (record.network !== undefined && (
      record.network.netnsPath !== `/var/run/netns/${record.network.namespaceName}` ||
      !/^awf-microvm-[0-9a-f]{12}$/.test(record.network.hostForwardRuleComment) ||
      !/^[A-Za-z0-9_.-]{1,15}$/.test(record.network.infrastructureBridge)
    ))
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
  if (record.vmmIdentity) {
    const identity = record.vmmIdentity;
    if (
      !/^awfvmm-[a-f0-9]{20}$/.test(identity.name) ||
      (identity.state !== 'pending' && identity.state !== 'live') ||
      !Array.isArray(identity.aclPaths) ||
      identity.aclPaths.some((aclPath) => aclPath !== '/dev/kvm' && aclPath !== '/dev/net/tun') ||
      new Set(identity.aclPaths).size !== identity.aclPaths.length ||
      (identity.state === 'live' && (() => {
        const uid = identity.uid;
        const gid = identity.gid;
        return typeof uid !== 'number' ||
          !Number.isSafeInteger(uid) ||
          uid <= 0 ||
          typeof gid !== 'number' ||
          !Number.isSafeInteger(gid) ||
          gid <= 0;
      })())
    ) throw new Error('cleanup VMM identity is malformed');
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

interface CleanupScopedPaths {
  readonly runId: string;
  readonly runBaseDir: string;
  readonly runDirectory: string;
  readonly cgroupPath: string;
}

export function assertSafeRecordPaths(
  paths: CleanupScopedPaths,
  plan: MicrovmNetworkPlan | undefined,
): void {
  if (
    (plan !== undefined && plan.runId !== paths.runId) ||
    !paths.runDirectory.startsWith(`${paths.runBaseDir}${path.sep}`) ||
    !paths.runDirectory.endsWith(`${path.sep}${paths.runId}`) ||
    !paths.cgroupPath.endsWith(`${path.sep}${paths.runId}`)
  ) throw new Error('Cloud Hypervisor cleanup resources are not scoped to one run');
}

export function assertSafeProcessKey(key: string): void {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(key) ||
    key === '__proto__' ||
    key === 'constructor' ||
    key === 'prototype'
  ) throw new Error(`Unsafe cleanup process key: ${key}`);
}

export function parseStatusIdentity(status: string, name: 'Uid' | 'Gid'): number {
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

export function validateProcessIdentity(identity: ProcessIdentity, label: string): void {
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

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function sameMountIdentity(left: MountIdentity, right: MountIdentity): boolean {
  return left.mountId === right.mountId &&
    left.device === right.device &&
    left.root === right.root &&
    left.mountPoint === right.mountPoint &&
    left.filesystemType === right.filesystemType &&
    left.source === right.source;
}

export function parseMountInfoLine(line: string): MountIdentity {
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

export function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}
