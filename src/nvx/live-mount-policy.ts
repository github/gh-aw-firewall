import { promises as fs } from 'fs';
import * as path from 'path';
import {
  SENSITIVE_PATH_EXEMPTIONS,
  resolveSensitivePaths,
} from '../sensitive-paths';
import {
  planNvxFilesystemWrites,
  type NvxFilesystemWritePlan,
} from './filesystem-write-policy';
import {
  validateNvxExports,
  type NvxDirectoryExport,
  type NvxExportMode,
} from './workspace-export';

export interface NvxLiveMount {
  readonly tag: string;
  readonly guestTarget: string;
  readonly hostPath: string;
  readonly mode: NvxExportMode;
  readonly deniedPaths: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly writablePaths: readonly string[];
}

interface NvxMountPolicyStats {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly nlink: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface NvxLiveMountPolicyDependencies {
  realpath(filePath: string): Promise<string>;
  lstat(filePath: string): Promise<NvxMountPolicyStats>;
  readdir(directory: string): Promise<string[]>;
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readMountInfo(): Promise<string>;
}

const defaultDependencies: NvxLiveMountPolicyDependencies = {
  realpath: fs.realpath,
  lstat: (filePath) => fs.lstat(filePath),
  readdir: (directory) => fs.readdir(directory),
  mkdir: (directory, options) => fs.mkdir(directory, options),
  readMountInfo: () => fs.readFile('/proc/self/mountinfo', 'utf8'),
};

export interface NvxLiveMountPlan {
  readonly mounts: readonly NvxLiveMount[];
  readonly writePlan: NvxFilesystemWritePlan;
}

export async function planNvxLiveMounts(
  exports: readonly NvxDirectoryExport[],
  allowWrite: readonly string[] | undefined,
  dependencies: NvxLiveMountPolicyDependencies = defaultDependencies,
): Promise<NvxLiveMountPlan> {
  validateNvxExports(exports);
  await assertDisjointShareRoots(exports, dependencies);
  await assertNoNestedMounts(exports, dependencies);
  const writePlan = await planNvxFilesystemWrites(exports, allowWrite, {
    realpath: dependencies.realpath,
    lstat: dependencies.lstat,
  });
  const mounts: NvxLiveMount[] = [];
  for (const exportEntry of exports) {
    const exportPlan = writePlan.exports.find(
      (entry) => entry.export.tag === exportEntry.tag,
    );
    if (!exportPlan) throw new Error(`NVX write plan omitted export: ${exportEntry.tag}`);
    const deniedPaths = await resolveSensitiveHostPaths(
      exportEntry,
      resolveSensitivePaths('nvx').map((entry) => entry.path),
      dependencies,
    );
    const exemptionCandidates = await resolveSensitiveHostPaths(
      exportEntry,
      SENSITIVE_PATH_EXEMPTIONS.map((entry) => entry.path),
      dependencies,
      false,
    );
    const allowedPaths = exemptionCandidates.filter((candidate) =>
      deniedPaths.some((denied) => isWithin(candidate, denied)),
    );
    const writablePaths = exportPlan.disposition === 'selective'
      ? exportPlan.overlays.map((overlay) => overlay.hostPath)
      : [];
    for (const denied of deniedPaths) {
      if (writablePaths.some((writable) => pathsOverlap(denied, writable))) {
        throw new Error(
          `NVX sensitive read denial overlaps filesystem.allowWrite: ${denied}`,
        );
      }
    }
    mounts.push({
      tag: exportEntry.tag,
      guestTarget: exportEntry.target,
      hostPath: exportEntry.source,
      mode: exportPlan.disposition === 'read-only' ? 'ro' : exportEntry.mode,
      deniedPaths,
      allowedPaths,
      writablePaths,
    });
  }
  await assertNoHardLinkBoundaryAliases(mounts, dependencies);
  return { mounts, writePlan };
}

async function resolveSensitiveHostPaths(
  exportEntry: NvxDirectoryExport,
  guestPaths: readonly string[],
  dependencies: NvxLiveMountPolicyDependencies,
  createMissing = true,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const guestPath of guestPaths) {
    if (!isWithin(guestPath, exportEntry.target)) continue;
    const relative = path.posix.relative(exportEntry.target, guestPath);
    const candidate = path.join(exportEntry.source, ...relative.split('/'));
    if (createMissing) {
      await dependencies.mkdir(candidate, { recursive: true, mode: 0o700 });
    }
    let canonical: string;
    try {
      canonical = await assertCanonicalPath(candidate, exportEntry.source, dependencies);
    } catch (error) {
      if (!createMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const stats = await dependencies.lstat(canonical);
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(`NVX mount policy path must be a regular file or directory: ${candidate}`);
    }
    resolved.push(canonical);
  }
  return resolved;
}

async function assertCanonicalPath(
  candidate: string,
  root: string,
  dependencies: NvxLiveMountPolicyDependencies,
): Promise<string> {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`NVX mount policy path escapes its share: ${candidate}`);
  }
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stats = await dependencies.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`NVX mount policy path must not contain symlinks: ${candidate}`);
    }
    if (await dependencies.realpath(current) !== current) {
      throw new Error(`NVX mount policy path must be canonical: ${candidate}`);
    }
  }
  const canonical = await dependencies.realpath(candidate);
  if (canonical !== candidate) {
    throw new Error(`NVX mount policy path must be canonical: ${candidate}`);
  }
  return canonical;
}

async function assertDisjointShareRoots(
  exports: readonly NvxDirectoryExport[],
  dependencies: NvxLiveMountPolicyDependencies,
): Promise<void> {
  const lineages = new Map<string, Set<string>>();
  for (const entry of exports) {
    const identities = new Set<string>();
    let current = entry.source;
    while (true) {
      const stats = await dependencies.lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`NVX share root lineage contains a symlink: ${current}`);
      }
      identities.add(identity(stats));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    lineages.set(entry.tag, identities);
  }
  for (let index = 0; index < exports.length; index += 1) {
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const entry = exports[index];
      const other = exports[otherIndex];
      if (pathsOverlap(entry.source, other.source)) {
        throw new Error(
          `NVX share roots overlap: ${other.source} and ${entry.source}`,
        );
      }
      const entryRoot = identity(await dependencies.lstat(entry.source));
      const otherRoot = identity(await dependencies.lstat(other.source));
      if (
        lineages.get(other.tag)!.has(entryRoot) ||
        lineages.get(entry.tag)!.has(otherRoot)
      ) {
        throw new Error(
          `NVX share roots cross through a bind mount: ${other.source} and ${entry.source}`,
        );
      }
    }
  }
}

async function assertNoNestedMounts(
  exports: readonly NvxDirectoryExport[],
  dependencies: NvxLiveMountPolicyDependencies,
): Promise<void> {
  const mountPoints = parseMountPoints(await dependencies.readMountInfo());
  for (const entry of exports) {
    const nested = mountPoints.find(
      (mountPoint) => mountPoint !== entry.source && isWithin(mountPoint, entry.source),
    );
    if (nested) {
      throw new Error(
        `NVX share ${entry.source} contains nested mount ${nested}; ` +
        'mounts crossing policy boundaries are unsupported',
      );
    }
  }
}

function parseMountPoints(contents: string): string[] {
  return contents.split('\n').filter(Boolean).map((line) => {
    const fields = line.split(' ');
    if (fields.length < 5) throw new Error('Malformed /proc/self/mountinfo entry');
    return decodeMountInfoPath(fields[4]);
  });
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, encoded: string) => ({
    '040': ' ',
    '011': '\t',
    '012': '\n',
    '134': '\\',
  })[encoded] ?? encoded);
}

async function assertNoHardLinkBoundaryAliases(
  mounts: readonly NvxLiveMount[],
  dependencies: NvxLiveMountPolicyDependencies,
): Promise<void> {
  const devices = await Promise.all(
    mounts.map(async (mount) => String((await dependencies.lstat(mount.hostPath)).dev)),
  );
  const hasCrossMountAliasRisk = mounts.some((_mount, index) =>
    mounts.slice(0, index).some(
      (_other, otherIndex) => devices[otherIndex] === devices[index],
    ),
  );
  const boundaries = new Map<string, { path: string; readable: boolean; writable: boolean }>();
  for (const mount of mounts) {
    if (
      !hasCrossMountAliasRisk &&
      mount.deniedPaths.length === 0 &&
      mount.writablePaths.length === 0
    ) continue;
    await walk(mount.hostPath, async (candidate, stats) => {
      if (!stats.isFile() || stats.nlink < 2) return;
      const readable = !mount.deniedPaths.some((denied) => isWithin(candidate, denied)) ||
        mount.allowedPaths.some((allowed) => isWithin(candidate, allowed));
      const writable = mount.mode === 'rw' &&
        (mount.writablePaths.length === 0 ||
          mount.writablePaths.some((allowed) => isWithin(candidate, allowed)));
      const key = identity(stats);
      const previous = boundaries.get(key);
      if (
        previous &&
        (previous.readable !== readable || previous.writable !== writable)
      ) {
        throw new Error(
          `NVX hard-link alias crosses a filesystem policy boundary: ` +
          `${previous.path} and ${candidate}`,
        );
      }
      boundaries.set(key, { path: candidate, readable, writable });
    }, dependencies);
  }
}

async function walk(
  root: string,
  visit: (candidate: string, stats: NvxMountPolicyStats) => Promise<void>,
  dependencies: NvxLiveMountPolicyDependencies,
): Promise<void> {
  const stats = await dependencies.lstat(root);
  await visit(root, stats);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  for (const name of await dependencies.readdir(root)) {
    await walk(path.join(root, name), visit, dependencies);
  }
}

function identity(stats: Pick<NvxMountPolicyStats, 'dev' | 'ino'>): string {
  return `${stats.dev}:${stats.ino}`;
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
