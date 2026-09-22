import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';

const GETFACL_DIAGNOSTIC_PATHS = ['/usr/bin/getfacl', '/bin/getfacl'] as const;

function formatMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

function mountInfoUnescape(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function pathIsUnderMount(target: string, mountPoint: string): boolean {
  const normalizedMountPoint = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;
  return target === mountPoint || target.startsWith(normalizedMountPoint);
}

export interface CloudHypervisorMountDescription {
  mountPoint: string;
  filesystemType: string;
  source: string;
  /** Per-mount options, e.g. `rw,nosuid,nodev,noexec,relatime`. */
  options: string;
  /** Superblock options, which can independently carry `noexec`. */
  superblockOptions: string;
}

/**
 * Resolves the most specific `/proc/self/mountinfo` entry containing
 * `filePath`, so execution failures can be attributed to the mount the
 * trusted artifacts were staged on.
 */
export function findMountForPath(
  mountInfo: string,
  filePath: string,
): CloudHypervisorMountDescription | undefined {
  let best: CloudHypervisorMountDescription | undefined;
  for (const line of mountInfo.split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    if (left.length < 6 || right.length < 3) continue;
    const mountPoint = mountInfoUnescape(left[4]);
    if (!pathIsUnderMount(filePath, mountPoint)) continue;
    if (!best || mountPoint.length > best.mountPoint.length) {
      best = {
        mountPoint,
        filesystemType: right[0],
        source: mountInfoUnescape(right[1]),
        options: left[5],
        superblockOptions: right[2],
      };
    }
  }
  return best;
}

export function mountRejectsExecution(mount: CloudHypervisorMountDescription): boolean {
  return [mount.options, mount.superblockOptions].some((options) =>
    options.split(',').includes('noexec'));
}

export async function describeMountForPath(filePath: string): Promise<string> {
  try {
    const best = findMountForPath(
      await fs.readFile('/proc/self/mountinfo', 'utf8'),
      filePath,
    );
    if (!best) return 'mount: unavailable (no /proc/self/mountinfo match)';
    return `mount: ${best.mountPoint} type=${best.filesystemType} source=${best.source} options=${best.options}`;
  } catch (error) {
    return `mount: unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}

export async function describeAcl(filePath: string): Promise<string> {
  try {
    const getfaclPath = await resolveDiagnosticGetfaclPath();
    const result = await execa(getfaclPath, ['-cp', '--absolute-names', '--', filePath], {
      reject: false,
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      return `acl=unavailable(getfacl exit ${result.exitCode}${output ? `: ${output}` : ''})`;
    }
    return `acl=${output.replace(/\s+/g, ' ')}`;
  } catch (error) {
    return `acl=unavailable(${error instanceof Error ? error.message : String(error)})`;
  }
}

export async function resolveDiagnosticGetfaclPath(): Promise<string> {
  for (const candidate of GETFACL_DIAGNOSTIC_PATHS) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known system location without consulting PATH.
    }
  }
  throw new Error(`getfacl not found at ${GETFACL_DIAGNOSTIC_PATHS.join(' or ')}`);
}

export function pathComponents(filePath: string): string[] {
  const { root } = path.parse(filePath);
  const components = [root];
  let current = root;
  for (const segment of filePath.slice(root.length).split('/').filter(Boolean)) {
    current = path.join(current, segment);
    components.push(current);
  }
  return components;
}

export async function describePathComponent(filePath: string): Promise<string> {
  let statDescription: string;
  try {
    const stat = await fs.lstat(filePath);
    const type = stat.isSymbolicLink()
      ? 'symlink'
      : stat.isDirectory()
        ? 'dir'
        : stat.isFile()
          ? 'file'
          : 'other';
    statDescription =
      `stat=${type},mode=${formatMode(stat.mode)},uid=${stat.uid},gid=${stat.gid},size=${stat.size}`;
  } catch (error) {
    statDescription = `stat=unavailable(${error instanceof Error ? error.message : String(error)})`;
  }
  return `${filePath}: ${statDescription}; ${await describeAcl(filePath)}`;
}

export async function buildExecutionFailureDiagnostics(binaryPath: string): Promise<string> {
  const uid = process.getuid?.();
  const euid = process.geteuid?.();
  const gid = process.getgid?.();
  const egid = process.getegid?.();
  const groups = process.getgroups?.();
  const identity =
    `uid=${uid ?? 'unknown'},euid=${euid ?? 'unknown'},` +
    `gid=${gid ?? 'unknown'},egid=${egid ?? 'unknown'},` +
    `groups=${groups ? groups.join(',') : 'unknown'}`;
  const lines = [
    'Cloud Hypervisor execution diagnostics:',
    `identity: ${identity}`,
    await describeMountForPath(binaryPath),
    'path components:',
  ];
  for (const component of pathComponents(binaryPath)) {
    lines.push(`  - ${await describePathComponent(component)}`);
  }
  return `\n${lines.join('\n')}`;
}
