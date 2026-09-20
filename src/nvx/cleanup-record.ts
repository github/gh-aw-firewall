import * as path from 'path';
import { NVX_CLEANUP_ROOT } from './paths';
import { createNvxRunLayout } from './run-layout';

export const NVX_CLEANUP_SCHEMA_VERSION = 1;
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
}

export interface NvxCleanupRecord {
  readonly schemaVersion: typeof NVX_CLEANUP_SCHEMA_VERSION;
  readonly runId: string;
  readonly owner: NvxCleanupProcessIdentity;
  readonly vmmIdentity: {
    readonly name: string;
    readonly uid: number;
    readonly gid: number;
  };
  readonly resources: {
    readonly artifactSnapshot?: NvxCleanupFileIdentity;
    readonly runDirectory?: NvxCleanupFileIdentity;
    readonly networkNamespace?: {
      readonly name: string;
      readonly inode: string;
    };
    readonly mountNamespaceInode?: string;
    readonly cgroup?: NvxCleanupFileIdentity;
    readonly deviceAcls: readonly ('/dev/kvm' | '/dev/net/tun')[];
    readonly launcher?: NvxCleanupProcessIdentity;
    readonly openvmm?: NvxCleanupProcessIdentity;
  };
  readonly stages: {
    readonly accountCreated: boolean;
    readonly artifactSnapshotCreated: boolean;
    readonly cgroupCreated: boolean;
    readonly deviceAclsGranted: boolean;
    readonly networkCreated: boolean;
    readonly processStarted: boolean;
    readonly runDirectoryCreated: boolean;
  };
}

export function parseNvxCleanupRecord(
  contents: string,
  recordPath: string,
): NvxCleanupRecord {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `NVX cleanup record is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const record = exactObject(value, 'NVX cleanup record', [
    'schemaVersion',
    'runId',
    'owner',
    'vmmIdentity',
    'resources',
    'stages',
  ]);
  if (record.schemaVersion !== NVX_CLEANUP_SCHEMA_VERSION) {
    throw new Error(`NVX cleanup record schemaVersion must be ${NVX_CLEANUP_SCHEMA_VERSION}`);
  }
  const runId = requireRunId(record.runId);
  const layout = createNvxRunLayout(runId);
  const expectedPath = layout.cleanupRecordPath;
  if (path.resolve(recordPath) !== expectedPath) {
    throw new Error(`NVX cleanup record path must be ${expectedPath}`);
  }

  const owner = processIdentity(record.owner, 'owner');
  const vmmIdentity = exactObject(record.vmmIdentity, 'vmmIdentity', [
    'name',
    'uid',
    'gid',
  ]);
  if (
    typeof vmmIdentity.name !== 'string' ||
    !/^awfnvx-[a-f0-9]{20}$/.test(vmmIdentity.name)
  ) {
    throw new Error('NVX cleanup vmmIdentity.name is invalid');
  }
  const uid = positiveInteger(vmmIdentity.uid, 'vmmIdentity.uid');
  const gid = positiveInteger(vmmIdentity.gid, 'vmmIdentity.gid');

  const resources = allowedObject(record.resources, 'resources', [
    'artifactSnapshot',
    'runDirectory',
    'networkNamespace',
    'mountNamespaceInode',
    'cgroup',
    'deviceAcls',
    'launcher',
    'openvmm',
  ]);
  const deviceAcls = requireArray(resources.deviceAcls, 'resources.deviceAcls');
  if (
    deviceAcls.some((entry) => entry !== '/dev/kvm' && entry !== '/dev/net/tun') ||
    new Set(deviceAcls).size !== deviceAcls.length
  ) {
    throw new Error('NVX cleanup deviceAcls contains an unsupported or duplicate path');
  }
  const networkNamespace = optionalObject(
    resources.networkNamespace,
    'resources.networkNamespace',
    ['name', 'inode'],
  );
  if (
    networkNamespace &&
    (
      typeof networkNamespace.name !== 'string' ||
      networkNamespace.name !== layout.networkNamespace ||
      typeof networkNamespace.inode !== 'string' ||
      !/^\d+$/.test(networkNamespace.inode)
    )
  ) {
    throw new Error('NVX cleanup network namespace identity is invalid');
  }
  const mountNamespaceInode = optionalNumericString(
    resources.mountNamespaceInode,
    'resources.mountNamespaceInode',
  );

  const stages = exactObject(record.stages, 'stages', [
    'accountCreated',
    'artifactSnapshotCreated',
    'cgroupCreated',
    'deviceAclsGranted',
    'networkCreated',
    'processStarted',
    'runDirectoryCreated',
  ]);
  for (const key of Object.keys(stages) as (keyof NvxCleanupRecord['stages'])[]) {
    if (typeof stages[key] !== 'boolean') {
      throw new Error(`NVX cleanup stages.${key} must be boolean`);
    }
  }
  const normalizedStages: NvxCleanupRecord['stages'] = {
    accountCreated: stages.accountCreated as boolean,
    artifactSnapshotCreated: stages.artifactSnapshotCreated as boolean,
    cgroupCreated: stages.cgroupCreated as boolean,
    deviceAclsGranted: stages.deviceAclsGranted as boolean,
    networkCreated: stages.networkCreated as boolean,
    processStarted: stages.processStarted as boolean,
    runDirectoryCreated: stages.runDirectoryCreated as boolean,
  };

  return {
    schemaVersion: NVX_CLEANUP_SCHEMA_VERSION,
    runId,
    owner,
    vmmIdentity: {
      name: vmmIdentity.name,
      uid,
      gid,
    },
    resources: {
      ...(resources.artifactSnapshot === undefined ? {} : {
        artifactSnapshot: fileIdentity(
          resources.artifactSnapshot,
          'artifactSnapshot',
          layout.artifactSnapshotDirectory,
        ),
      }),
      ...(resources.runDirectory === undefined ? {} : {
        runDirectory: fileIdentity(
          resources.runDirectory,
          'runDirectory',
          layout.runDirectory,
        ),
      }),
      ...(networkNamespace ? {
        networkNamespace: {
          name: networkNamespace.name as string,
          inode: networkNamespace.inode as string,
        },
      } : {}),
      ...(mountNamespaceInode ? { mountNamespaceInode } : {}),
      ...(resources.cgroup === undefined ? {} : {
        cgroup: fileIdentity(
          resources.cgroup,
          'cgroup',
          layout.cgroupPath,
        ),
      }),
      deviceAcls: deviceAcls as NvxCleanupRecord['resources']['deviceAcls'],
      ...(resources.launcher === undefined ? {} : {
        launcher: processIdentity(resources.launcher, 'launcher'),
      }),
      ...(resources.openvmm === undefined ? {} : {
        openvmm: processIdentity(resources.openvmm, 'openvmm'),
      }),
    },
    stages: normalizedStages,
  };
}

export function assertNvxCleanupStageConsistency(record: NvxCleanupRecord): void {
  const { resources, stages } = record;
  const requirements: readonly [
    boolean,
    unknown,
    string,
  ][] = [
    [stages.artifactSnapshotCreated, resources.artifactSnapshot, 'artifact snapshot'],
    [stages.runDirectoryCreated, resources.runDirectory, 'run directory'],
    [stages.networkCreated, resources.networkNamespace, 'network namespace'],
    [stages.cgroupCreated, resources.cgroup, 'cgroup'],
    [stages.processStarted, resources.launcher, 'launcher process'],
  ];
  for (const [created, identity, label] of requirements) {
    if (created !== (identity !== undefined)) {
      throw new Error(`NVX cleanup ${label} stage and identity are inconsistent`);
    }
  }
  if (stages.deviceAclsGranted !== (resources.deviceAcls.length > 0)) {
    throw new Error('NVX cleanup device ACL stage and identities are inconsistent');
  }
  if (resources.openvmm && !resources.launcher) {
    throw new Error('NVX cleanup OpenVMM identity requires a launcher identity');
  }
}

function processIdentity(value: unknown, label: string): NvxCleanupProcessIdentity {
  const object = exactObject(value, label, ['pid', 'startTimeTicks', 'executable']);
  const pid = positiveInteger(object.pid, `${label}.pid`);
  if (typeof object.startTimeTicks !== 'string' || !/^\d+$/.test(object.startTimeTicks)) {
    throw new Error(`NVX cleanup ${label}.startTimeTicks is invalid`);
  }
  if (
    typeof object.executable !== 'string' ||
    !path.isAbsolute(object.executable) ||
    object.executable.includes('\0')
  ) {
    throw new Error(`NVX cleanup ${label}.executable is invalid`);
  }
  return {
    pid,
    startTimeTicks: object.startTimeTicks,
    executable: object.executable,
  };
}

function fileIdentity(
  value: unknown,
  label: string,
  expectedPath: string,
): NvxCleanupFileIdentity {
  const object = exactObject(value, label, ['path', 'device', 'inode']);
  if (
    typeof object.path !== 'string' ||
    !path.isAbsolute(object.path) ||
    object.path.includes('\0') ||
    path.resolve(object.path) !== expectedPath
  ) {
    throw new Error(`NVX cleanup ${label}.path is invalid`);
  }
  return {
    path: object.path,
    device: numericString(object.device, `${label}.device`),
    inode: numericString(object.inode, `${label}.inode`),
  };
}

function exactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`NVX cleanup ${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`NVX cleanup ${label} has an unexpected key set`);
  }
  return object;
}

function allowedObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`NVX cleanup ${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) {
    throw new Error(`NVX cleanup ${label} has an unexpected key set`);
  }
  return object;
}

function optionalObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : exactObject(value, label, keys);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`NVX cleanup ${label} must be an array`);
  return value;
}

function requireRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw new Error('NVX cleanup runId must be 32 lowercase hexadecimal characters');
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`NVX cleanup ${label} must be a positive integer`);
  }
  return value as number;
}

function numericString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`NVX cleanup ${label} must be numeric`);
  }
  return value;
}

function optionalNumericString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : numericString(value, label);
}
