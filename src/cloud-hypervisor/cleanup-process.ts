import { promises as fs } from 'fs';
import type { FileIdentity, InterfaceIdentity, MountIdentity, ProcessIdentity, RecordedProcess } from './cleanup-identity';
import { parseMountInfoLine, parseStatusIdentity, sameFileIdentity } from './cleanup-identity';

export interface CleanupProcessDependencies {
  readonly readFile: typeof fs.readFile;
  readonly readlink: typeof fs.readlink;
  readonly lstat: typeof fs.lstat;
  readonly stat: typeof fs.stat;
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export function tryKill(
  kill: typeof process.kill,
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export function bridgeForwardRule(
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

export async function captureProcessIdentity(
  dependencies: CleanupProcessDependencies,
  pid: number,
): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Unsafe process id: ${pid}`);
  const statText = await dependencies.readFile(`/proc/${pid}/stat`, 'utf8');
  const closingParen = statText.lastIndexOf(')');
  if (closingParen < 0) throw new Error(`Malformed /proc/${pid}/stat`);
  const fields = statText.slice(closingParen + 2).trim().split(/\s+/);
  const startTime = fields[19];
  if (!startTime) throw new Error(`Missing process start time for PID ${pid}`);
  const status = await dependencies.readFile(`/proc/${pid}/status`, 'utf8');
  const uid = parseStatusIdentity(status, 'Uid');
  const gid = parseStatusIdentity(status, 'Gid');
  const executableLink = `/proc/${pid}/exe`;
  const executable = (await dependencies.readlink(executableLink)).replace(/ \(deleted\)$/, '');
  return {
    pid,
    startTime,
    executable,
    executableIdentity: await captureFollowedFileIdentity(dependencies.stat, executableLink),
    uid,
    gid,
    networkNamespace: await dependencies.readlink(`/proc/${pid}/ns/net`),
  };
}

export async function processMatches(
  dependencies: CleanupProcessDependencies,
  expected: ProcessIdentity,
  recorded?: RecordedProcess,
): Promise<boolean> {
  try {
    const current = await captureProcessIdentity(dependencies, expected.pid);
    if (
      current.startTime !== expected.startTime ||
      current.executable !== expected.executable ||
      !sameFileIdentity(current.executableIdentity, expected.executableIdentity) ||
      current.uid !== expected.uid ||
      current.gid !== expected.gid ||
      current.networkNamespace !== expected.networkNamespace
    ) return false;
    if (recorded) {
      const cmdline = await dependencies.readFile(`/proc/${expected.pid}/cmdline`, 'utf8');
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

export async function captureFileIdentity(
  lstat: typeof fs.lstat,
  filePath: string,
): Promise<FileIdentity> {
  const value = await lstat(filePath, { bigint: true });
  return { device: value.dev.toString(), inode: value.ino.toString() };
}

export async function captureFollowedFileIdentity(
  stat: typeof fs.stat,
  filePath: string,
): Promise<FileIdentity> {
  const value = await stat(filePath, { bigint: true });
  return { device: value.dev.toString(), inode: value.ino.toString() };
}

export async function captureInterfaceIdentity(
  run: CleanupProcessDependencies['run'],
  ipPath: string,
  name: string,
  namespace?: string,
): Promise<InterfaceIdentity> {
  const identity = await tryCaptureInterfaceIdentity(run, ipPath, name, namespace);
  if (!identity) throw new Error(`Could not capture interface identity for "${name}"`);
  return identity;
}

export async function tryCaptureInterfaceIdentity(
  run: CleanupProcessDependencies['run'],
  ipPath: string,
  name: string,
  namespace?: string,
): Promise<InterfaceIdentity | undefined> {
  const args = namespace
    ? ['netns', 'exec', namespace, ipPath, '-json', 'link', 'show', 'dev', name]
    : ['-json', 'link', 'show', 'dev', name];
  const result = await run(ipPath, args);
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

export async function interfaceExists(
  run: CleanupProcessDependencies['run'],
  ipPath: string,
  name: string,
): Promise<boolean> {
  return (await tryCaptureInterfaceIdentity(run, ipPath, name)) !== undefined;
}

export async function readMounts(
  readFile: typeof fs.readFile,
): Promise<MountIdentity[]> {
  const text = await readFile('/proc/self/mountinfo', 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map(parseMountInfoLine);
}
