import { createHash } from 'crypto';
import { createReadStream, promises as fs, type Stats } from 'fs';
import * as path from 'path';
import execa from 'execa';
import {
  CREDENTIAL_ENTRIES,
  HOME_TOOL_SUBDIRS,
} from '../config/mount-policy';

const MIB = 1024 * 1024;
export const MICROVM_MIN_WORKSPACE_IMAGE_BYTES = 256 * MIB;
export const MICROVM_DEFAULT_MAX_WORKSPACE_IMAGE_BYTES = 8 * 1024 * MIB;
const WORKSPACE_IMAGE_HEADROOM_BYTES = 128 * MIB;
const WORKSPACE_BLOCK_BYTES = 4096;
const E2FSCK_REPAIR_EXIT_CODE = 1;

/** Minimal host tool paths this module needs; a structural subset so callers
 * (e.g. Firecracker's preflight-derived tool paths) can pass their own
 * richer tool-path record without this module depending on it. */
export interface MicrovmWorkspaceHostTools {
  readonly mke2fs: string;
  readonly debugfs: string;
  readonly e2fsck: string;
  readonly rsync: string;
}

export interface MicrovmWorkspaceImageConfig {
  readonly runId: string;
  readonly workDir: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly baseRootfsPath: string;
  readonly supervisorBinaryPath: string;
  readonly supervisorSha256: string;
  readonly maxImageBytes?: number;
  readonly uid: number;
  readonly gid: number;
}

export interface MicrovmWorkspaceManifestEntry {
  readonly type: 'file' | 'directory' | 'symlink';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly digest?: string;
  readonly target?: string;
}

export type MicrovmWorkspaceManifest = ReadonlyMap<
  string,
  MicrovmWorkspaceManifestEntry
>;

export interface MicrovmWorkspaceImageDependencies {
  runTool(command: string, args: readonly string[]): Promise<void>;
}

const defaultDependencies: MicrovmWorkspaceImageDependencies = {
  runTool: async (command, args) => {
    const result = await execa(command, [...args], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    if (result.exitCode === 0) return;
    if (
      (command === 'e2fsck' || command.endsWith('/e2fsck')) &&
      result.exitCode === E2FSCK_REPAIR_EXIT_CODE
    ) return;
    throw new Error(
      `${command} exited with code ${result.exitCode}: ` +
      `${result.stderr.trim() || result.stdout.trim()}`,
    );
  },
};

export interface MicrovmWorkspacePreparation {
  readonly workspaceImagePath: string;
  readonly rootfsImagePath: string;
  readonly imageBytes: number;
  readonly originalManifest: MicrovmWorkspaceManifest;
}

/**
 * Owns the host-only population and post-stop extraction of one writable image.
 */
export class MicrovmWorkspaceImage {
  readonly runDirectory: string;
  readonly stagingDirectory: string;
  readonly workspaceImagePath: string;
  readonly rootfsImagePath: string;
  readonly recoveryImagePath: string;
  private originalManifest: MicrovmWorkspaceManifest | undefined;
  private prepared = false;
  private extractionSucceeded = false;
  private recoveryPreserved = false;

  constructor(
    private readonly config: MicrovmWorkspaceImageConfig,
    private readonly dependencies: MicrovmWorkspaceImageDependencies = defaultDependencies,
    private readonly tools?: MicrovmWorkspaceHostTools,
  ) {
    assertSafeRunId(config.runId);
    this.runDirectory = path.join(config.workDir, 'firecracker-images', config.runId);
    this.stagingDirectory = path.join(this.runDirectory, 'staging');
    this.workspaceImagePath = path.join(this.runDirectory, 'workspace.ext4');
    this.rootfsImagePath = path.join(this.runDirectory, 'rootfs.ext4');
    this.recoveryImagePath = path.join(
      config.workspacePath,
      '.awf-firecracker-recovery',
      `${config.runId}-workspace.ext4`,
    );
  }

  private runTool(
    command: 'mke2fs' | 'debugfs' | 'e2fsck' | 'rsync',
    args: readonly string[],
  ): Promise<void> {
    return this.dependencies.runTool(this.tools?.[command] ?? command, args);
  }

  async prepare(): Promise<MicrovmWorkspacePreparation> {
    if (this.prepared) throw new Error('microVM workspace image is already prepared');
    await fs.mkdir(path.join(this.stagingDirectory, 'workspace'), {
      recursive: true,
      mode: 0o700,
    });
    await fs.mkdir(path.join(this.stagingDirectory, 'workspace', '.awf-home'), {
      recursive: true,
      mode: 0o700,
    });
    await applySafeOwnership(
      path.join(this.stagingDirectory, 'workspace'),
      this.config.uid,
      this.config.gid,
    );
    await applySafeOwnership(
      path.join(this.stagingDirectory, 'workspace', '.awf-home'),
      this.config.uid,
      this.config.gid,
    );
    try {
      await fs.lstat(path.join(this.config.workspacePath, '.awf-home'));
      throw new Error(
        'Workspace contains reserved microVM guest home path: .awf-home',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await copySafeTree(
      this.config.workspacePath,
      path.join(this.stagingDirectory, 'workspace'),
      this.config.workspacePath,
      this.config.uid,
      this.config.gid,
    );
    await this.copyAllowedHomeState();
    this.originalManifest = await buildMicrovmWorkspaceManifest(this.config.workspacePath);

    const imageRoot = path.join(this.stagingDirectory, 'workspace');
    const stagingUsage = await calculateTreeUsage(imageRoot);
    const imageBytes = calculateMicrovmWorkspaceImageBytes(
      stagingUsage.bytes + stagingUsage.entries * WORKSPACE_BLOCK_BYTES,
      this.config.maxImageBytes,
    );
    const inodeCount = Math.max(8192, Math.ceil(stagingUsage.entries * 1.25) + 1024);
    const workspaceImage = await fs.open(this.workspaceImagePath, 'wx', 0o600);
    try {
      await workspaceImage.truncate(imageBytes);
    } finally {
      await workspaceImage.close();
    }
    await this.runTool('mke2fs', [
      '-t', 'ext4',
      '-F',
      '-q',
      '-b', String(WORKSPACE_BLOCK_BYTES),
      '-N', String(inodeCount),
      '-d', imageRoot,
      this.workspaceImagePath,
      String(imageBytes / WORKSPACE_BLOCK_BYTES),
    ]);

    await this.prepareRootfs();
    this.prepared = true;
    return {
      workspaceImagePath: this.workspaceImagePath,
      rootfsImagePath: this.rootfsImagePath,
      imageBytes,
      originalManifest: this.originalManifest,
    };
  }

  /**
   * Must only be called after the microVM process has terminated.
   */
  async extractAfterStop(changedImagePath = this.workspaceImagePath): Promise<void> {
    if (!this.prepared || !this.originalManifest) {
      throw new Error('microVM workspace image has not been prepared');
    }
    if (this.extractionSucceeded) return;
    const extractionDirectory = path.join(this.runDirectory, 'extracted');
    try {
      await fs.rm(extractionDirectory, { recursive: true, force: true });
      await fs.mkdir(extractionDirectory, { recursive: true, mode: 0o700 });
      assertDebugfsOperand(extractionDirectory, 'extraction directory');
      await this.runTool('e2fsck', ['-f', '-y', changedImagePath]);
      await this.runTool('debugfs', [
        '-R', `rdump / ${extractionDirectory}`,
        changedImagePath,
      ]);
      await fs.rm(path.join(extractionDirectory, '.awf-home'), {
        recursive: true,
        force: true,
      });
      await fs.rm(path.join(extractionDirectory, 'lost+found'), {
        recursive: true,
        force: true,
      });
      const guestWorkspace = extractionDirectory;
      const guestManifest = await buildMicrovmWorkspaceManifest(guestWorkspace);
      const currentManifest = await buildMicrovmWorkspaceManifest(this.config.workspacePath);
      assertNoWorkspaceConflicts(this.originalManifest, guestManifest, currentManifest);
      await this.applyWorkspaceUpdateAtomically(guestWorkspace, guestManifest);
      this.extractionSucceeded = true;
    } catch (error) {
      await this.preserveRecoveryImage(changedImagePath);
      throw new Error(
        `microVM workspace copy-back failed; changed image preserved at ` +
        `${this.recoveryImagePath}: ${formatError(error)}`,
      );
    }
  }

  async cleanup(discardUnstarted = false): Promise<void> {
    if (
      this.prepared &&
      !discardUnstarted &&
      !this.extractionSucceeded &&
      !this.recoveryPreserved
    ) {
      return;
    }
    await fs.rm(this.runDirectory, { recursive: true, force: true });
  }

  private async copyAllowedHomeState(): Promise<void> {
    const excluded = CREDENTIAL_ENTRIES.map((entry) => normalizeRelative(entry.path));
    for (const subdir of HOME_TOOL_SUBDIRS) {
      const source = path.join(this.config.homePath, subdir);
      let stat;
      try {
        stat = await fs.lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Allowed home state must be a real directory: ${source}`);
      }
      const destination = path.join(
        this.stagingDirectory,
        'workspace',
        '.awf-home',
        subdir,
      );
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      await applySafeOwnership(destination, this.config.uid, this.config.gid);
      await copySafeTree(
        source,
        destination,
        this.config.homePath,
        this.config.uid,
        this.config.gid,
        (relativeHomePath) => excluded.some((credentialPath) => (
          relativeHomePath === credentialPath ||
          relativeHomePath.startsWith(`${credentialPath}/`)
        )),
      );
    }
  }

  private async prepareRootfs(): Promise<void> {
    await assertRegularFile(this.config.baseRootfsPath, 'microVM base rootfs');
    await assertRegularFile(this.config.supervisorBinaryPath, 'guest supervisor');
    if (!/^[A-Fa-f0-9]{64}$/.test(this.config.supervisorSha256)) {
      throw new Error('guest supervisor SHA-256 must be 64 hexadecimal characters');
    }
    const actual = await sha256File(this.config.supervisorBinaryPath);
    if (actual !== this.config.supervisorSha256.toLowerCase()) {
      throw new Error(
        `guest supervisor SHA-256 mismatch: expected ` +
        `${this.config.supervisorSha256.toLowerCase()}, got ${actual}`,
      );
    }
    await fs.copyFile(this.config.baseRootfsPath, this.rootfsImagePath);
    const localSupervisor = path.join(this.runDirectory, 'awf-supervisor');
    await fs.copyFile(this.config.supervisorBinaryPath, localSupervisor);
    await fs.chmod(localSupervisor, 0o500);
    assertDebugfsOperand(localSupervisor, 'supervisor staging path');
    await this.runTool('debugfs', [
      '-w',
      '-R', 'rm /sbin/awf-supervisor',
      this.rootfsImagePath,
    ]);
    await this.dependencies.runTool('debugfs', [
      '-w',
      '-R', `write ${localSupervisor} /sbin/awf-supervisor`,
      this.rootfsImagePath,
    ]);
    await this.runTool('debugfs', [
      '-w',
      '-R', 'sif /sbin/awf-supervisor mode 0100755',
      this.rootfsImagePath,
    ]);
    await this.runTool('e2fsck', ['-f', '-y', this.rootfsImagePath]);
  }

  private async preserveRecoveryImage(changedImagePath: string): Promise<void> {
    if (this.recoveryPreserved) return;
    await fs.mkdir(path.dirname(this.recoveryImagePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.recoveryImagePath}.tmp-${process.pid}`;
    await fs.copyFile(changedImagePath, temporary);
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.recoveryImagePath);
    this.recoveryPreserved = true;
  }

  private async applyWorkspaceUpdateAtomically(
    guestWorkspace: string,
    guestManifest: MicrovmWorkspaceManifest,
  ): Promise<void> {
    const workspaceParent = path.dirname(this.config.workspacePath);
    const workspaceName = path.basename(this.config.workspacePath);
    const mergeDirectory = path.join(
      workspaceParent,
      `.${workspaceName}.awf-merge-${this.config.runId}`,
    );
    const backupDirectory = path.join(
      workspaceParent,
      `.${workspaceName}.awf-backup-${this.config.runId}`,
    );
    await fs.rm(mergeDirectory, { recursive: true, force: true });
    await fs.rm(backupDirectory, { recursive: true, force: true });
    await fs.mkdir(mergeDirectory, { recursive: true, mode: 0o700 });
    await this.runTool('rsync', [
      '-a',
      '--delete',
      '--safe-links',
      `${guestWorkspace}${path.sep}`,
      `${mergeDirectory}${path.sep}`,
    ]);
    const stagedManifest = await buildMicrovmWorkspaceManifest(mergeDirectory);
    assertExactWorkspaceManifest(guestManifest, stagedManifest, 'staged workspace');
    const latestManifest = await buildMicrovmWorkspaceManifest(this.config.workspacePath);
    assertNoWorkspaceConflicts(this.originalManifest!, guestManifest, latestManifest);

    let backupPending = false;
    try {
      await fs.rename(this.config.workspacePath, backupDirectory);
      backupPending = true;
      await fs.rename(mergeDirectory, this.config.workspacePath);
      backupPending = false;
    } catch (error) {
      if (backupPending) {
        try {
          await fs.rename(backupDirectory, this.config.workspacePath);
          backupPending = false;
        } catch {
          // keep original failure message from the copy-back path
        }
      }
      throw error;
    } finally {
      await fs.rm(mergeDirectory, { recursive: true, force: true });
      if (!backupPending) {
        await fs.rm(backupDirectory, { recursive: true, force: true });
      }
    }
  }
}

export function calculateMicrovmWorkspaceImageBytes(
  contentBytes: number,
  maximumBytes = MICROVM_DEFAULT_MAX_WORKSPACE_IMAGE_BYTES,
): number {
  if (!Number.isSafeInteger(contentBytes) || contentBytes < 0) {
    throw new Error(`Invalid microVM workspace content size: ${contentBytes}`);
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < MICROVM_MIN_WORKSPACE_IMAGE_BYTES
  ) {
    throw new Error(
      `microVM workspace image cap must be at least ` +
      `${MICROVM_MIN_WORKSPACE_IMAGE_BYTES} bytes`,
    );
  }
  const withHeadroom = Math.ceil(contentBytes * 1.25) +
    WORKSPACE_IMAGE_HEADROOM_BYTES;
  const requested = Math.max(MICROVM_MIN_WORKSPACE_IMAGE_BYTES, withHeadroom);
  const aligned = Math.ceil(requested / WORKSPACE_BLOCK_BYTES) *
    WORKSPACE_BLOCK_BYTES;
  if (aligned > maximumBytes) {
    throw new Error(
      `microVM workspace requires ${aligned} bytes, exceeding cap ${maximumBytes}`,
    );
  }
  return aligned;
}

export async function buildMicrovmWorkspaceManifest(
  root: string,
): Promise<MicrovmWorkspaceManifest> {
  const manifest = new Map<string, MicrovmWorkspaceManifestEntry>();
  await walkSafeTree(root, root, async (absolutePath, relativePath, stat) => {
    if (relativePath === '') return;
    const mode = stat.mode & 0o7777;
    if (stat.isDirectory()) {
      manifest.set(relativePath, {
        type: 'directory',
        mode,
        uid: stat.uid,
        gid: stat.gid,
        size: 0,
      });
    } else if (stat.isFile()) {
      manifest.set(relativePath, {
        type: 'file',
        mode,
        uid: stat.uid,
        gid: stat.gid,
        size: stat.size,
        digest: await sha256File(absolutePath),
      });
    } else if (stat.isSymbolicLink()) {
      manifest.set(relativePath, {
        type: 'symlink',
        mode,
        uid: stat.uid,
        gid: stat.gid,
        size: stat.size,
        target: await fs.readlink(absolutePath),
      });
    }
  });
  return manifest;
}

export function assertNoWorkspaceConflicts(
  original: MicrovmWorkspaceManifest,
  guest: MicrovmWorkspaceManifest,
  current: MicrovmWorkspaceManifest,
): void {
  const paths = new Set([...original.keys(), ...guest.keys(), ...current.keys()]);
  const conflicts: string[] = [];
  for (const relativePath of paths) {
    const before = original.get(relativePath);
    const after = guest.get(relativePath);
    const live = current.get(relativePath);
    if (entriesEqual(before, after)) {
      if (!entriesEqual(before, live)) conflicts.push(relativePath);
      continue;
    }
    if (!entriesEqual(before, live) && !entriesEqual(after, live)) conflicts.push(relativePath);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Workspace changed concurrently at ${conflicts.slice(0, 20).join(', ')}` +
      (conflicts.length > 20 ? ` and ${conflicts.length - 20} more paths` : ''),
    );
  }
}

async function copySafeTree(
  source: string,
  destination: string,
  safetyRoot: string,
  uid: number,
  gid: number,
  exclude: (relativeToSafetyRoot: string) => boolean = () => false,
): Promise<void> {
  await walkSafeTree(source, safetyRoot, async (absolutePath, relativePath, stat) => {
    if (relativePath === '') return;
    if (exclude(relativePath)) return 'skip';
    const relativeToSource = path.relative(source, absolutePath);
    const target = path.join(destination, relativeToSource);
    assertContained(destination, target, 'workspace staging destination');
    if (stat.isDirectory()) {
      await fs.mkdir(target, { recursive: true, mode: stat.mode & 0o7777 });
      await fs.chmod(target, stat.mode & 0o7777);
      await applySafeOwnership(target, uid, gid);
    } else if (stat.isFile()) {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(absolutePath, target);
      await fs.chmod(target, stat.mode & 0o7777);
      await applySafeOwnership(target, uid, gid);
      await fs.utimes(target, stat.atime, stat.mtime);
    } else if (stat.isSymbolicLink()) {
      const linkTarget = await fs.readlink(absolutePath);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.symlink(linkTarget, target);
      await applySafeOwnership(target, uid, gid, true);
    }
  });
}

type WalkResult = void | 'skip';

async function walkSafeTree(
  root: string,
  safetyRoot: string,
  visitor: (
    absolutePath: string,
    relativePath: string,
    stat: Stats,
  ) => Promise<WalkResult>,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedSafetyRoot = path.resolve(safetyRoot);
  assertContained(resolvedSafetyRoot, resolvedRoot, 'tree root');
  const walk = async (current: string): Promise<void> => {
    const stat = await fs.lstat(current);
    const relativePath = normalizeRelative(path.relative(resolvedSafetyRoot, current));
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(current);
      if (path.isAbsolute(target)) {
        throw new Error(`Absolute symlink is not safe for microVM workspace: ${current}`);
      }
      assertContained(
        resolvedSafetyRoot,
        path.resolve(path.dirname(current), target),
        `symlink target for ${current}`,
      );
    } else if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Special filesystem entry is not safe for microVM workspace: ${current}`);
    }
    const result = await visitor(current, relativePath, stat);
    if (!stat.isDirectory() || result === 'skip') return;
    const entries = await fs.readdir(current);
    entries.sort();
    for (const entry of entries) await walk(path.join(current, entry));
  };
  await walk(resolvedRoot);
}

async function calculateTreeUsage(root: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  await walkSafeTree(root, root, async (_absolutePath, relativePath, stat) => {
    if (!relativePath) return;
    entries += 1;
    if (stat.isFile()) bytes += stat.size;
  });
  return { bytes, entries };
}

function entriesEqual(
  left: MicrovmWorkspaceManifestEntry | undefined,
  right: MicrovmWorkspaceManifestEntry | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExactWorkspaceManifest(
  expected: MicrovmWorkspaceManifest,
  actual: MicrovmWorkspaceManifest,
  label: string,
): void {
  const mismatches: string[] = [];
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  for (const relativePath of paths) {
    if (!entriesEqual(expected.get(relativePath), actual.get(relativePath))) {
      mismatches.push(relativePath);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `microVM ${label} diverged during staging at ${mismatches.slice(0, 20).join(', ')}` +
      (mismatches.length > 20 ? ` and ${mismatches.length - 20} more paths` : ''),
    );
  }
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join('/');
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes ${root}: ${candidate}`);
  }
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) {
    throw new Error(`Unsafe microVM workspace run id: ${runId}`);
  }
}

function assertDebugfsOperand(value: string, label: string): void {
  if (/[\s"'\\;`\r\n]/.test(value)) {
    throw new Error(`microVM ${label} is unsafe for debugfs commands: ${value}`);
  }
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

async function applySafeOwnership(
  target: string,
  uid: number,
  gid: number,
  symbolicLink = false,
): Promise<void> {
  if (
    !Number.isInteger(uid) ||
    uid <= 0 ||
    !Number.isInteger(gid) ||
    gid <= 0 ||
    uid > 0xffff_ffff ||
    gid > 0xffff_ffff
  ) {
    throw new Error(`Invalid microVM workspace identity: ${uid}:${gid}`);
  }
  const currentUid = process.getuid?.();
  const currentGid = process.getgid?.();
  if (currentUid !== 0 && (currentUid !== uid || currentGid !== gid)) {
    throw new Error(
      `Cannot map microVM workspace ownership to ${uid}:${gid} as ` +
      `${String(currentUid)}:${String(currentGid)}`,
    );
  }
  if (symbolicLink) await fs.lchown(target, uid, gid);
  else await fs.chown(target, uid, gid);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
