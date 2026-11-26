import { promises as fs } from 'fs';
import * as path from 'path';
import { isMissingProcEntryError } from '../proc-fs-errors';
import {
  assertStableProcessStartTime,
  verifyStableThreadSet,
} from '../confinement-thread-verification';
import {
  assertBoundedString,
  assertIdentityField,
  assertNamespaceLink,
  cgroupMembership,
  parseNumericFields,
  parseNumericLines,
  parseProcessStartTime,
  parseSingleNumericStatus,
  parseStatus,
  parseTaskIds,
  parseUnifiedCgroup,
  requiredStatus,
} from './confinement-proc-parsers';
import type {
  CloudHypervisorCgroupLimits,
  CloudHypervisorLaunchConfinementPolicy,
} from './launcher';

const NETWORK_NAMESPACE_ROOT = '/run/netns';
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
  const executable = await verifyExecutableIdentity(procDirectory, expectedExecutable, dependencies);
  const threadSet = await verifyThreadSet(procDirectory, options, dependencies);
  const cgroup = await verifyCgroupConfinement(procDirectory, options, dependencies);
  const networkNamespace = await verifyNamespaceConfinement(procDirectory, options, dependencies);
  const verifiedThreadCount = await threadSet.verifyStableSet();
  await verifyStableProcessIdentity(procDirectory, options.pid, initialStartTime, executable, dependencies);

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
      relevantThreadIds: threadSet.relevantThreadIds,
      observedThreadCount: verifiedThreadCount,
    },
    networkNamespace,
    cgroup,
  };
}

async function verifyExecutableIdentity(
  procDirectory: string,
  expectedExecutable: string,
  dependencies: CloudHypervisorConfinementVerifierDependencies,
  phase: 'initial' | 'final' = 'initial',
): Promise<string> {
  const executable = await dependencies.readlink(path.join(procDirectory, 'exe'));
  if (phase === 'initial') assertBoundedString(executable, 'process executable');
  if (executable !== expectedExecutable) {
    if (phase === 'final') {
      throw new Error(
        `Cloud Hypervisor confinement verification detected a process identity race: executable ` +
        `changed from ${JSON.stringify(expectedExecutable)} to ${JSON.stringify(executable)}`,
      );
    }
    throw new Error(
      `Cloud Hypervisor confinement verification found executable ${JSON.stringify(executable)}, ` +
      `expected ${JSON.stringify(expectedExecutable)}`,
    );
  }
  return executable;
}

async function verifyThreadSet(
  procDirectory: string,
  options: CloudHypervisorConfinementVerificationOptions,
  dependencies: CloudHypervisorConfinementVerifierDependencies,
): Promise<{ relevantThreadIds: number[]; verifyStableSet(): Promise<number> }> {
  const taskDirectory = path.join(procDirectory, 'task');
  const relevantThreadIds: number[] = [];
  const relevantThreadNames = new Set<string>();
  const readTaskStartTime = async (taskId: number): Promise<string | undefined> => {
    try {
      return parseProcessStartTime(
        await dependencies.readFile(path.join(taskDirectory, String(taskId), 'stat'), 'utf8'),
      );
    } catch (error) {
      // A worker thread may exit between readdir and the read; the main thread may not.
      if (taskId !== options.pid && isMissingProcEntryError(error)) return undefined;
      throw error;
    }
  };
  const verifyTask = async (taskId: number): Promise<string | undefined> => {
    const startTime = await readTaskStartTime(taskId);
    if (startTime === undefined) return undefined;
    let status: Readonly<Record<string, string>>;
    try {
      status = parseStatus(
        await dependencies.readFile(path.join(taskDirectory, String(taskId), 'status'), 'utf8'),
      );
    } catch (error) {
      if (taskId !== options.pid && isMissingProcEntryError(error)) return undefined;
      throw error;
    }
    const name = verifyThreadStatus(status, taskId, options);
    if (name !== undefined && !relevantThreadIds.includes(taskId)) {
      relevantThreadIds.push(taskId);
      relevantThreadNames.add(name);
    }
    return startTime;
  };
  const taskIds = parseTaskIds(await dependencies.readdir(taskDirectory));
  const taskStartTimes = new Map<number, string>();
  for (const taskId of taskIds) {
    const startTime = await verifyTask(taskId);
    if (startTime !== undefined) taskStartTimes.set(taskId, startTime);
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

  return {
    relevantThreadIds,
    verifyStableSet: async () => {
      // Cloud Hypervisor legitimately creates and retires worker threads while it runs.
      // /proc/<pid>/task only lists members of this thread group, so exited threads are
      // dropped and new or recycled TIDs are verified before being accepted.
      const finalTaskIds = parseTaskIds(await dependencies.readdir(taskDirectory));
      if (!finalTaskIds.includes(options.pid)) {
        throw new Error(
          `Cloud Hypervisor confinement verification final task set is missing main thread ${options.pid}`,
        );
      }
      return verifyStableThreadSet({
        finalTaskIds,
        taskStartTimes,
        readTaskStartTime,
        verifyTask,
      });
    },
  };
}

async function verifyCgroupConfinement(
  procDirectory: string,
  options: CloudHypervisorConfinementVerificationOptions,
  dependencies: CloudHypervisorConfinementVerifierDependencies,
): Promise<CloudHypervisorConfinementEvidence['cgroup']> {
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
  return {
    path: options.cgroupPath,
    membership: processCgroup,
    limits: observedLimits,
  };
}

async function verifyNamespaceConfinement(
  procDirectory: string,
  options: CloudHypervisorConfinementVerificationOptions,
  dependencies: CloudHypervisorConfinementVerifierDependencies,
): Promise<CloudHypervisorConfinementEvidence['networkNamespace']> {
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
  return {
    name: options.networkNamespace,
    inode: processNamespace,
  };
}

async function verifyStableProcessIdentity(
  procDirectory: string,
  pid: number,
  initialStartTime: string,
  executable: string,
  dependencies: CloudHypervisorConfinementVerifierDependencies,
): Promise<void> {
  const finalStartTime = parseProcessStartTime(
    await dependencies.readFile(path.join(procDirectory, 'stat'), 'utf8'),
  );
  assertStableProcessStartTime(initialStartTime, finalStartTime, (raced) => new Error(
    `Cloud Hypervisor confinement verification detected a process identity race: PID ` +
    `${pid} start time changed from ${initialStartTime} to ${raced}`,
  ));
  await verifyExecutableIdentity(procDirectory, executable, dependencies, 'final');
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
