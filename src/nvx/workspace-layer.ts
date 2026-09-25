import { createHash } from 'crypto';
import { createReadStream, promises as fs, type Stats } from 'fs';
import * as path from 'path';
import { CREDENTIAL_ENTRIES, HOME_FORBIDDEN_SUBDIRS, HOME_TOOL_PATHS } from '../config/mount-policy';
import {
  isNvxWritableGuestPath,
  hasNvxWritableGuestDescendant,
  type NvxExportWritePlan,
  type NvxFilesystemWritePlan,
} from './filesystem-write-policy';
import {
  NVX_GUEST_HOME,
  NVX_GUEST_RUN_SCRIPT,
  NVX_SCRATCH_UPPER_DIRECTORY,
  type NvxDirectoryExport,
} from './workspace-export';

/**
 * Credential-bearing paths that are never staged into the guest. The list is
 * `$HOME`-relative, and is applied relative to each export root because an
 * export root can itself be a home directory (`resolveNvxExports` falls back to
 * the process working directory when `GITHUB_WORKSPACE` is unset). The same
 * filter is applied on copy-back so an entry that was never staged can never be
 * written back either.
 */
const EXCLUDED_RELATIVE_PATHS = [
  ...CREDENTIAL_ENTRIES.map(({ path: entryPath }) => normalizeRelative(entryPath)),
  ...HOME_FORBIDDEN_SUBDIRS.map(normalizeRelative),
];

/**
 * `e2fsck` reports 1 ("errors corrected") and 2 ("errors corrected, reboot
 * recommended") after a successful repair. Neither is a failure here: the
 * image is a throwaway scratch device that is discarded right after the dump.
 */
const E2FSCK_REPAIR_EXIT_CODES = new Set([1, 2, 3]);

export type NvxWorkspaceTool = 'debugfs' | 'e2fsck';

export interface NvxWorkspaceLayerDependencies {
  runTool(
    tool: NvxWorkspaceTool,
    args: readonly string[],
  ): Promise<{ readonly exitCode: number; readonly stderr: string }>;
  /**
   * Ownership hooks. AWF always runs the NVX backend as root, so the defaults
   * are the real `chown`/`lchown`; they are injectable so the staging policy
   * can be unit-tested as an unprivileged user.
   */
  readonly chown?: (target: string, uid: number, gid: number) => Promise<void>;
  readonly lchown?: (target: string, uid: number, gid: number) => Promise<void>;
}

export interface NvxWorkspaceLayerConfig {
  readonly runId: string;
  /** Host directory the `custom` layer source tree is staged under. */
  readonly stagingRoot: string;
  readonly exports: readonly NvxDirectoryExport[];
  readonly writePlan: NvxFilesystemWritePlan;
  /** Guest workload identity; staged writable trees are owned by it. */
  readonly uid: number;
  readonly gid: number;
  /** Contents of the generated guest entrypoint script. */
  readonly runScript: string;
  /** Host `$HOME` whose allowed tool state is seeded into the guest home. */
  readonly homePath?: string;
}

export interface NvxWorkspaceCopyBackResult {
  /** Guest-absolute paths written back to the host. */
  readonly applied: readonly string[];
  /** Guest-absolute paths removed on the host because the guest deleted them. */
  readonly removed: readonly string[];
  /**
   * Guest-absolute paths the guest changed but the write policy refused to
   * propagate. Non-empty only when `filesystem.allowWrite` narrowed an export.
   */
  readonly rejected: readonly string[];
}

/**
 * Stages the AWF-owned `custom` EROFS layer for one NVX run and copies guest
 * writes back to the host afterwards.
 *
 * The NVX guest assembles `lowerdir=custom:runtime:distro` over
 * `upperdir=<scratch>/upper`, so a host directory staged into the custom layer
 * is visible read-write inside the guest and every guest write lands in the
 * writable scratch image. Copy-back therefore reads the overlay upper layer out
 * of the scratch image with `debugfs` after the microVM has exited and merges
 * it into the host tree, which gives NVX a live read-write host workspace
 * without any change to the attested guest artifacts.
 */
export class NvxWorkspaceLayer {
  readonly layerSourcePath: string;
  private readonly extractionDirectory: string;
  private originalState: Map<string, string> | undefined;
  private staged = false;
  private readonly chown: (target: string, uid: number, gid: number) => Promise<void>;
  private readonly lchown: (target: string, uid: number, gid: number) => Promise<void>;

  constructor(
    private readonly config: NvxWorkspaceLayerConfig,
    private readonly dependencies: NvxWorkspaceLayerDependencies,
  ) {
    this.layerSourcePath = path.join(config.stagingRoot, 'custom-layer');
    this.extractionDirectory = path.join(config.stagingRoot, 'extracted');
    this.chown = dependencies.chown ?? ((target, uid, gid) => fs.chown(target, uid, gid));
    this.lchown = dependencies.lchown ?? ((target, uid, gid) => fs.lchown(target, uid, gid));
  }

  /** Builds the custom-layer source tree. Returns its host path. */
  async stage(): Promise<string> {
    if (this.staged) throw new Error('NVX guest layer is already staged');
    await fs.mkdir(this.config.stagingRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.layerSourcePath, { recursive: true, mode: 0o755 });

    for (const exportPlan of this.config.writePlan.exports) {
      await this.stageExport(exportPlan);
    }
    await this.stageGuestHome();
    await this.stageRunScript();
    this.originalState = await this.snapshotWritableHostState();
    this.staged = true;
    return this.layerSourcePath;
  }

  /**
   * Merges the guest's overlay upper layer back into the host. Must only be
   * called after the microVM process has terminated, and before the run
   * directory holding `scratchImagePath` is removed.
   */
  async extractAfterStop(scratchImagePath: string): Promise<NvxWorkspaceCopyBackResult> {
    if (!this.staged || !this.originalState) {
      throw new Error('NVX guest layer has not been staged');
    }
    assertDebugfsOperand(scratchImagePath, 'scratch image');
    await fs.rm(this.extractionDirectory, { recursive: true, force: true });
    await fs.mkdir(this.extractionDirectory, { recursive: true, mode: 0o700 });
    assertDebugfsOperand(this.extractionDirectory, 'extraction directory');

    await this.runTool('e2fsck', ['-f', '-y', scratchImagePath]);
    await this.runTool('debugfs', [
      '-R', `rdump /${NVX_SCRATCH_UPPER_DIRECTORY} ${this.extractionDirectory}`,
      scratchImagePath,
    ]);

    const upperRoot = path.join(this.extractionDirectory, NVX_SCRATCH_UPPER_DIRECTORY);
    const applied: string[] = [];
    const removed: string[] = [];
    const rejected: string[] = [];
    for (const exportEntry of this.config.exports) {
      if (exportEntry.mode !== 'rw') continue;
      await this.mergeTree(
        path.join(upperRoot, exportEntry.target.slice(1)),
        exportEntry,
        { applied, removed, rejected },
      );
    }
    return { applied, removed, rejected };
  }

  async cleanup(): Promise<void> {
    // Read-only staged subtrees have their write bits cleared, so restore them
    // before removing the staging root.
    await restoreWritable(this.config.stagingRoot);
    await fs.rm(this.config.stagingRoot, { recursive: true, force: true });
  }

  private async runTool(tool: NvxWorkspaceTool, args: readonly string[]): Promise<void> {
    const result = await this.dependencies.runTool(tool, args);
    if (result.exitCode === 0) return;
    if (tool === 'e2fsck' && E2FSCK_REPAIR_EXIT_CODES.has(result.exitCode)) return;
    throw new Error(
      `NVX workspace copy-back tool ${tool} exited with code ${result.exitCode}: ` +
      result.stderr.trim(),
    );
  }

  private async stageExport(exportPlan: NvxExportWritePlan): Promise<void> {
    const destination = path.join(
      this.layerSourcePath,
      exportPlan.export.target.slice(1),
    );
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await copySafeTree(exportPlan.export.source, destination, exportPlan.export.source);
    const writableRelativePaths = new Set(
      exportPlan.overlays.map((overlay) => overlay.relativePath),
    );
    await applyStagedOwnership(destination, destination, {
      uid: this.config.uid,
      gid: this.config.gid,
      ownership: exportPlan.stagedOwnership,
      writableRelativePaths,
      chown: this.chown,
      lchown: this.lchown,
    });
  }

  private async stageGuestHome(): Promise<void> {
    const guestHome = path.join(this.layerSourcePath, NVX_GUEST_HOME.slice(1));
    await fs.mkdir(guestHome, { recursive: true, mode: 0o700 });
    await this.chown(guestHome, this.config.uid, this.config.gid);
    if (!this.config.homePath) return;
    for (const toolPath of HOME_TOOL_PATHS) {
      const source = path.join(this.config.homePath, toolPath);
      let stat: Stats;
      try {
        stat = await fs.lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Allowed NVX guest home state must be a real directory: ${source}`);
      }
      const destination = path.join(guestHome, toolPath);
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      await copySafeTree(source, destination, source, (relative) => isExcludedRelativePath(
        `${normalizeRelative(toolPath)}/${relative}`,
      ));
      await applyStagedOwnership(destination, destination, {
        uid: this.config.uid,
        gid: this.config.gid,
        ownership: 'workload',
        writableRelativePaths: new Set(),
        chown: this.chown,
        lchown: this.lchown,
      });
    }
    // Re-assert ownership of the intermediate directories created above.
    await applyStagedOwnership(guestHome, guestHome, {
      uid: this.config.uid,
      gid: this.config.gid,
      ownership: 'workload',
      writableRelativePaths: new Set(),
      directoriesOnly: true,
      chown: this.chown,
      lchown: this.lchown,
    });
  }

  private async stageRunScript(): Promise<void> {
    const scriptPath = path.join(this.layerSourcePath, NVX_GUEST_RUN_SCRIPT.slice(1));
    await fs.mkdir(path.dirname(scriptPath), { recursive: true, mode: 0o755 });
    await fs.writeFile(scriptPath, this.config.runScript, { mode: 0o555 });
    // Root-owned and non-writable so the workload cannot rewrite the script
    // that established its own environment.
    await this.chown(scriptPath, 0, 0);
    await fs.chmod(scriptPath, 0o555);
    await this.chown(path.dirname(scriptPath), 0, 0);
    await fs.chmod(path.dirname(scriptPath), 0o555);
  }

  /**
   * Records a digest of every host entry the guest may write back, so a host
   * process that changed the same entry during the run is detected instead of
   * being silently overwritten.
   */
  private async snapshotWritableHostState(): Promise<Map<string, string>> {
    const state = new Map<string, string>();
    for (const exportEntry of this.config.exports) {
      if (exportEntry.mode !== 'rw') continue;
      await walkSafeTree(exportEntry.source, exportEntry.source, async (absolute, relative, stat) => {
        if (relative === '') return;
        state.set(
          path.posix.join(exportEntry.target, relative),
          await describeHostEntry(absolute, stat),
        );
      });
    }
    return state;
  }

  private async mergeTree(
    upperPath: string,
    exportEntry: NvxDirectoryExport,
    outcome: { applied: string[]; removed: string[]; rejected: string[] },
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(upperPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort()) {
      const childUpperPath = path.join(upperPath, entry);
      const stat = await fs.lstat(childUpperPath);
      const relative = path.relative(
        path.join(this.extractionDirectory, NVX_SCRATCH_UPPER_DIRECTORY, exportEntry.target.slice(1)),
        childUpperPath,
      );
      const guestPath = path.posix.join(exportEntry.target, ...relative.split(path.sep));
      const hostPath = path.join(exportEntry.source, relative);
      if (isExcludedRelativePath(relative.split(path.sep).join('/'))) continue;
      if (guestPath === NVX_GUEST_HOME || guestPath.startsWith(`${NVX_GUEST_HOME}/`)) continue;
      const writable = isNvxWritableGuestPath(this.config.writePlan, guestPath);
      const traverse = stat.isDirectory()
        && hasNvxWritableGuestDescendant(this.config.writePlan, guestPath);
      if (!writable && !traverse) {
        outcome.rejected.push(guestPath);
        continue;
      }
      if (traverse && !writable) {
        await this.mergeTree(childUpperPath, exportEntry, outcome);
        continue;
      }
      await this.assertNoHostConflict(guestPath, hostPath);
      if (isOverlayWhiteout(stat)) {
        await fs.rm(hostPath, { recursive: true, force: true });
        outcome.removed.push(guestPath);
        continue;
      }
      if (stat.isDirectory()) {
        await fs.mkdir(hostPath, { recursive: true, mode: stat.mode & 0o7777 });
        await fs.chmod(hostPath, stat.mode & 0o7777);
        if (!this.originalState!.has(guestPath)) {
          await this.chown(hostPath, this.config.uid, this.config.gid);
        }
        await this.mergeTree(childUpperPath, exportEntry, outcome);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(childUpperPath);
        await fs.rm(hostPath, { recursive: true, force: true });
        await fs.symlink(target, hostPath);
        outcome.applied.push(guestPath);
        continue;
      }
      if (!stat.isFile()) continue;
      await fs.rm(hostPath, { recursive: true, force: true });
      await fs.copyFile(childUpperPath, hostPath);
      await fs.chmod(hostPath, stat.mode & 0o7777);
      await this.chown(hostPath, this.config.uid, this.config.gid);
      outcome.applied.push(guestPath);
    }
  }

  private async assertNoHostConflict(guestPath: string, hostPath: string): Promise<void> {
    const expected = this.originalState!.get(guestPath);
    let actual: string | undefined;
    try {
      const stat = await fs.lstat(hostPath);
      actual = await describeHostEntry(hostPath, stat);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (expected === actual) return;
    throw new Error(
      'NVX workspace copy-back refused: the host changed ' +
      `${guestPath} while the microVM was running`,
    );
  }
}

async function restoreWritable(root: string): Promise<void> {
  try {
    await walkSafeTree(root, root, async (absolute, _relative, stat) => {
      if (stat.isSymbolicLink()) return;
      await fs.chmod(absolute, (stat.mode & 0o7777) | 0o700).catch(() => undefined);
    });
  } catch {
    // Best effort: a missing or unreadable staging root is removed below.
  }
}

function isOverlayWhiteout(stat: Stats): boolean {
  return stat.isCharacterDevice() && stat.rdev === 0;
}

function isExcludedRelativePath(relative: string): boolean {
  return EXCLUDED_RELATIVE_PATHS.some(
    (excluded) => relative === excluded || relative.startsWith(`${excluded}/`),
  );
}

interface StagedOwnershipOptions {
  readonly uid: number;
  readonly gid: number;
  readonly ownership: 'workload' | 'root';
  readonly writableRelativePaths: ReadonlySet<string>;
  readonly directoriesOnly?: boolean;
  readonly chown: (target: string, uid: number, gid: number) => Promise<void>;
  readonly lchown: (target: string, uid: number, gid: number) => Promise<void>;
}

/**
 * Applies the staged ownership/permission policy to a tree.
 *
 * A `root`-owned tree is staged uid/gid 0 with the write bits cleared. The
 * guest workload runs with an empty capability set, so it can neither write
 * those entries nor `chmod` them back: the read-only narrowing survives inside
 * the guest instead of only being enforced at copy-back time. Paths explicitly
 * allowed by `filesystem.allowWrite` are staged workload-owned and writable.
 */
async function applyStagedOwnership(
  root: string,
  current: string,
  options: StagedOwnershipOptions,
): Promise<void> {
  await walkSafeTree(root, current, async (absolute, relative, stat) => {
    const writable = options.ownership === 'workload' || isWritableRelative(
      relative,
      options.writableRelativePaths,
    );
    if (options.directoriesOnly && !stat.isDirectory()) return;
    const uid = writable ? options.uid : 0;
    const gid = options.gid;
    if (stat.isSymbolicLink()) {
      await options.lchown(absolute, uid, gid);
      return;
    }
    await options.chown(absolute, uid, gid);
    const mode = stat.mode & 0o7777;
    await fs.chmod(absolute, writable ? mode | 0o600 : readonlyModeForWorkload(mode));
  });
}

function isWritableRelative(
  relative: string,
  writableRelativePaths: ReadonlySet<string>,
): boolean {
  if (relative === '') return false;
  for (const writable of writableRelativePaths) {
    if (relative === writable || relative.startsWith(`${writable}/`)) return true;
  }
  return false;
}

async function copySafeTree(
  source: string,
  destination: string,
  root: string,
  exclude?: (relativePath: string) => boolean,
): Promise<void> {
  const sourceStat = await fs.lstat(source);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.chmod(destination, sourceStat.mode & 0o7777);
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(source, entry.name);
    const relative = path.relative(root, sourcePath).split(path.sep).join('/');
    if (isExcludedRelativePath(relative)) continue;
    if (exclude?.(relative)) continue;
    const destinationPath = path.join(destination, entry.name);
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(sourcePath), destinationPath);
      continue;
    }
    if (stat.isDirectory()) {
      await copySafeTree(sourcePath, destinationPath, root, exclude);
      await fs.chmod(destinationPath, stat.mode & 0o7777);
      continue;
    }
    if (!stat.isFile()) continue;
    await fs.copyFile(sourcePath, destinationPath);
    await fs.chmod(destinationPath, stat.mode & 0o7777);
  }
}

async function walkSafeTree(
  root: string,
  current: string,
  visit: (absolutePath: string, relativePath: string, stat: Stats) => Promise<void>,
): Promise<void> {
  const stat = await fs.lstat(current);
  await visit(current, path.relative(root, current).split(path.sep).join('/'), stat);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const entries = await fs.readdir(current);
  for (const entry of entries.sort()) {
    await walkSafeTree(root, path.join(current, entry), visit);
  }
}

async function describeHostEntry(absolutePath: string, stat: Stats): Promise<string> {
  const metadata = `${stat.uid}:${stat.gid}:${stat.mode & 0o7777}`;
  if (stat.isSymbolicLink()) return `symlink:${metadata}:${await fs.readlink(absolutePath)}`;
  if (stat.isDirectory()) return `directory:${metadata}`;
  if (stat.isFile()) {
    return `file:${metadata}:${await hashFile(absolutePath)}`;
  }
  return `other:${metadata}`;
}

async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return hash.digest('hex');
}

function readonlyModeForWorkload(mode: number): number {
  const ownerPermissions = (mode & 0o700) >> 3;
  return (mode & ~0o222) | ownerPermissions;
}

function normalizeRelative(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * `debugfs -R` parses its request as a whitespace-separated command, so an
 * operand containing whitespace or quoting would be silently re-interpreted.
 */
function assertDebugfsOperand(value: string, label: string): void {
  if (!path.isAbsolute(value) || /[\s'"\\]/.test(value)) {
    throw new Error(`Unsafe NVX ${label} path for debugfs: ${value}`);
  }
}

/** @internal Exposed for unit tests only. */
// ts-prune-ignore-next
export const testHelpers = {
  isOverlayWhiteout,
  E2FSCK_REPAIR_EXIT_CODES,
};
