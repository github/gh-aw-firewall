import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import { CREDENTIAL_ENTRIES, HOME_FORBIDDEN_SUBDIRS } from '../config/mount-policy';
import { createNvxRunLayout } from './run-layout';
import { copyDeterministicTree, sha256File } from './fs-tree-copy';
import {
  assertLayerSources,
  assertNonRootIdentity,
  assertRegularFile,
  assertSafeRunId,
  assertSourceDateEpoch,
  assertUuid,
  normalizeExcludedPaths,
  normalizeRelative,
  normalizeScratchBytes,
  NVX_BLOCK_BYTES,
  NVX_DEFAULT_MAX_SCRATCH_BYTES,
  NVX_LAYER_ROLES,
  NVX_MIN_SCRATCH_BYTES,
  type NvxLayerRole,
} from './filesystem-layer-validation';

export {
  normalizeNvxLayerSymlinkTarget,
  normalizeScratchBytes,
  NVX_DEFAULT_MAX_SCRATCH_BYTES,
  NVX_LAYER_ROLES,
  NVX_MIN_SCRATCH_BYTES,
  type NvxLayerRole,
} from './filesystem-layer-validation';

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

function orderedLayerSources(
  sources: readonly NvxLayerSource[],
): readonly NvxLayerSource[] {
  const byRole = new Map(sources.map((source) => [source.role, source]));
  return NVX_LAYER_ROLES.flatMap((role) => {
    const source = byRole.get(role);
    return source ? [source] : [];
  });
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

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
