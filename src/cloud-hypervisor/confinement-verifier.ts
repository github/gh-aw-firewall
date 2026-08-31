import { promises as fs } from 'fs';
import * as path from 'path';
import type {
  CloudHypervisorCgroupLimits,
  CloudHypervisorLaunchConfinementPolicy,
} from './launcher';

const CGROUP_ROOT = '/sys/fs/cgroup';
const NETWORK_NAMESPACE_ROOT = '/run/netns';
const MAX_VERIFIED_THREADS = 256;
const MAX_EVIDENCE_STRING_LENGTH = 4096;
const SECCOMP_RELEVANT_THREAD_NAMES = ['http-server', 'vmm'] as const;

export interface CloudHypervisorConfinementEvidence {
  readonly schemaVersion: 1;
  readonly verifiedAt: string;
  readonly process: {
    readonly pid: number;
    readonly startTimeTicks: string;
    readonly executable: string;
  };
  readonly identity: {
    readonly uid: number;
    readonly gid: number;
    readonly supplementaryGroups: readonly number[];
  };
  readonly capabilities: CloudHypervisorLaunchConfinementPolicy['capabilities'];
  readonly noNewPrivs: 1;
  readonly seccomp: {
    readonly mode: 2;
    readonly relevantThreadIds: readonly number[];
    readonly observedThreadCount: number;
  };
  readonly networkNamespace: {
    readonly name: string;
    readonly inode: string;
  };
  readonly cgroup: {
    readonly path: string;
    readonly membership: string;
    readonly limits: CloudHypervisorCgroupLimits;
  };
}

export interface CloudHypervisorConfinementVerificationOptions {
  readonly pid: number;
  readonly expectedExecutable: string;
  readonly identity: { readonly uid: number; readonly gid: number };
  readonly launchPolicy: CloudHypervisorLaunchConfinementPolicy;
  readonly networkNamespace: string;
  readonly cgroupPath: string;
  readonly cgroupLimits: CloudHypervisorCgroupLimits;
}

export interface CloudHypervisorConfinementVerifierDependencies {
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  readlink(filePath: string): Promise<string>;
  readdir(directory: string): Promise<string[]>;
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{ ino: bigint }>;
}

const defaultDependencies: CloudHypervisorConfinementVerifierDependencies = {
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  readlink: fs.readlink,
  readdir: (directory) => fs.readdir(directory),
  realpath: fs.realpath,
  stat: (filePath) => fs.stat(filePath, { bigint: true }),
};

export async function verifyCloudHypervisorConfinement(
  options: CloudHypervisorConfinementVerificationOptions,
  dependencies: CloudHypervisorConfinementVerifierDependencies = defaultDependencies,
): Promise<CloudHypervisorConfinementEvidence> {
  if (!Number.isSafeInteger(options.pid) || options.pid <= 1) {
    throw new Error(`Cloud Hypervisor confinement verification received an invalid PID: ${options.pid}`);
  }
  const procDirectory = `/proc/${options.pid}`;
  const expectedExecutable = await dependencies.realpath(options.expectedExecutable);
  assertBoundedString(expectedExecutable, 'expected executable');

  const initialStat = await dependencies.readFile(path.join(procDirectory, 'stat'), 'utf8');
  const initialStartTime = parseProcessStartTime(initialStat);
  const executable = await dependencies.readlink(path.join(procDirectory, 'exe'));
  assertBoundedString(executable, 'process executable');
  if (executable !== expectedExecutable) {
    throw new Error(
      `Cloud Hypervisor confinement verification found executable ${JSON.stringify(executable)}, ` +
      `expected ${JSON.stringify(expectedExecutable)}`,
    );
  }

  const taskDirectory = path.join(procDirectory, 'task');
  const taskIds = parseTaskIds(await dependencies.readdir(taskDirectory));
  const taskStartTimes = new Map<number, string>();
  const relevantThreadIds: number[] = [];
  const relevantThreadNames = new Set<string>();
  for (const taskId of taskIds) {
    taskStartTimes.set(
      taskId,
      parseProcessStartTime(
        await dependencies.readFile(path.join(taskDirectory, String(taskId), 'stat'), 'utf8'),
      ),
    );
    const status = parseStatus(
      await dependencies.readFile(path.join(taskDirectory, String(taskId), 'status'), 'utf8'),
    );
    const name = verifyThreadStatus(status, taskId, options);
    if (name !== undefined) {
      relevantThreadIds.push(taskId);
      relevantThreadNames.add(name);
    }
  }
  const missingRelevantThreads = SECCOMP_RELEVANT_THREAD_NAMES.filter(
    (name) => !relevantThreadNames.has(name),
  );
  if (missingRelevantThreads.length > 0) {
    throw new Error(
      `Cloud Hypervisor confinement verification did not observe seccomp-relevant thread(s): ` +
      missingRelevantThreads.join(', '),
    );
  }

  const processCgroup = parseUnifiedCgroup(
    await dependencies.readFile(path.join(procDirectory, 'cgroup'), 'utf8'),
  );
  const expectedCgroupMembership = cgroupMembership(options.cgroupPath);
  if (processCgroup !== expectedCgroupMembership) {
    throw new Error(
      `Cloud Hypervisor confinement verification found cgroup ${JSON.stringify(processCgroup)}, ` +
      `expected ${JSON.stringify(expectedCgroupMembership)}`,
    );
  }
  const cgroupPids = parseNumericLines(
    await dependencies.readFile(path.join(options.cgroupPath, 'cgroup.procs'), 'utf8'),
    'cgroup.procs',
  );
  if (cgroupPids.length !== 1 || cgroupPids[0] !== options.pid) {
    throw new Error(
      `Cloud Hypervisor confinement verification expected cgroup.procs to contain only PID ` +
      `${options.pid}, found ${cgroupPids.join(', ') || 'none'}`,
    );
  }
  const observedLimits: CloudHypervisorCgroupLimits = {
    memoryMax: (await dependencies.readFile(path.join(options.cgroupPath, 'memory.max'), 'utf8')).trim(),
    cpuMax: (await dependencies.readFile(path.join(options.cgroupPath, 'cpu.max'), 'utf8')).trim(),
    pidsMax: (await dependencies.readFile(path.join(options.cgroupPath, 'pids.max'), 'utf8')).trim(),
  };
  for (const key of ['memoryMax', 'cpuMax', 'pidsMax'] as const) {
    if (observedLimits[key] !== options.cgroupLimits[key]) {
      throw new Error(
        `Cloud Hypervisor confinement verification found ${key}=${JSON.stringify(observedLimits[key])}, ` +
        `expected ${JSON.stringify(options.cgroupLimits[key])}`,
      );
    }
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(options.networkNamespace)) {
    throw new Error(`Unsafe Cloud Hypervisor network namespace name: ${options.networkNamespace}`);
  }
  const processNamespace = await dependencies.readlink(path.join(procDirectory, 'ns', 'net'));
  assertNamespaceLink(processNamespace, 'process network namespace');
  const processNamespaceInode = processNamespace.slice(5, -1);
  const expectedNamespaceInode = (
    await dependencies.stat(path.join(NETWORK_NAMESPACE_ROOT, options.networkNamespace))
  ).ino.toString();
  if (processNamespaceInode !== expectedNamespaceInode) {
    throw new Error(
      `Cloud Hypervisor confinement verification found network namespace ${processNamespace}, ` +
      `expected net:[${expectedNamespaceInode}] (${options.networkNamespace})`,
    );
  }

  const finalTaskIds = parseTaskIds(await dependencies.readdir(taskDirectory));
  const finalStat = await dependencies.readFile(path.join(procDirectory, 'stat'), 'utf8');
  const finalStartTime = parseProcessStartTime(finalStat);
  const finalExecutable = await dependencies.readlink(path.join(procDirectory, 'exe'));
  const finalTaskStartTimes = new Map<number, string>();
  for (const taskId of finalTaskIds) {
    finalTaskStartTimes.set(
      taskId,
      parseProcessStartTime(
        await dependencies.readFile(path.join(taskDirectory, String(taskId), 'stat'), 'utf8'),
      ),
    );
  }
  if (
    finalStartTime !== initialStartTime ||
    finalExecutable !== executable ||
    finalTaskIds.join(',') !== taskIds.join(',') ||
    finalTaskIds.some((taskId) => finalTaskStartTimes.get(taskId) !== taskStartTimes.get(taskId))
  ) {
    throw new Error(
      'Cloud Hypervisor confinement verification detected a process identity or thread-set race',
    );
  }

  return {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    process: {
      pid: options.pid,
      startTimeTicks: initialStartTime,
      executable,
    },
    identity: {
      uid: options.identity.uid,
      gid: options.identity.gid,
      supplementaryGroups: [...options.launchPolicy.supplementaryGroups],
    },
    capabilities: { ...options.launchPolicy.capabilities },
    noNewPrivs: 1,
    seccomp: {
      mode: 2,
      relevantThreadIds,
      observedThreadCount: taskIds.length,
    },
    networkNamespace: {
      name: options.networkNamespace,
      inode: processNamespace,
    },
    cgroup: {
      path: options.cgroupPath,
      membership: processCgroup,
      limits: observedLimits,
    },
  };
}

function verifyThreadStatus(
  status: Readonly<Record<string, string>>,
  taskId: number,
  options: CloudHypervisorConfinementVerificationOptions,
): string | undefined {
  const observedPid = parseSingleNumericStatus(status, 'Pid', taskId);
  const observedTgid = parseSingleNumericStatus(status, 'Tgid', taskId);
  if (observedPid !== taskId || observedTgid !== options.pid) {
    throw new Error(
      `Cloud Hypervisor task ${taskId} reports Pid=${observedPid} and Tgid=${observedTgid}, ` +
      `expected Pid=${taskId} and Tgid=${options.pid}`,
    );
  }
  assertIdentityField(status.Uid, options.identity.uid, 'UID', taskId);
  assertIdentityField(status.Gid, options.identity.gid, 'GID', taskId);
  const groupStatus = status.Groups;
  if (groupStatus === undefined) {
    throw new Error(`Cloud Hypervisor thread ${taskId} is missing /proc status field Groups`);
  }
  const groups = parseNumericFields(groupStatus, 'Groups');
  if (groups.join(',') !== options.launchPolicy.supplementaryGroups.join(',')) {
    throw new Error(
      `Cloud Hypervisor thread ${taskId} has supplementary groups ${groups.join(',') || 'none'}, ` +
      `expected ${options.launchPolicy.supplementaryGroups.join(',') || 'none'}`,
    );
  }

  function parseSingleNumericStatus(
    status: Readonly<Record<string, string>>,
    field: string,
    taskId: number,
  ): number {
    const values = parseNumericFields(requiredStatus(status, field, taskId), field);
    if (values.length !== 1) {
      throw new Error(`Cloud Hypervisor thread ${taskId} has malformed ${field}`);
    }
    return values[0];
  }
  const capabilityFields = {
    CapInh: 'inheritable',
    CapPrm: 'permitted',
    CapEff: 'effective',
    CapBnd: 'bounding',
    CapAmb: 'ambient',
  } as const;
  for (const [statusField, policyField] of Object.entries(capabilityFields) as
    [keyof typeof capabilityFields, keyof CloudHypervisorLaunchConfinementPolicy['capabilities']][]) {
    const observed = requiredStatus(status, statusField, taskId).toLowerCase();
    if (observed !== options.launchPolicy.capabilities[policyField]) {
      throw new Error(
        `Cloud Hypervisor thread ${taskId} has ${statusField}=${observed}, ` +
        `expected ${options.launchPolicy.capabilities[policyField]}`,
      );
    }
  }
  if (requiredStatus(status, 'NoNewPrivs', taskId) !== String(options.launchPolicy.noNewPrivs)) {
    throw new Error(`Cloud Hypervisor thread ${taskId} does not have NoNewPrivs enabled`);
  }
  const name = requiredStatus(status, 'Name', taskId);
  if ((SECCOMP_RELEVANT_THREAD_NAMES as readonly string[]).includes(name)) {
    if (requiredStatus(status, 'Seccomp', taskId) !== '2') {
      throw new Error(
        `Cloud Hypervisor ${name} thread ${taskId} does not have seccomp filter mode 2`,
      );
    }
    return name;
  }
  return undefined;
}

function parseStatus(contents: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error(`Malformed Cloud Hypervisor /proc status line: ${line}`);
    const key = line.slice(0, separator);
    if (result[key] !== undefined) throw new Error(`Duplicate Cloud Hypervisor /proc status field: ${key}`);
    result[key] = line.slice(separator + 1).trim();
  }
  return result;
}

function requiredStatus(
  status: Readonly<Record<string, string>>,
  field: string,
  taskId: number,
): string {
  const value = status[field];
  if (value === undefined || value === '') {
    throw new Error(`Cloud Hypervisor thread ${taskId} is missing /proc status field ${field}`);
  }
  return value;
}

function assertIdentityField(value: string | undefined, expected: number, label: string, taskId: number): void {
  const observed = parseNumericFields(
    value ?? '',
    `${label} for thread ${taskId}`,
  );
  if (observed.length !== 4 || observed.some((entry) => entry !== expected)) {
    throw new Error(
      `Cloud Hypervisor thread ${taskId} has ${label} values ${observed.join(',') || 'none'}, ` +
      `expected four instances of ${expected}`,
    );
  }
}

function parseNumericFields(value: string, label: string): number[] {
  const fields = value.trim().split(/\s+/).filter(Boolean);
  if (fields.some((field) => !/^\d+$/.test(field))) {
    throw new Error(`Cloud Hypervisor confinement verification found malformed ${label}: ${value}`);
  }
  return fields.map(Number);
}

function parseNumericLines(value: string, label: string): number[] {
  return parseNumericFields(value.replace(/\n/g, ' '), label);
}

function parseTaskIds(entries: readonly string[]): number[] {
  const taskIds = entries
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((left, right) => left - right);
  if (taskIds.length === 0) {
    throw new Error('Cloud Hypervisor confinement verification found no process threads');
  }
  if (taskIds.length > MAX_VERIFIED_THREADS) {
    throw new Error(
      `Cloud Hypervisor confinement verification found ${taskIds.length} threads, ` +
      `exceeding the ${MAX_VERIFIED_THREADS} thread evidence bound`,
    );
  }
  return taskIds;
}

function parseProcessStartTime(stat: string): string {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 2) throw new Error('Malformed Cloud Hypervisor /proc stat contents');
  const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  if (!startTime || !/^\d+$/.test(startTime) || startTime.length > 32) {
    throw new Error('Malformed Cloud Hypervisor process start time');
  }
  return startTime;
}

function parseUnifiedCgroup(contents: string): string {
  const lines = contents.trim().split('\n');
  if (lines.length !== 1 || !lines[0].startsWith('0::/')) {
    throw new Error(`Cloud Hypervisor process is not exclusively in a unified cgroup: ${contents.trim()}`);
  }
  return lines[0].slice(3);
}

function cgroupMembership(cgroupPath: string): string {
  const relative = path.relative(CGROUP_ROOT, cgroupPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Cloud Hypervisor cgroup path: ${cgroupPath}`);
  }
  return `/${relative}`;
}

function assertNamespaceLink(value: string, label: string): void {
  if (!/^net:\[\d+\]$/.test(value)) {
    throw new Error(`Malformed ${label}: ${JSON.stringify(value)}`);
  }
}

function assertBoundedString(value: string, label: string): void {
  if (Buffer.byteLength(value) > MAX_EVIDENCE_STRING_LENGTH) {
    throw new Error(`Cloud Hypervisor ${label} exceeds the structured evidence bound`);
  }
}
