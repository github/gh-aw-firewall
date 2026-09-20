import { promises as fs } from 'fs';
import * as path from 'path';
import {
  NVX_RUN_DIRECTORY_ROOT,
  NVX_TRUSTED_ARTIFACT_ROOT,
} from './paths';

const SYSTEM_CGROUP_ROOT = '/sys/fs/cgroup';
const NETWORK_NAMESPACE_ROOT = '/run/netns';
const MAX_VERIFIED_THREADS = 256;
const ZERO_CAPABILITIES = '0000000000000000';
const ALLOWED_SYSTEM_ROOTS = new Set([
  '/bin',
  '/etc/alternatives',
  '/etc/ssl',
  '/lib',
  '/lib64',
  '/opt',
  '/sbin',
  '/usr',
]);

export interface NvxLaunchConfinementPolicy {
  readonly supplementaryGroups: readonly number[];
  readonly capabilities: {
    readonly inheritable: typeof ZERO_CAPABILITIES;
    readonly permitted: typeof ZERO_CAPABILITIES;
    readonly effective: typeof ZERO_CAPABILITIES;
    readonly bounding: typeof ZERO_CAPABILITIES;
    readonly ambient: typeof ZERO_CAPABILITIES;
  };
  readonly noNewPrivs: 1;
  readonly seccompMode: 2;
}

export interface NvxLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly confinementPolicy: NvxLaunchConfinementPolicy;
}

export interface NvxCgroupLimits {
  readonly memoryMax: string;
  readonly cpuMax: string;
  readonly pidsMax: string;
}

export interface NvxConfinementEvidence {
  readonly schemaVersion: 1;
  readonly verifiedAt: string;
  readonly process: {
    readonly pid: number;
    readonly startTimeTicks: string;
    readonly executable: string;
    readonly threadCount: number;
  };
  readonly identity: {
    readonly uid: number;
    readonly gid: number;
    readonly supplementaryGroups: readonly number[];
  };
  readonly capabilities: NvxLaunchConfinementPolicy['capabilities'];
  readonly noNewPrivs: 1;
  readonly seccompMode: 2;
  readonly namespaces: {
    readonly network: string;
    readonly mount: string;
  };
  readonly cgroup: {
    readonly path: string;
    readonly membership: string;
    readonly processIds: readonly number[];
    readonly limits: NvxCgroupLimits;
  };
}

export interface NvxConfinementVerifierDependencies {
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  readlink(filePath: string): Promise<string>;
  readdir(directory: string): Promise<string[]>;
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{ ino: bigint }>;
}

const defaultVerifierDependencies: NvxConfinementVerifierDependencies = {
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  readlink: fs.readlink,
  readdir: (directory) => fs.readdir(directory),
  realpath: fs.realpath,
  stat: (filePath) => fs.stat(filePath, { bigint: true }),
};

export function buildNvxConstrainedLaunchCommand(options: {
  readonly tools: {
    readonly ip: string;
    readonly bwrap: string;
    readonly setpriv: string;
    readonly python: string;
  };
  readonly namespaceName: string;
  readonly identity: { readonly uid: number; readonly gid: number };
  readonly nvxRoot: string;
  readonly runDirectory: string;
  readonly systemReadOnlyPaths: readonly string[];
  readonly nvxArguments: readonly string[];
}): NvxLaunchCommand {
  assertSafeName(options.namespaceName, 'NVX network namespace');
  assertPositiveInteger(options.identity.uid, 'NVX VMM uid');
  assertPositiveInteger(options.identity.gid, 'NVX VMM gid');
  for (const [name, value] of Object.entries(options.tools)) {
    assertAbsolutePath(value, `NVX ${name} tool`);
  }
  const nvxRoot = assertRunScopedPath(
    options.nvxRoot,
    NVX_TRUSTED_ARTIFACT_ROOT,
    /^run-[A-Za-z0-9_-]+$/,
    'NVX trusted artifact root',
  );
  const runDirectory = assertRunScopedPath(
    options.runDirectory,
    NVX_RUN_DIRECTORY_ROOT,
    /^[a-f0-9]{32}$/,
    'NVX run directory',
  );
  if (path.basename(nvxRoot) !== `run-${path.basename(runDirectory)}`) {
    throw new Error('NVX trusted artifacts and run directory must share one run ID');
  }
  assertNonOverlappingPaths(nvxRoot, runDirectory);
  if (options.systemReadOnlyPaths.length < 1) {
    throw new Error('NVX filesystem jail requires explicit read-only system roots');
  }
  const readOnlyPaths = [...new Set(options.systemReadOnlyPaths)].sort();
  for (const systemPath of readOnlyPaths) {
    if (!ALLOWED_SYSTEM_ROOTS.has(systemPath)) {
      throw new Error(`NVX filesystem jail rejects system root: ${systemPath}`);
    }
  }
  for (const argument of options.nvxArguments) {
    if (argument.includes('\0')) throw new Error('NVX launch arguments must not contain NUL bytes');
  }

  const jailArguments: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--hostname', 'awf-nvx',
    '--proc', '/proc',
    '--dev', '/dev',
    '--dev-bind', '/dev/kvm', '/dev/kvm',
    '--dev-bind', '/dev/net/tun', '/dev/net/tun',
    '--tmpfs', '/tmp',
  ];
  for (const systemPath of readOnlyPaths) {
    jailArguments.push('--ro-bind', systemPath, systemPath);
  }
  jailArguments.push(
    '--ro-bind', nvxRoot, '/opt/awf-nvx',
    '--bind', runDirectory, '/run/awf-nvx',
    '--chdir', '/opt/awf-nvx',
    options.tools.setpriv,
    `--reuid=${options.identity.uid}`,
    `--regid=${options.identity.gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--inh-caps=-all',
    '--bounding-set=-all',
    '--ambient-caps=-all',
    '--',
    options.tools.python,
    '/opt/awf-nvx/nvx.py',
    ...options.nvxArguments,
  );

  return {
    command: options.tools.ip,
    args: [
      'netns', 'exec', options.namespaceName,
      options.tools.bwrap,
      ...jailArguments,
    ],
    confinementPolicy: {
      supplementaryGroups: [],
      capabilities: {
        inheritable: ZERO_CAPABILITIES,
        permitted: ZERO_CAPABILITIES,
        effective: ZERO_CAPABILITIES,
        bounding: ZERO_CAPABILITIES,
        ambient: ZERO_CAPABILITIES,
      },
      noNewPrivs: 1,
      seccompMode: 2,
    },
  };
}

export function computeNvxCgroupLimits(options: {
  readonly guestMemoryMib: number;
  readonly vcpuCount: number;
  readonly pidsMax: number;
}): NvxCgroupLimits {
  assertPositiveInteger(options.guestMemoryMib, 'NVX guest memory');
  assertPositiveInteger(options.vcpuCount, 'NVX vCPU count');
  assertPositiveInteger(options.pidsMax, 'NVX process limit');
  const memoryHeadroomMib = 256;
  const period = 100_000;
  return {
    memoryMax: String((options.guestMemoryMib + memoryHeadroomMib) * 1024 * 1024),
    cpuMax: `${(options.vcpuCount + 1) * period} ${period}`,
    pidsMax: String(options.pidsMax),
  };
}

export async function verifyNvxConfinement(options: {
  readonly openvmmPid: number;
  readonly expectedOpenvmmExecutable: string;
  readonly expectedCgroupPids: readonly number[];
  readonly identity: { readonly uid: number; readonly gid: number };
  readonly launchPolicy: NvxLaunchConfinementPolicy;
  readonly networkNamespace: string;
  readonly expectedMountNamespaceInode: string;
  readonly cgroupPath: string;
  readonly cgroupLimits: NvxCgroupLimits;
}, dependencies: NvxConfinementVerifierDependencies = defaultVerifierDependencies):
Promise<NvxConfinementEvidence> {
  assertPositiveInteger(options.openvmmPid, 'NVX OpenVMM pid');
  assertSafeName(options.networkNamespace, 'NVX network namespace');
  if (!/^\d+$/.test(options.expectedMountNamespaceInode)) {
    throw new Error('NVX mount namespace inode must be numeric');
  }
  const procDirectory = `/proc/${options.openvmmPid}`;
  const expectedExecutable = await dependencies.realpath(options.expectedOpenvmmExecutable);
  const initialStartTime = parseProcessStartTime(
    await dependencies.readFile(path.join(procDirectory, 'stat'), 'utf8'),
  );
  const executable = await dependencies.readlink(path.join(procDirectory, 'exe'));
  if (executable !== expectedExecutable) {
    throw new Error(
      `NVX confinement found OpenVMM executable ${JSON.stringify(executable)}, ` +
      `expected ${JSON.stringify(expectedExecutable)}`,
    );
  }

  const taskDirectory = path.join(procDirectory, 'task');
  const taskIds = parseNumericEntries(await dependencies.readdir(taskDirectory), 'task');
  if (taskIds.length > MAX_VERIFIED_THREADS) {
    throw new Error(`NVX OpenVMM exceeds the ${MAX_VERIFIED_THREADS}-thread verification limit`);
  }
  const taskStartTimes = new Map<number, string>();
  for (const taskId of taskIds) {
    taskStartTimes.set(taskId, parseProcessStartTime(
      await dependencies.readFile(
        path.join(taskDirectory, String(taskId), 'stat'),
        'utf8',
      ),
    ));
    verifyStatus(
      parseStatus(await dependencies.readFile(
        path.join(taskDirectory, String(taskId), 'status'),
        'utf8',
      )),
      taskId,
      options,
    );
  }

  const membership = parseUnifiedCgroup(
    await dependencies.readFile(path.join(procDirectory, 'cgroup'), 'utf8'),
  );
  const expectedMembership = path.relative(SYSTEM_CGROUP_ROOT, options.cgroupPath);
  if (membership !== `/${expectedMembership}`) {
    throw new Error(
      `NVX confinement found cgroup ${membership}, expected /${expectedMembership}`,
    );
  }
  const processIds = parseNumericLines(
    await dependencies.readFile(path.join(options.cgroupPath, 'cgroup.procs'), 'utf8'),
    'cgroup.procs',
  );
  const expectedPids = [...new Set(options.expectedCgroupPids)].sort((a, b) => a - b);
  if (processIds.join(',') !== expectedPids.join(',')) {
    throw new Error(
      `NVX confinement found cgroup PIDs ${processIds.join(',') || 'none'}, ` +
      `expected ${expectedPids.join(',') || 'none'}`,
    );
  }
  const observedLimits: NvxCgroupLimits = {
    memoryMax: (await dependencies.readFile(
      path.join(options.cgroupPath, 'memory.max'),
      'utf8',
    )).trim(),
    cpuMax: (await dependencies.readFile(
      path.join(options.cgroupPath, 'cpu.max'),
      'utf8',
    )).trim(),
    pidsMax: (await dependencies.readFile(
      path.join(options.cgroupPath, 'pids.max'),
      'utf8',
    )).trim(),
  };
  for (const key of ['memoryMax', 'cpuMax', 'pidsMax'] as const) {
    if (observedLimits[key] !== options.cgroupLimits[key]) {
      throw new Error(
        `NVX confinement found ${key}=${observedLimits[key]}, ` +
        `expected ${options.cgroupLimits[key]}`,
      );
    }
  }

  const networkLink = await dependencies.readlink(path.join(procDirectory, 'ns', 'net'));
  const networkInode = parseNamespaceLink(networkLink, 'network');
  const expectedNetworkInode = (
    await dependencies.stat(path.join(NETWORK_NAMESPACE_ROOT, options.networkNamespace))
  ).ino.toString();
  if (networkInode !== expectedNetworkInode) {
    throw new Error('NVX OpenVMM is not in the expected network namespace');
  }
  const mountLink = await dependencies.readlink(path.join(procDirectory, 'ns', 'mnt'));
  if (parseNamespaceLink(mountLink, 'mount') !== options.expectedMountNamespaceInode) {
    throw new Error('NVX OpenVMM is not in the expected filesystem jail namespace');
  }

  const finalTaskIds = parseNumericEntries(await dependencies.readdir(taskDirectory), 'task');
  const finalStartTime = parseProcessStartTime(
    await dependencies.readFile(path.join(procDirectory, 'stat'), 'utf8'),
  );
  const finalExecutable = await dependencies.readlink(path.join(procDirectory, 'exe'));
  const finalTaskStartTimes = new Map<number, string>();
  for (const taskId of finalTaskIds) {
    finalTaskStartTimes.set(taskId, parseProcessStartTime(
      await dependencies.readFile(
        path.join(taskDirectory, String(taskId), 'stat'),
        'utf8',
      ),
    ));
  }
  if (
    finalStartTime !== initialStartTime ||
    finalExecutable !== executable ||
    finalTaskIds.join(',') !== taskIds.join(',') ||
    finalTaskIds.some((id) => finalTaskStartTimes.get(id) !== taskStartTimes.get(id))
  ) {
    throw new Error('NVX confinement detected a process identity or thread-set race');
  }

  return {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    process: {
      pid: options.openvmmPid,
      startTimeTicks: initialStartTime,
      executable,
      threadCount: taskIds.length,
    },
    identity: {
      uid: options.identity.uid,
      gid: options.identity.gid,
      supplementaryGroups: [],
    },
    capabilities: { ...options.launchPolicy.capabilities },
    noNewPrivs: 1,
    seccompMode: 2,
    namespaces: {
      network: networkLink,
      mount: mountLink,
    },
    cgroup: {
      path: options.cgroupPath,
      membership,
      processIds,
      limits: observedLimits,
    },
  };
}

function verifyStatus(
  status: Readonly<Record<string, string>>,
  taskId: number,
  options: {
    readonly openvmmPid: number;
    readonly identity: { readonly uid: number; readonly gid: number };
    readonly launchPolicy: NvxLaunchConfinementPolicy;
  },
): void {
  if (parseSingleNumber(status.Pid, 'Pid') !== taskId) {
    throw new Error(`NVX OpenVMM thread ${taskId} reports a different PID`);
  }
  if (parseSingleNumber(status.Tgid, 'Tgid') !== options.openvmmPid) {
    throw new Error(`NVX OpenVMM thread ${taskId} reports a different thread group`);
  }
  assertIdentity(status.Uid, options.identity.uid, 'UID', taskId);
  assertIdentity(status.Gid, options.identity.gid, 'GID', taskId);
  if (parseNumericFields(status.Groups ?? '', 'Groups').length !== 0) {
    throw new Error(`NVX OpenVMM thread ${taskId} retained supplementary groups`);
  }
  for (const [field, expected] of [
    ['CapInh', options.launchPolicy.capabilities.inheritable],
    ['CapPrm', options.launchPolicy.capabilities.permitted],
    ['CapEff', options.launchPolicy.capabilities.effective],
    ['CapBnd', options.launchPolicy.capabilities.bounding],
    ['CapAmb', options.launchPolicy.capabilities.ambient],
  ] as const) {
    if ((status[field] ?? '').toLowerCase() !== expected) {
      throw new Error(`NVX OpenVMM thread ${taskId} has unexpected ${field}`);
    }
  }
  if (status.NoNewPrivs !== '1') {
    throw new Error(`NVX OpenVMM thread ${taskId} does not have no_new_privs`);
  }
  if (status.Seccomp !== '2') {
    throw new Error(`NVX OpenVMM thread ${taskId} does not have seccomp filter mode 2`);
  }
}

function parseStatus(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return result;
}

function parseProcessStartTime(contents: string): string {
  const close = contents.lastIndexOf(')');
  const fields = contents.slice(close + 2).split(' ');
  const value = fields[19];
  if (!value || !/^\d+$/.test(value)) throw new Error('NVX process stat is malformed');
  return value;
}

function parseUnifiedCgroup(contents: string): string {
  const matches = contents.split('\n').filter((line) => line.startsWith('0::'));
  if (matches.length !== 1) throw new Error('NVX process is not in one unified cgroup');
  return matches[0].slice(3);
}

function parseNamespaceLink(value: string, label: string): string {
  const match = /^mnt:\[(\d+)\]$/.exec(value) ?? /^net:\[(\d+)\]$/.exec(value);
  if (!match) throw new Error(`NVX ${label} namespace link is malformed: ${value}`);
  return match[1];
}

function parseNumericEntries(values: readonly string[], label: string): number[] {
  if (values.length < 1) throw new Error(`NVX ${label} list is empty`);
  return values.map((value) => parseSingleNumber(value, label)).sort((a, b) => a - b);
}

function parseNumericLines(contents: string, label: string): number[] {
  return contents.split('\n').filter(Boolean)
    .map((value) => parseSingleNumber(value, label))
    .sort((a, b) => a - b);
}

function parseNumericFields(contents: string, label: string): number[] {
  if (!contents.trim()) return [];
  return contents.trim().split(/\s+/).map((value) => parseSingleNumber(value, label));
}

function parseSingleNumber(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`NVX ${label} is malformed`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`NVX ${label} is unsafe`);
  return parsed;
}

function assertIdentity(
  value: string | undefined,
  expected: number,
  label: string,
  taskId: number,
): void {
  const fields = parseNumericFields(value ?? '', label);
  if (fields.length !== 4 || fields.some((field) => field !== expected)) {
    throw new Error(`NVX OpenVMM thread ${taskId} has unexpected ${label}`);
  }
}

function assertSafeName(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Unsafe ${label} name: ${value}`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertAbsolutePath(value: string, label: string): void {
  if (!path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} path must be absolute`);
  }
}

function assertRunScopedPath(
  value: string,
  root: string,
  basenamePattern: RegExp,
  label: string,
): string {
  assertAbsolutePath(value, label);
  const resolved = path.resolve(value);
  if (path.dirname(resolved) !== root || !basenamePattern.test(path.basename(resolved))) {
    throw new Error(`${label} must be an AWF-owned per-run path under ${root}`);
  }
  return resolved;
}

function assertNonOverlappingPaths(left: string, right: string): void {
  if (left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)) {
    throw new Error('NVX trusted artifact root and run directory must not overlap');
  }
}
