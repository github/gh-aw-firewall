import { createHash, randomUUID } from 'crypto';
import {
  constants,
  createReadStream,
  createWriteStream,
  promises as fs,
  type Stats,
} from 'fs';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import execa from 'execa';
import { pipeline } from 'stream/promises';
import { CREDENTIAL_ENTRIES, HOME_FORBIDDEN_SUBDIRS } from '../config/mount-policy';
import { createNvxRunLayout } from './run-layout';

const MIB = 1024 * 1024;
const NVX_BLOCK_BYTES = 4096;
export const NVX_MIN_SCRATCH_BYTES = 128 * MIB;
export const NVX_DEFAULT_MAX_SCRATCH_BYTES = 8 * 1024 * MIB;
export const NVX_LAYER_ROLES = ['distro', 'runtime', 'custom'] as const;
export type NvxLayerRole = typeof NVX_LAYER_ROLES[number];

export interface NvxLayerSource {
  readonly role: NvxLayerRole;
  readonly sourcePath: string;
  readonly exclude?: readonly string[];
  /**
   * Merges this source with its own uid/gid instead of flattening it to root.
   *
   * The AWF-owned configuration source uses this to retain the workload ownership of
   * allowed guest-home state while keeping the generated run script root-owned.
   */
  readonly preserveOwnership?: boolean;
}

export interface NvxLayerSourceManifestEntry {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly mode: number;
  readonly size: number;
  readonly sha256?: string;
  readonly target?: string;
  readonly uid?: number;
  readonly gid?: number;
}

export interface NvxLayerArtifact {
  readonly role: NvxLayerRole;
  readonly path: string;
  readonly uuid: string;
  readonly sha256: string;
  readonly sourceManifestSha256: string;
  readonly sourceEntries: number;
  readonly excludedPaths: readonly string[];
}

export interface NvxScratchArtifact {
  readonly path: string;
  readonly uuid: string;
  readonly sizeBytes: number;
  readonly uid: number;
  readonly gid: number;
}

export interface NvxFilesystemBundle {
  readonly runDirectory: string;
  readonly manifestPath: string;
  readonly sourceDateEpoch: number;
  readonly layers: readonly NvxLayerArtifact[];
  readonly scratch: NvxScratchArtifact;
}

export interface NvxFilesystemBuilderConfig {
  readonly runId: string;
  readonly workDir: string;
  /**
   * Stages the bundle directly in the canonical per-run directory
   * (`/var/lib/awf-nvx/runs/<runId>`) that the Phase 3b launch plan binds into the
   * Bubblewrap jail. Defaults to `<workDir>/nvx-images/<runId>`.
   */
  readonly useCanonicalRunDirectory?: boolean;
  readonly layers: readonly NvxLayerSource[];
  readonly scratchBytes?: number;
  readonly maxScratchBytes?: number;
  readonly scratchUid?: number;
  readonly scratchGid?: number;
  readonly sourceDateEpoch?: number;
}

export interface NvxFilesystemBuilderDependencies {
  runTool(command: string, args: readonly string[]): Promise<void>;
  randomUuid(): string;
  sha256(filePath: string): Promise<string>;
}

const defaultDependencies: NvxFilesystemBuilderDependencies = {
  runTool: async (command, args) => {
    const result = await execa(command, [...args], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    if (result.exitCode === 0) return;
    throw new Error(
      `${command} exited with code ${result.exitCode}: ` +
      `${result.stderr.trim() || result.stdout.trim()}`,
    );
  },
  randomUuid: randomUUID,
  sha256: sha256File,
};

interface StagedLayer {
  readonly role: NvxLayerRole;
  readonly stagingPath: string;
  readonly sourceManifestSha256: string;
  readonly sourceEntries: number;
  readonly excludedPaths: readonly string[];
}

const DEFAULT_EXCLUDED_PATHS = [
  ...CREDENTIAL_ENTRIES.map(({ path: entryPath }) => normalizeRelative(entryPath)),
  ...HOME_FORBIDDEN_SUBDIRS.map(normalizeRelative),
];

/**
 * Merges deterministic sources into one immutable distro EROFS image and builds
 * a fresh private ext4 scratch image. Legacy runtime/custom roles are source
 * precedence only (distro, runtime, custom), never separate guest roots.
 */
export class NvxFilesystemBuilder {
  readonly runDirectory: string;
  readonly stagingDirectory: string;
  readonly manifestPath: string;

  private prepared = false;
  private ownsRunDirectory = false;

  constructor(
    private readonly config: NvxFilesystemBuilderConfig,
    private readonly dependencies: NvxFilesystemBuilderDependencies = defaultDependencies,
  ) {
    assertSafeRunId(config.runId);
    assertLayerSources(config.layers);
    this.runDirectory = config.useCanonicalRunDirectory
      ? createNvxRunLayout(config.runId).runDirectory
      : path.join(config.workDir, 'nvx-images', config.runId);
    this.stagingDirectory = path.join(this.runDirectory, 'staging');
    this.manifestPath = path.join(this.runDirectory, 'manifest.json');
  }

  async prepare(): Promise<NvxFilesystemBundle> {
    if (this.prepared) throw new Error('NVX filesystem bundle is already prepared');
    const sourceDateEpoch = this.config.sourceDateEpoch ?? 0;
    assertSourceDateEpoch(sourceDateEpoch);
    const scratchUid = this.config.scratchUid ?? 65534;
    const scratchGid = this.config.scratchGid ?? 65534;
    assertNonRootIdentity(scratchUid, scratchGid);
    const scratchBytes = normalizeScratchBytes(
      this.config.scratchBytes ?? NVX_MIN_SCRATCH_BYTES,
      this.config.maxScratchBytes ?? NVX_DEFAULT_MAX_SCRATCH_BYTES,
    );

    const imageRoot = path.dirname(this.runDirectory);
    await fs.mkdir(imageRoot, { recursive: true, mode: 0o700 });
    const imageRootStat = await fs.lstat(imageRoot);
    if (!imageRootStat.isDirectory() || imageRootStat.isSymbolicLink()) {
      throw new Error(`NVX image root must be a real directory: ${imageRoot}`);
    }
    await fs.chmod(imageRoot, 0o700);
    try {
      await fs.mkdir(this.runDirectory, { mode: 0o700 });
      this.ownsRunDirectory = true;
      await fs.mkdir(this.stagingDirectory, { mode: 0o700 });
      const stagingPath = path.join(this.stagingDirectory, 'distro');
      await fs.mkdir(stagingPath, { mode: 0o755 });
      const sources: StagedLayer[] = [];
      for (const source of orderedLayerSources(this.config.layers)) {
        sources.push(await this.stageLayer(source, stagingPath));
      }
      const layers = [await this.buildLayer({
        role: 'distro',
        stagingPath,
        sourceManifestSha256: sha256Text(JSON.stringify(sources.map((source) => ({
          role: source.role,
          sha256: source.sourceManifestSha256,
        })))),
        sourceEntries: sources.reduce((total, source) => total + source.sourceEntries, 0),
        excludedPaths: [...new Set(sources.flatMap((source) => source.excludedPaths))].sort(),
      }, sourceDateEpoch)];
      const scratch = await this.buildScratch(scratchBytes, scratchUid, scratchGid);
      const manifest = {
        schemaVersion: 1,
        sourceDateEpoch,
        layers: layers.map((layer) => ({
          role: layer.role,
          file: path.basename(layer.path),
          uuid: layer.uuid,
          sha256: layer.sha256,
          sourceManifestSha256: layer.sourceManifestSha256,
          sourceEntries: layer.sourceEntries,
          excludedPaths: layer.excludedPaths,
        })),
        scratch: {
          file: path.basename(scratch.path),
          uuid: scratch.uuid,
          sizeBytes: scratch.sizeBytes,
          uid: scratch.uid,
          gid: scratch.gid,
        },
      };
      await writeExclusiveJson(this.manifestPath, manifest, 0o400);
      this.prepared = true;
      return {
        runDirectory: this.runDirectory,
        manifestPath: this.manifestPath,
        sourceDateEpoch,
        layers,
        scratch,
      };
    } catch (error) {
      if (this.ownsRunDirectory) {
        await fs.rm(this.runDirectory, { recursive: true, force: true });
        this.ownsRunDirectory = false;
      }
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (!this.ownsRunDirectory) return;
    await fs.rm(this.runDirectory, { recursive: true, force: true });
    this.ownsRunDirectory = false;
  }

  private async stageLayer(
    source: NvxLayerSource,
    stagingPath: string,
  ): Promise<StagedLayer> {
    const sourcePath = path.resolve(source.sourcePath);
    const sourceStat = await fs.lstat(sourcePath);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`NVX ${source.role} layer source must be a real directory: ${sourcePath}`);
    }
    const stagingRelative = path.relative(sourcePath, this.stagingDirectory);
    if (!stagingRelative.startsWith(`..${path.sep}`) && stagingRelative !== '..') {
      throw new Error('NVX layer source must not contain the staging directory');
    }
    const excludedPaths = normalizeExcludedPaths([
      ...DEFAULT_EXCLUDED_PATHS,
      ...(source.exclude ?? []),
    ]);
    const entries: NvxLayerSourceManifestEntry[] = [];
    await copyDeterministicTree(
      sourcePath,
      stagingPath,
      excludedPaths,
      entries,
      this.config.sourceDateEpoch ?? 0,
      source.preserveOwnership ?? false,
      source.role === 'distro',
    );
    const sourceManifestSha256 = sha256Text(JSON.stringify({
      role: source.role,
      excludedPaths,
      entries,
    }));
    return {
      role: source.role,
      stagingPath,
      sourceManifestSha256,
      sourceEntries: entries.length,
      excludedPaths,
    };
  }

  private async buildLayer(
    staged: StagedLayer,
    sourceDateEpoch: number,
  ): Promise<NvxLayerArtifact> {
    const uuid = deriveNvxLayerUuid(staged.role, staged.sourceManifestSha256);
    const imagePath = path.join(this.runDirectory, `${staged.role}.erofs`);
    await this.dependencies.runTool('mkfs.erofs', [
      '--quiet',
      '-E', 'force-inode-compact',
      '-T', String(sourceDateEpoch),
      '-U', uuid,
      imagePath,
      staged.stagingPath,
    ]);
    await assertRegularFile(imagePath, `NVX ${staged.role} layer image`);
    await fs.chmod(imagePath, 0o400);
    return {
      role: staged.role,
      path: imagePath,
      uuid,
      sha256: await this.dependencies.sha256(imagePath),
      sourceManifestSha256: staged.sourceManifestSha256,
      sourceEntries: staged.sourceEntries,
      excludedPaths: staged.excludedPaths,
    };
  }

  private async buildScratch(
    sizeBytes: number,
    uid: number,
    gid: number,
  ): Promise<NvxScratchArtifact> {
    const scratchPath = path.join(this.runDirectory, 'scratch.ext4');
    const handle = await fs.open(scratchPath, 'wx', 0o600);
    try {
      await handle.truncate(sizeBytes);
    } finally {
      await handle.close();
    }
    const uuid = this.dependencies.randomUuid();
    assertUuid(uuid, 'NVX scratch UUID');
    await this.dependencies.runTool('mke2fs', [
      '-t', 'ext4',
      '-F',
      '-q',
      '-b', String(NVX_BLOCK_BYTES),
      '-m', '0',
      '-L', 'awf-nvx-scratch',
      '-U', uuid,
      '-O', '^has_journal',
      '-E', `lazy_itable_init=0,lazy_journal_init=0,root_owner=${uid}:${gid}`,
      scratchPath,
      String(sizeBytes / NVX_BLOCK_BYTES),
    ]);
    await fs.chmod(scratchPath, 0o600);
    return {
      path: scratchPath,
      uuid,
      sizeBytes,
      uid,
      gid,
    };
  }
}

export function deriveNvxLayerUuid(
  role: NvxLayerRole,
  sourceManifestSha256: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(sourceManifestSha256)) {
    throw new Error('NVX layer source manifest digest must be a lowercase SHA-256 value');
  }
  const bytes = createHash('sha256')
    .update(`awf-nvx-layer-v1\0${role}\0${sourceManifestSha256}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function normalizeScratchBytes(
  requestedBytes: number,
  maximumBytes = NVX_DEFAULT_MAX_SCRATCH_BYTES,
): number {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < NVX_MIN_SCRATCH_BYTES
  ) {
    throw new Error(
      `NVX scratch cap must be at least ${NVX_MIN_SCRATCH_BYTES} bytes`,
    );
  }
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
    throw new Error(`Invalid NVX scratch size: ${requestedBytes}`);
  }
  const normalized = Math.max(NVX_MIN_SCRATCH_BYTES, requestedBytes);
  const aligned = Math.ceil(normalized / NVX_BLOCK_BYTES) * NVX_BLOCK_BYTES;
  if (aligned > maximumBytes) {
    throw new Error(`NVX scratch requires ${aligned} bytes, exceeding cap ${maximumBytes}`);
  }
  return aligned;
}

async function copyDeterministicTree(
  sourceRoot: string,
  destinationRoot: string,
  excludedPaths: readonly string[],
  manifest: NvxLayerSourceManifestEntry[],
  sourceDateEpoch: number,
  preserveOwnership = false,
  includeRoot = true,
): Promise<void> {
  await assertDescriptorTraversalSupport();
  const root = await openDirectoryNoFollow(sourceRoot);
  try {
    await copyDirectory(root, '');
  } finally {
    await root.close();
  }

  async function copyDirectory(directory: FileHandle, relativePath: string): Promise<void> {
    const current = descriptorPath(directory);
    if (relativePath || includeRoot) {
      const destination = stagingPath(destinationRoot, relativePath);
      const stat = await directory.stat();
      const mode = normalizedMode(stat);
      await prepareDestination(destination, true);
      await fs.chmod(destination, mode);
      const ownership = await applyOwnership(destination, stat, false);
      manifest.push({ path: relativePath, type: 'directory', mode, size: 0, ...ownership });
    }
    const before = await directory.stat();
    const children = await fs.readdir(current);
    children.sort();
    for (const child of children) {
      const childPath = path.join(current, child);
      const childRelativePath = relativePath ? `${relativePath}/${child}` : child;
      if (isExcluded(childRelativePath, excludedPaths)) continue;
      const stat = await fs.lstat(childPath);
      const destination = stagingPath(destinationRoot, childRelativePath);
      if (stat.isSymbolicLink()) {
        const sourceTarget = await fs.readlink(childPath);
        const target = normalizeNvxLayerSymlinkTarget(childRelativePath, sourceTarget);
        assertContained(
          sourceRoot,
          path.resolve(sourceRoot, path.dirname(childRelativePath), target),
          `NVX layer symlink target for ${childRelativePath}`,
        );
        const after = await fs.lstat(childPath);
        assertSourceUnchanged(stat, after, childRelativePath);
        await prepareDestination(destination, false);
        await fs.symlink(target, destination);
        await fs.lutimes(destination, sourceDateEpoch, sourceDateEpoch);
        const ownership = await applyOwnership(destination, stat, true);
        manifest.push({
          path: childRelativePath,
          type: 'symlink',
          mode: stat.mode & 0o777,
          size: Buffer.byteLength(target),
          target,
          ...ownership,
        });
      } else if (stat.isDirectory()) {
        const childDirectory = await openDirectoryNoFollow(childPath);
        try {
          assertSourceUnchanged(stat, await childDirectory.stat(), childRelativePath);
          await copyDirectory(childDirectory, childRelativePath);
        } finally {
          await childDirectory.close();
        }
      } else if (stat.isFile()) {
        await copyRegularFile(childPath, destination, stat, childRelativePath);
      } else {
        throw new Error(`Special filesystem entry is not safe for NVX layer: ${childRelativePath}`);
      }
    }
    assertSourceUnchanged(before, await directory.stat(), relativePath || '/');
    await fs.utimes(stagingPath(destinationRoot, relativePath), sourceDateEpoch, sourceDateEpoch);
  }

  async function applyOwnership(
    destination: string,
    stat: Pick<Stats, 'uid' | 'gid'>,
    symbolicLink: boolean,
  ): Promise<{ uid?: number; gid?: number }> {
    const uid = preserveOwnership ? stat.uid : 0;
    const gid = preserveOwnership ? stat.gid : 0;
    if (symbolicLink) await fs.lchown(destination, uid, gid);
    else await fs.chown(destination, uid, gid);
    return { uid, gid };
  }

  async function prepareDestination(destination: string, directory: boolean): Promise<void> {
    let existing: Stats | undefined;
    try {
      existing = await fs.lstat(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Never descend through a lower-precedence symlink, even if it points
    // inside the guest: resolving it here would use the host's namespace.
    if (directory) {
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
        throw new Error(`NVX overlay directory conflicts with non-directory: ${destination}`);
      }
      if (!existing) await fs.mkdir(destination, { mode: 0o700 });
    } else if (existing) {
      await fs.rm(destination, { recursive: true, force: true });
    }
  }

  async function copyRegularFile(
    source: string,
    destination: string,
    lstat: Stats,
    relativePath: string,
  ): Promise<void> {
    const handle = await fs.open(source, constants.O_RDONLY | noFollowFlag());
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`NVX layer source changed while opening file: ${relativePath}`);
      }
      assertSourceUnchanged(lstat, stat, relativePath);
      const mode = normalizedMode(stat);
      await prepareDestination(destination, false);
      await pipeline(
        createReadStream(descriptorPath(handle)),
        createWriteStream(destination, { flags: 'wx', mode }),
      );
      await fs.chmod(destination, mode);
      assertSourceUnchanged(stat, await handle.stat(), relativePath);
      assertSourceUnchanged(stat, await fs.lstat(source), relativePath);
      await fs.utimes(destination, sourceDateEpoch, sourceDateEpoch);
      const copied = await fs.stat(destination);
      const ownership = await applyOwnership(destination, stat, false);
      manifest.push({
        path: relativePath,
        type: 'file',
        mode,
        size: copied.size,
        sha256: await sha256File(destination),
        ...ownership,
      });
    } finally {
      await handle.close();
    }
  }
}

function assertSourceUnchanged(before: Stats, after: Stats, relativePath: string): void {
  if (
    before.dev !== after.dev || before.ino !== after.ino ||
    before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`NVX layer source changed during staging: ${relativePath}`);
  }
}

async function openDirectoryNoFollow(directoryPath: string): Promise<FileHandle> {
  const handle = await fs.open(
    directoryPath,
    constants.O_RDONLY | directoryFlag() | noFollowFlag(),
  );
  const stat = await handle.stat();
  if (!stat.isDirectory()) {
    await handle.close();
    throw new Error(`NVX layer source must be a real directory: ${directoryPath}`);
  }
  return handle;
}

function descriptorPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW as number;
}

function directoryFlag(): number {
  return constants.O_DIRECTORY as number;
}

export function normalizeNvxLayerSymlinkTarget(
  relativePath: string,
  target: string,
): string {
  if (!path.posix.isAbsolute(target)) return target;
  const guestTarget = path.posix.normalize(target);
  const guestDirectory = path.posix.dirname(`/${relativePath}`);
  return path.posix.relative(guestDirectory, guestTarget) || '.';
}

async function assertDescriptorTraversalSupport(): Promise<void> {
  if (
    process.platform !== 'linux' ||
    constants.O_NOFOLLOW === undefined ||
    constants.O_DIRECTORY === undefined
  ) {
    throw new Error('NVX filesystem staging requires Linux descriptor traversal support');
  }
  try {
    await fs.access('/proc/self/fd');
  } catch {
    throw new Error('NVX filesystem staging requires mounted /proc/self/fd');
  }
}

function stagingPath(root: string, relativePath: string): string {
  const destination = path.join(root, relativePath);
  assertContained(root, destination, 'NVX layer staging destination');
  return destination;
}

function normalizedMode(stat: Stats): number {
  return stat.mode & 0o777;
}

function orderedLayerSources(
  sources: readonly NvxLayerSource[],
): readonly NvxLayerSource[] {
  const byRole = new Map(sources.map((source) => [source.role, source]));
  return NVX_LAYER_ROLES.flatMap((role) => {
    const source = byRole.get(role);
    return source ? [source] : [];
  });
}

function assertLayerSources(sources: readonly NvxLayerSource[]): void {
  if (sources.length < 1 || sources.length > NVX_LAYER_ROLES.length) {
    throw new Error('NVX requires one to three deterministic EROFS layer sources');
  }
  const roles = sources.map(({ role }) => role);
  for (const role of roles) {
    if (!NVX_LAYER_ROLES.includes(role)) {
      throw new Error(`Unsupported NVX layer role: ${String(role)}`);
    }
  }
  const duplicates = roles.filter((role, index) => roles.indexOf(role) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate NVX layer role: ${duplicates[0]}`);
  }
  if (!roles.includes('distro')) {
    throw new Error('NVX requires a distro source for its single immutable guest root');
  }
}

function normalizeExcludedPaths(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    if (
      !value ||
      path.isAbsolute(value) ||
      value.includes('\0')
    ) {
      throw new Error(`NVX excluded path must be a non-empty relative path: ${value}`);
    }
    const relative = normalizeRelative(path.normalize(value));
    if (relative === '..' || relative.startsWith('../')) {
      throw new Error(`NVX excluded path escapes its layer source: ${value}`);
    }
    normalized.add(relative.replace(/^\.\//, '').replace(/\/$/, ''));
  }
  return [...normalized].sort();
}

function isExcluded(relativePath: string, excludedPaths: readonly string[]): boolean {
  return excludedPaths.some((excluded) =>
    relativePath === excluded ||
    relativePath.startsWith(`${excluded}/`) ||
    relativePath.endsWith(`/${excluded}`) ||
    relativePath.includes(`/${excluded}/`)
  );
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes ${root}: ${candidate}`);
  }
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join('/');
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) {
    throw new Error(`Unsafe NVX run id: ${runId}`);
  }
}

function assertSourceDateEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid NVX SOURCE_DATE_EPOCH value: ${value}`);
  }
}

function assertNonRootIdentity(uid: number, gid: number): void {
  if (
    !Number.isInteger(uid) ||
    !Number.isInteger(gid) ||
    uid < 1 ||
    gid < 1 ||
    uid > 0xffff_ffff ||
    gid > 0xffff_ffff
  ) {
    throw new Error(`NVX scratch identity must be a non-root UID:GID: ${uid}:${gid}`);
  }
}

function assertUuid(value: string, label: string): void {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  ) {
    throw new Error(`${label} must be a canonical lowercase UUID: ${value}`);
  }
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

async function writeExclusiveJson(
  filePath: string,
  value: unknown,
  mode: number,
): Promise<void> {
  const handle = await fs.open(filePath, 'wx', mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
