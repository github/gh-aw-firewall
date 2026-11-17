import * as path from 'path';
import {
  assertAbsolutePath,
  assertNonOverlappingPaths,
  assertPositiveInteger,
  assertRunScopedPath,
  assertSafeName,
} from './confinement-assertions';
import {
  NVX_RUN_DIRECTORY_ROOT,
  NVX_TRUSTED_ARTIFACT_ROOT,
} from './paths';

const CALLER_MOUNT_CAPABILITIES = '00000000000000c0';
const NO_CAPABILITIES = '0000000000000000';
type NvxCapabilitySet = typeof CALLER_MOUNT_CAPABILITIES | typeof NO_CAPABILITIES;
const SECCOMP_EXEC_PYTHON = [
  'import ctypes, os, sys',
  // Bubblewrap preserves unused inherited FDs; Python must not make these
  // checked disk handles close-on-exec before handing them to OpenVMM.
  '[(os.fstat(fd), os.set_inheritable(fd, True)) for fd in (6, 7)]',
  'data = open(sys.argv[1], "rb").read()',
  'data and len(data) % 8 == 0 or sys.exit("invalid seccomp filter")',
  'F = type("F", (ctypes.Structure,), {"_fields_": [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]})',
  'filters = (F * (len(data) // 8)).from_buffer_copy(data)',
  'P = type("P", (ctypes.Structure,), {"_fields_": [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(F))]})',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'program = P(len(filters), filters)',
  'result = libc.prctl(22, 2, ctypes.byref(program), 0, 0)',
  'result == 0 or (_ for _ in ()).throw(OSError(ctypes.get_errno(), "PR_SET_SECCOMP"))',
  'os.execv(sys.argv[2], sys.argv[2:])',
].join('; ');
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
    readonly inheritable: NvxCapabilitySet;
    readonly permitted: NvxCapabilitySet;
    readonly effective: NvxCapabilitySet;
    readonly bounding: NvxCapabilitySet;
    readonly ambient: NvxCapabilitySet;
  };
  readonly noNewPrivs: 1;
  readonly seccompMode: 2;
}

export interface NvxLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly confinementPolicy: NvxLaunchConfinementPolicy;
  readonly allowCallerMount: boolean;
}

export interface NvxCgroupLimits {
  readonly memoryMax: string;
  readonly cpuMax: string;
  readonly pidsMax: string;
}

export function buildNvxConstrainedLaunchCommand(options: {
  readonly tools: {
    readonly ip: string;
    readonly bwrap: string;
    readonly setpriv: string;
  };
  readonly namespaceName: string;
  readonly identity: { readonly uid: number; readonly gid: number };
  readonly nvxRoot: string;
  readonly runDirectory: string;
  readonly systemReadOnlyPaths: readonly string[];
  readonly shareRoots?: readonly {
    readonly source: string;
    readonly jailPath: string;
    readonly mode: 'ro' | 'rw';
  }[];
  readonly openvmmArguments: readonly string[];
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
  for (const argument of options.openvmmArguments) {
    if (argument.includes('\0')) throw new Error('NVX launch arguments must not contain NUL bytes');
  }
  const shareRoots = [...(options.shareRoots ?? [])];
  const occupiedSources = [nvxRoot, runDirectory];
  const occupiedTargets = [nvxRoot, runDirectory, ...readOnlyPaths];
  for (const share of shareRoots) {
    assertAbsolutePath(share.source, 'NVX share source');
    assertAbsolutePath(share.jailPath, 'NVX share jail path');
    if (!share.jailPath.startsWith('/mnt/awf-nvx-shares/')) {
      throw new Error(`NVX share jail path is outside the canonical root: ${share.jailPath}`);
    }
    for (const existing of occupiedSources) assertNonOverlappingPaths(existing, share.source);
    for (const existing of occupiedTargets) assertNonOverlappingPaths(existing, share.jailPath);
    for (const existing of shareRoots) {
      if (existing === share) break;
      assertNonOverlappingPaths(existing.source, share.source);
      assertNonOverlappingPaths(existing.jailPath, share.jailPath);
    }
    occupiedSources.push(share.source);
    occupiedTargets.push(share.jailPath);
  }
  const allowCallerMount = shareRoots.length > 0;
  const capabilities = allowCallerMount ? CALLER_MOUNT_CAPABILITIES : NO_CAPABILITIES;

  const jailArguments: string[] = [
    '--die-with-parent',
    '--new-session',
    '--block-fd', '3',
    '--json-status-fd', '4',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--hostname', 'awf-nvx',
    '--dir', '/etc',
    '--dir', '/opt',
    '--dir', '/run',
    '--perms', '0444',
    '--file', '5', '/run/openvmm-seccomp.bpf',
    '--dir', '/mnt',
    '--dir', '/mnt/awf-nvx-shares',
    '--proc', '/proc',
    '--dev', '/dev',
    '--dev-bind', '/dev/kvm', '/dev/kvm',
    '--tmpfs', '/tmp',
  ];
  for (const systemPath of readOnlyPaths) {
    jailArguments.push('--ro-bind', systemPath, systemPath);
  }
  for (const share of shareRoots) {
    jailArguments.push(
      share.mode === 'ro' ? '--ro-bind' : '--bind',
      share.source,
      share.jailPath,
    );
  }
  jailArguments.push(
    '--ro-bind', path.join(runDirectory, 'resolv.conf'), '/etc/resolv.conf',
    '--ro-bind', nvxRoot, '/opt/awf-nvx',
    '--bind', runDirectory, '/run/awf-nvx',
    '--chdir', '/opt/awf-nvx',
    '--clearenv',
    '--setenv', 'TERM', 'dumb',
    '--setenv', 'HOME', '/nonexistent',
    '--setenv', 'XDG_STATE_HOME', '/run/awf-nvx/state',
    '--setenv', 'PATH', '/usr/sbin:/usr/bin:/sbin:/bin',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'LC_ALL', 'C.UTF-8',
    '--setenv', 'OPENVMM_LOG', 'off',
    options.tools.setpriv,
    `--reuid=${options.identity.uid}`,
    `--regid=${options.identity.gid}`,
    '--clear-groups',
    '--no-new-privs',
    `--inh-caps=${allowCallerMount ? '-all,+setgid,+setuid' : '-all'}`,
    `--bounding-set=${allowCallerMount ? '-all,+setgid,+setuid' : '-all'}`,
    `--ambient-caps=${allowCallerMount ? '-all,+setgid,+setuid' : '-all'}`,
    '--',
    '/usr/bin/python3',
    '-c',
    SECCOMP_EXEC_PYTHON,
    '/run/openvmm-seccomp.bpf',
    '/opt/awf-nvx/openvmm',
    ...options.openvmmArguments,
  );

  return {
    command: options.tools.ip,
    args: [
      'netns', 'exec', options.namespaceName,
      options.tools.bwrap,
      ...jailArguments,
    ],
    allowCallerMount,
    confinementPolicy: {
      supplementaryGroups: [],
      capabilities: {
        inheritable: capabilities,
        permitted: capabilities,
        effective: capabilities,
        bounding: capabilities,
        ambient: capabilities,
      },
      noNewPrivs: 1,
      seccompMode: 2,
    },
  };
}

export function computeNvxCgroupLimits(options: {
  readonly guestMemoryMib: number;
  readonly vcpuCount: number;
  readonly hostPidsMax: number;
}): NvxCgroupLimits {
  assertPositiveInteger(options.guestMemoryMib, 'NVX guest memory');
  assertPositiveInteger(options.vcpuCount, 'NVX vCPU count');
  assertPositiveInteger(options.hostPidsMax, 'NVX host process limit');
  const memoryHeadroomMib = 256;
  const period = 100_000;
  return {
    memoryMax: String((options.guestMemoryMib + memoryHeadroomMib) * 1024 * 1024),
    cpuMax: `${(options.vcpuCount + 1) * period} ${period}`,
    pidsMax: String(options.hostPidsMax),
  };
}
