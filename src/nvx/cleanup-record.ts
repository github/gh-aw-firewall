import * as path from 'path';
import { NVX_CLEANUP_ROOT } from './paths';
import { createNvxRunLayout } from './run-layout';

export const NVX_CLEANUP_SCHEMA_VERSION = 2;
export { NVX_CLEANUP_ROOT };

export interface NvxCleanupFileIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export interface NvxCleanupProcessIdentity {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly executable: string;
  readonly executableDevice: string;
  readonly executableInode: string;
  readonly uid: number;
  readonly gid: number;
  readonly networkNamespace: string;
}

export interface NvxCleanupDeviceAclIdentity extends NvxCleanupFileIdentity {
  readonly path: '/dev/kvm' | '/dev/net/tun';
  readonly uid: number;
  readonly permissions: 'rw-';
}

export interface NvxCleanupInterfaceIdentity {
  readonly name: string;
  readonly namespace?: string;
  readonly ifindex: number;
}

export interface NvxCleanupNetwork {
  readonly resourceToken: string;
  readonly namespaceName: string;
  readonly netnsPath: string;
  readonly hostVethName: string;
  readonly namespaceVethName: string;
  readonly tapName: string;
  readonly infrastructureBridge: string;
  readonly hostForwardRuleComment: string;
}

export interface NvxCleanupRecord {
  readonly schemaVersion: typeof NVX_CLEANUP_SCHEMA_VERSION;
  readonly runId: string;
  readonly owner: NvxCleanupProcessIdentity;
  vmmIdentity?: {
    state: 'pending' | 'live';
    name: string;
    uid?: number;
    gid?: number;
  };
  network?: NvxCleanupNetwork;
  readonly resources: {
    artifactSnapshot?: NvxCleanupFileIdentity;
    runDirectory?: NvxCleanupFileIdentity;
    networkNamespace?: NvxCleanupFileIdentity;
    networkReservation?: NvxCleanupFileIdentity;
    hostVeth?: NvxCleanupInterfaceIdentity;
    namespaceVeth?: NvxCleanupInterfaceIdentity;
    tap?: NvxCleanupInterfaceIdentity;
    mountNamespaceInode?: string;
    cgroup?: NvxCleanupFileIdentity;
    deviceAcls: NvxCleanupDeviceAclIdentity[];
    launcher?: NvxCleanupProcessIdentity;
    openvmm?: NvxCleanupProcessIdentity;
  };
  readonly stages: {
    accountCreated: boolean;
    artifactSnapshotCreated: boolean;
    cgroupCreated: boolean;
    deviceAclsGranted: boolean;
    networkCreated: boolean;
    processStarted: boolean;
    runDirectoryCreated: boolean;
  };
  updatedAt: string;
}

export function parseNvxCleanupRecord(
  contents: string,
  recordPath: string,
  cleanupRoot = NVX_CLEANUP_ROOT,
): NvxCleanupRecord {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`NVX cleanup record is not valid JSON: ${formatError(error)}`);
  }
  const record = object(value, 'record');
  assertAllowedKeys(record, [
    'schemaVersion', 'runId', 'owner', 'vmmIdentity', 'network',
    'resources', 'stages', 'updatedAt',
  ], 'record');
  if (record.schemaVersion !== NVX_CLEANUP_SCHEMA_VERSION) {
    throw new Error(`NVX cleanup record schemaVersion must be ${NVX_CLEANUP_SCHEMA_VERSION}`);
  }
  const runId = stringMatching(record.runId, /^[a-f0-9]{32}$/, 'runId');
  const layout = createNvxRunLayout(runId);
  const expectedRecordPath = path.join(cleanupRoot, `${runId}.json`);
  if (path.resolve(recordPath) !== path.resolve(expectedRecordPath)) {
    throw new Error(`NVX cleanup record path must be ${expectedRecordPath}`);
  }
  const owner = parseProcess(record.owner, 'owner');
  const resources = object(record.resources, 'resources');
  assertAllowedKeys(resources, [
    'artifactSnapshot', 'runDirectory', 'networkNamespace', 'networkReservation',
    'hostVeth', 'namespaceVeth', 'tap', 'mountNamespaceInode', 'cgroup',
    'deviceAcls', 'launcher', 'openvmm',
  ], 'resources');
  const stages = object(record.stages, 'stages');
  assertAllowedKeys(stages, [
    'accountCreated', 'artifactSnapshotCreated', 'cgroupCreated',
    'deviceAclsGranted', 'networkCreated', 'processStarted', 'runDirectoryCreated',
  ], 'stages');
  const parsed: NvxCleanupRecord = {
    schemaVersion: NVX_CLEANUP_SCHEMA_VERSION,
    runId,
    owner,
    ...(record.vmmIdentity === undefined ? {} : {
      vmmIdentity: parseVmmIdentity(record.vmmIdentity),
    }),
    ...(record.network === undefined ? {} : {
      network: parseNetwork(record.network, layout.networkNamespace),
    }),
    resources: {
      ...(resources.artifactSnapshot === undefined ? {} : {
        artifactSnapshot: parseFile(
          resources.artifactSnapshot, 'artifactSnapshot', layout.artifactSnapshotDirectory,
        ),
      }),
      ...(resources.runDirectory === undefined ? {} : {
        runDirectory: parseFile(resources.runDirectory, 'runDirectory', layout.runDirectory),
      }),
      ...(resources.networkNamespace === undefined ? {} : {
        networkNamespace: parseFile(
          resources.networkNamespace, 'networkNamespace', `/var/run/netns/${layout.networkNamespace}`,
        ),
      }),
      ...(resources.networkReservation === undefined ? {} : {
        networkReservation: parseReservation(resources.networkReservation),
      }),
      ...(resources.hostVeth === undefined ? {} : {
        hostVeth: parseInterface(resources.hostVeth, 'hostVeth'),
      }),
      ...(resources.namespaceVeth === undefined ? {} : {
        namespaceVeth: parseInterface(resources.namespaceVeth, 'namespaceVeth'),
      }),
      ...(resources.tap === undefined ? {} : {
        tap: parseInterface(resources.tap, 'tap'),
      }),
      ...(resources.mountNamespaceInode === undefined ? {} : {
        mountNamespaceInode: numericString(resources.mountNamespaceInode, 'mountNamespaceInode'),
      }),
      ...(resources.cgroup === undefined ? {} : {
        cgroup: parseFile(resources.cgroup, 'cgroup', layout.cgroupPath),
      }),
      deviceAcls: parseDeviceAcls(resources.deviceAcls),
      ...(resources.launcher === undefined ? {} : {
        launcher: parseProcess(resources.launcher, 'launcher'),
      }),
      ...(resources.openvmm === undefined ? {} : {
        openvmm: parseProcess(resources.openvmm, 'openvmm'),
      }),
    },
    stages: {
      accountCreated: boolean(stages.accountCreated, 'accountCreated'),
      artifactSnapshotCreated: boolean(stages.artifactSnapshotCreated, 'artifactSnapshotCreated'),
      cgroupCreated: boolean(stages.cgroupCreated, 'cgroupCreated'),
      deviceAclsGranted: boolean(stages.deviceAclsGranted, 'deviceAclsGranted'),
      networkCreated: boolean(stages.networkCreated, 'networkCreated'),
      processStarted: boolean(stages.processStarted, 'processStarted'),
      runDirectoryCreated: boolean(stages.runDirectoryCreated, 'runDirectoryCreated'),
    },
    updatedAt: stringMatching(record.updatedAt, /^\d{4}-\d\d-\d\dT/, 'updatedAt'),
  };
  return parsed;
}

export function assertNvxCleanupStageConsistency(record: NvxCleanupRecord): void {
  const checks: readonly [boolean, unknown, string][] = [
    [record.stages.accountCreated, record.vmmIdentity?.state === 'live', 'account'],
    [record.stages.artifactSnapshotCreated, record.resources.artifactSnapshot, 'artifact snapshot'],
    [record.stages.runDirectoryCreated, record.resources.runDirectory, 'run directory'],
    [record.stages.networkCreated, record.resources.networkNamespace, 'network namespace'],
    [record.stages.cgroupCreated, record.resources.cgroup, 'cgroup'],
    [record.stages.processStarted, record.resources.launcher, 'launcher process'],
  ];
  for (const [created, identity, label] of checks) {
    if (created !== Boolean(identity)) {
      throw new Error(`NVX cleanup ${label} stage and identity are inconsistent`);
    }
  }
  if (record.stages.deviceAclsGranted !== (record.resources.deviceAcls.length > 0)) {
    throw new Error('NVX cleanup device ACL stage and identities are inconsistent');
  }
  if (record.resources.openvmm && !record.resources.launcher) {
    throw new Error('NVX cleanup OpenVMM identity requires a launcher identity');
  }
  if (record.network && record.network.namespaceName !== createNvxRunLayout(record.runId).networkNamespace) {
    throw new Error('NVX cleanup network plan is not bound to the run');
  }
  const hasNetworkResource =
    record.resources.networkNamespace !== undefined ||
    record.resources.hostVeth !== undefined ||
    record.resources.namespaceVeth !== undefined ||
    record.resources.tap !== undefined;
  if ((record.stages.networkCreated || hasNetworkResource) && !record.network) {
    throw new Error('NVX cleanup network resources require a committed network plan');
  }
  if (record.network && !record.resources.networkReservation) {
    throw new Error('NVX cleanup network plan requires a committed reservation');
  }
  if (
    record.network &&
    record.resources.networkReservation &&
    path.basename(record.resources.networkReservation.path) !==
      `${record.network.resourceToken}.json`
  ) {
    throw new Error('NVX cleanup network reservation is not bound to the resource token');
  }
}

function parseVmmIdentity(value: unknown): NonNullable<NvxCleanupRecord['vmmIdentity']> {
  const item = object(value, 'vmmIdentity');
  assertAllowedKeys(item, ['state', 'name', 'uid', 'gid'], 'vmmIdentity');
  const name = stringMatching(item.name, /^awfnvx-[a-f0-9]{20}$/, 'vmmIdentity.name');
  if (item.state === 'pending') return { state: 'pending', name };
  if (item.state !== 'live') throw new Error('NVX cleanup vmmIdentity.state is invalid');
  return {
    state: 'live',
    name,
    uid: positiveInteger(item.uid, 'vmmIdentity.uid'),
    gid: positiveInteger(item.gid, 'vmmIdentity.gid'),
  };
}

function parseNetwork(value: unknown, expectedName: string): NvxCleanupNetwork {
  const item = object(value, 'network');
  assertAllowedKeys(item, [
    'resourceToken', 'namespaceName', 'netnsPath', 'hostVethName', 'namespaceVethName',
    'tapName', 'infrastructureBridge', 'hostForwardRuleComment',
  ], 'network');
  const resourceToken = stringMatching(
    item.resourceToken, /^[a-f0-9]{12}$/, 'network.resourceToken',
  );
  const namespaceName = stringMatching(item.namespaceName, /^[A-Za-z0-9_.-]+$/, 'network.namespaceName');
  if (namespaceName !== expectedName) throw new Error('NVX cleanup network namespace is invalid');
  const netnsPath = absolute(item.netnsPath, 'network.netnsPath');
  if (netnsPath !== `/var/run/netns/${namespaceName}`) throw new Error('NVX cleanup netns path is invalid');
  return {
    resourceToken,
    namespaceName,
    netnsPath,
    hostVethName: interfaceName(item.hostVethName, 'network.hostVethName'),
    namespaceVethName: interfaceName(item.namespaceVethName, 'network.namespaceVethName'),
    tapName: interfaceName(item.tapName, 'network.tapName'),
    infrastructureBridge: interfaceName(item.infrastructureBridge, 'network.infrastructureBridge'),
    hostForwardRuleComment: stringMatching(
      item.hostForwardRuleComment, /^awf-microvm-[a-f0-9]{12}$/, 'network.hostForwardRuleComment',
    ),
  };
}

function parseProcess(value: unknown, label: string): NvxCleanupProcessIdentity {
  const item = object(value, label);
  assertAllowedKeys(item, [
    'pid', 'startTimeTicks', 'executable', 'executableDevice',
    'executableInode', 'uid', 'gid', 'networkNamespace',
  ], label);
  return {
    pid: positiveInteger(item.pid, `${label}.pid`),
    startTimeTicks: numericString(item.startTimeTicks, `${label}.startTimeTicks`),
    executable: absolute(item.executable, `${label}.executable`),
    executableDevice: numericString(item.executableDevice, `${label}.executableDevice`),
    executableInode: numericString(item.executableInode, `${label}.executableInode`),
    uid: nonNegativeInteger(item.uid, `${label}.uid`),
    gid: nonNegativeInteger(item.gid, `${label}.gid`),
    networkNamespace: stringMatching(
      item.networkNamespace, /^net:\[\d+\]$/, `${label}.networkNamespace`,
    ),
  };
}

function parseFile(value: unknown, label: string, expectedPath: string): NvxCleanupFileIdentity {
  const item = object(value, label);
  assertAllowedKeys(item, ['path', 'device', 'inode'], label);
  const filePath = absolute(item.path, `${label}.path`);
  if (path.resolve(filePath) !== expectedPath) throw new Error(`NVX cleanup ${label}.path is invalid`);
  return {
    path: filePath,
    device: numericString(item.device, `${label}.device`),
    inode: numericString(item.inode, `${label}.inode`),
  };
}

function parseReservation(value: unknown): NvxCleanupFileIdentity {
  const item = object(value, 'networkReservation');
  assertAllowedKeys(item, ['path', 'device', 'inode'], 'networkReservation');
  const filePath = absolute(item.path, 'networkReservation.path');
  if (
    path.dirname(filePath) !== '/run/awf-microvm-network/reservations' ||
    !/^[a-f0-9]{12}\.json$/.test(path.basename(filePath))
  ) throw new Error('NVX cleanup networkReservation.path is invalid');
  return {
    path: filePath,
    device: numericString(item.device, 'networkReservation.device'),
    inode: numericString(item.inode, 'networkReservation.inode'),
  };
}

function parseInterface(value: unknown, label: string): NvxCleanupInterfaceIdentity {
  const item = object(value, label);
  assertAllowedKeys(item, ['name', 'namespace', 'ifindex'], label);
  return {
    name: interfaceName(item.name, `${label}.name`),
    ...(item.namespace === undefined ? {} : {
      namespace: stringMatching(item.namespace, /^[A-Za-z0-9_.-]+$/, `${label}.namespace`),
    }),
    ifindex: positiveInteger(item.ifindex, `${label}.ifindex`),
  };
}

function parseDeviceAcls(value: unknown): NvxCleanupDeviceAclIdentity[] {
  if (!Array.isArray(value)) throw new Error('NVX cleanup resources.deviceAcls must be an array');
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = object(entry, `deviceAcls[${index}]`);
    assertAllowedKeys(
      item,
      ['path', 'device', 'inode', 'uid', 'permissions'],
      `deviceAcls[${index}]`,
    );
    if (item.path !== '/dev/kvm' && item.path !== '/dev/net/tun') {
      throw new Error('NVX cleanup deviceAcls contains an unsupported path');
    }
    if (seen.has(item.path)) throw new Error('NVX cleanup deviceAcls contains a duplicate path');
    seen.add(item.path);
    if (item.permissions !== 'rw-') throw new Error('NVX cleanup device ACL permissions must be rw-');
    return {
      path: item.path,
      device: numericString(item.device, 'deviceAcl.device'),
      inode: numericString(item.inode, 'deviceAcl.inode'),
      uid: positiveInteger(item.uid, 'deviceAcl.uid'),
      permissions: 'rw-',
    };
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`NVX cleanup ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`NVX cleanup ${label} has an unexpected key set`);
  }
}

function absolute(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`NVX cleanup ${label} is invalid`);
  }
  return value;
}

function stringMatching(value: unknown, expression: RegExp, label: string): string {
  if (typeof value !== 'string' || !expression.test(value)) {
    throw new Error(`NVX cleanup ${label} is invalid`);
  }
  return value;
}

function interfaceName(value: unknown, label: string): string {
  return stringMatching(value, /^[A-Za-z0-9_.-]{1,15}$/, label);
}

function numericString(value: unknown, label: string): string {
  return stringMatching(value, /^\d+$/, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`NVX cleanup ${label} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`NVX cleanup ${label} must be a non-negative integer`);
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`NVX cleanup ${label} must be boolean`);
  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
