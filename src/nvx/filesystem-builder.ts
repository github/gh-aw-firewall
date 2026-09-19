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
}

export interface NvxLayerSourceManifestEntry {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly mode: number;
  readonly size: number;
  readonly sha256?: string;
  readonly target?: string;
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
 * Builds immutable deterministic EROFS layers and a fresh private ext4 scratch
 * image for one NVX invocation.
 *
 * This module does not launch NVX. Runtime selection remains disabled until
 * the Phase 3 host-confinement and network-policy gates are implemented.
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
    this.runDirectory = path.join(config.workDir, 'nvx-images', config.runId);
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
      const layers: NvxLayerArtifact[] = [];
      for (const source of orderedLayerSources(this.config.layers)) {
        const staged = await this.stageLayer(source);
        layers.push(await this.buildLayer(staged, sourceDateEpoch));
      }
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

  private async stageLayer(source: NvxLayerSource): Promise<StagedLayer> {
    const sourcePath = path.resolve(source.sourcePath);
    const sourceStat = await fs.lstat(sourcePath);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`NVX ${source.role} layer source must be a real directory: ${sourcePath}`);
    }
    const stagingPath = path.join(this.stagingDirectory, source.role);
    await fs.mkdir(stagingPath, { mode: 0o700 });
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
      '--workers=1',
      '--sort=path',
      '--all-root',
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
    if (relativePath) {
      const destination = stagingPath(destinationRoot, relativePath);
      const stat = await directory.stat();
      const mode = normalizedMode(stat);
      await fs.mkdir(destination, { recursive: true, mode });
      await fs.chmod(destination, mode);
      manifest.push({ path: relativePath, type: 'directory', mode, size: 0 });
    }
    const children = await fs.readdir(current);
    children.sort();
    for (const child of children) {
      const childPath = path.join(current, child);
      const childRelativePath = relativePath ? `${relativePath}/${child}` : child;
      if (isExcluded(childRelativePath, excludedPaths)) continue;
      const stat = await fs.lstat(childPath);
      const destination = stagingPath(destinationRoot, childRelativePath);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(childPath);
        if (path.isAbsolute(target)) {
          throw new Error(`Absolute symlink is not safe for NVX layer: ${childRelativePath}`);
        }
        assertContained(
          sourceRoot,
          path.resolve(sourceRoot, path.dirname(childRelativePath), target),
          `NVX layer symlink target for ${childRelativePath}`,
        );
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.symlink(target, destination);
        await fs.lutimes(destination, sourceDateEpoch, sourceDateEpoch);
        manifest.push({
          path: childRelativePath,
          type: 'symlink',
          mode: stat.mode & 0o777,
          size: stat.size,
          target,
        });
      } else if (stat.isDirectory()) {
        const childDirectory = await openDirectoryNoFollow(childPath);
        try {
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
    if (relativePath) {
      await fs.utimes(stagingPath(destinationRoot, relativePath), sourceDateEpoch, sourceDateEpoch);
    }
  }

  async function copyRegularFile(
    source: string,
    destination: string,
    lstat: Stats,
    relativePath: string,
  ): Promise<void> {
    const handle = await fs.open(source, constants.O_RDONLY | requiredNoFollowFlag());
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== lstat.dev || stat.ino !== lstat.ino) {
        throw new Error(`NVX layer source changed while opening file: ${relativePath}`);
      }
      const mode = normalizedMode(stat);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await pipeline(
        createReadStream(descriptorPath(handle)),
        createWriteStream(destination, { flags: 'wx', mode }),
      );
      await fs.chmod(destination, mode);
      await fs.utimes(destination, sourceDateEpoch, sourceDateEpoch);
      const copied = await fs.stat(destination);
      manifest.push({
        path: relativePath,
        type: 'file',
        mode,
        size: copied.size,
        sha256: await sha256File(destination),
      });
    } finally {
      await handle.close();
    }
  }
}

async function openDirectoryNoFollow(directoryPath: string): Promise<FileHandle> {
  const handle = await fs.open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | requiredNoFollowFlag(),
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

function requiredNoFollowFlag(): number {
  if (constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) {
    throw new Error('NVX filesystem staging requires O_NOFOLLOW and O_DIRECTORY support');
  }
  return constants.O_NOFOLLOW;
}

async function assertDescriptorTraversalSupport(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('NVX filesystem staging requires Linux descriptor traversal support');
  }
  requiredNoFollowFlag();
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
