import { createHash } from 'crypto';
import { constants, createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import {
  NVX_ARTIFACT_REPOSITORY,
  NVX_ARTIFACT_SIGNER_WORKFLOW,
  type NvxArtifactManifest,
  type NvxTrustedArtifactName,
  assertNvxArtifactBasenames,
  parseNvxArtifactManifest,
} from './artifact-manifest';
import { NVX_TRUSTED_ARTIFACT_ROOT } from './paths';

const REQUIRED_CGROUP_CONTROLLERS = ['cpu', 'memory', 'pids'] as const;
const REQUIRED_TOOLS = [
  'bwrap',
  'getfacl',
  'gh',
  'ip',
  'mkfs.erofs',
  'mke2fs',
  'nft',
  'python3',
  'setfacl',
  'setpriv',
  'useradd',
  'userdel',
] as const;
const TRUSTED_TOOL_DIRECTORIES = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'] as const;

export type NvxHostToolName = typeof REQUIRED_TOOLS[number];
export type NvxHostToolPaths = Readonly<Record<NvxHostToolName, string>>;
export type NvxArtifactPaths = Readonly<Record<NvxTrustedArtifactName, string>>;
type NvxTrustedFileStat = Awaited<ReturnType<NvxPreflightDependencies['lstat']>>;

export interface NvxArtifactSnapshot extends NvxArtifactPaths {
  readonly directory: string;
  readonly manifestPath: string;
  readonly bundlePath: string;
}

export interface NvxPreflightOptions {
  readonly expectedReleaseTag: string;
  readonly manifestPath: string;
  readonly artifactManifestBundlePath: string;
  readonly artifacts: NvxArtifactPaths;
}

export interface NvxPreflightResult {
  readonly manifest: NvxArtifactManifest;
  readonly snapshot: NvxArtifactSnapshot;
  readonly tools: NvxHostToolPaths;
}

export interface NvxPreflightDependencies {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly effectiveUid: number;
  access(filePath: string, mode: number): Promise<void>;
  readFile(filePath: string): Promise<string>;
  lstat(filePath: string): Promise<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
    uid: number;
    mode: number;
    size: number;
  }>;
  sha256(filePath: string): Promise<string>;
  resolveTool(name: NvxHostToolName): Promise<string>;
  verifyAttestation(
    ghPath: string,
    manifestPath: string,
    bundlePath: string,
  ): Promise<void>;
  createSnapshot(
    options: NvxPreflightOptions,
  ): Promise<NvxArtifactSnapshot>;
  removeSnapshot(directory: string): Promise<void>;
}

const defaultDependencies: NvxPreflightDependencies = {
  platform: process.platform,
  arch: process.arch,
  effectiveUid: process.geteuid?.() ?? -1,
  access: fs.access,
  readFile: async (filePath) => fs.readFile(filePath, 'utf8'),
  lstat: fs.lstat,
  sha256: calculateSha256,
  resolveTool: resolveTrustedTool,
  verifyAttestation: async (ghPath, manifestPath, bundlePath) => {
    const result = await execa(ghPath, [
      'attestation',
      'verify',
      manifestPath,
      '--repo', NVX_ARTIFACT_REPOSITORY,
      '--bundle', bundlePath,
      '--signer-workflow', NVX_ARTIFACT_SIGNER_WORKFLOW,
      '--deny-self-hosted-runners',
    ], {
      reject: false,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      extendEnv: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `NVX artifact attestation verification failed with code ${result.exitCode}: ` +
        `${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  },
  createSnapshot: createArtifactSnapshot,
  removeSnapshot: async (directory) => {
    await fs.rm(directory, { recursive: true, force: true });
  },
};

export async function runNvxPreflight(
  options: NvxPreflightOptions,
  dependencies: NvxPreflightDependencies = defaultDependencies,
): Promise<NvxPreflightResult> {
  if (dependencies.platform !== 'linux' || dependencies.arch !== 'x64') {
    throw new Error('NVX preview requires a Linux x86_64 host');
  }
  if (dependencies.effectiveUid !== 0) {
    throw new Error('NVX preview requires effective uid 0');
  }
  await dependencies.access('/dev/kvm', constants.R_OK | constants.W_OK);
  await dependencies.access('/dev/net/tun', constants.R_OK | constants.W_OK);
  const controllers = new Set(
    (await dependencies.readFile('/sys/fs/cgroup/cgroup.controllers'))
      .trim()
      .split(/\s+/),
  );
  for (const controller of REQUIRED_CGROUP_CONTROLLERS) {
    if (!controllers.has(controller)) {
      throw new Error(`NVX preview requires cgroup v2 controller: ${controller}`);
    }
  }
  if (
    !(await dependencies.readFile('/proc/sys/kernel/seccomp/actions_avail'))
      .split(/\s+/)
      .includes('kill_process')
  ) {
    throw new Error('NVX preview requires seccomp kill_process support');
  }

  const toolEntries = await Promise.all(
    REQUIRED_TOOLS.map(async (name) => [name, await dependencies.resolveTool(name)] as const),
  );
  const tools = Object.fromEntries(toolEntries) as unknown as NvxHostToolPaths;
  await assertTrustedFile(options.manifestPath, 'NVX artifact manifest', false, dependencies);
  await assertTrustedFile(
    options.artifactManifestBundlePath,
    'NVX artifact attestation bundle',
    false,
    dependencies,
  );
  const sourceManifest = parseNvxArtifactManifest(
    await dependencies.readFile(options.manifestPath),
    options.expectedReleaseTag,
  );
  assertNvxArtifactBasenames(sourceManifest, options.artifacts);
  const sourceStats = {} as Record<NvxTrustedArtifactName, NvxTrustedFileStat>;
  for (const [name, artifactPath] of Object.entries(options.artifacts) as [
    NvxTrustedArtifactName,
    string,
  ][]) {
    sourceStats[name] = await assertTrustedFile(
      artifactPath,
      `NVX ${name} artifact`,
      name === 'launcher' || name === 'openvmm',
      dependencies,
    );
    assertManifestSize(
      name,
      sourceStats[name].size,
      sourceManifest.artifacts[name].sizeBytes,
      'source',
    );
  }

  const snapshot = await dependencies.createSnapshot(options);
  try {
    await assertTrustedFile(
      snapshot.manifestPath,
      'snapshotted NVX artifact manifest',
      false,
      dependencies,
    );
    await assertTrustedFile(
      snapshot.bundlePath,
      'snapshotted NVX artifact attestation bundle',
      false,
      dependencies,
    );
    await dependencies.verifyAttestation(
      tools.gh,
      snapshot.manifestPath,
      snapshot.bundlePath,
    );
    const manifest = parseNvxArtifactManifest(
      await dependencies.readFile(snapshot.manifestPath),
      options.expectedReleaseTag,
    );
    assertNvxArtifactBasenames(manifest, snapshot);
    for (const name of Object.keys(options.artifacts) as NvxTrustedArtifactName[]) {
      if (
        manifest.artifacts[name].sizeBytes !== sourceManifest.artifacts[name].sizeBytes ||
        manifest.artifacts[name].sha256 !== sourceManifest.artifacts[name].sha256
      ) {
        throw new Error(`Snapshotted NVX ${name} artifact manifest changed`);
      }
    }
    for (const [name, artifactPath] of Object.entries(snapshot) as [string, string][]) {
      if (
        name === 'directory' ||
        name === 'manifestPath' ||
        name === 'bundlePath'
      ) continue;
      const artifactName = name as NvxTrustedArtifactName;
      const snapshotStat = await assertTrustedFile(
        artifactPath,
        `snapshotted NVX ${artifactName} artifact`,
        artifactName === 'launcher' || artifactName === 'openvmm',
        dependencies,
      );
      assertManifestSize(
        artifactName,
        snapshotStat.size,
        manifest.artifacts[artifactName].sizeBytes,
        'snapshotted',
      );
      if (await dependencies.sha256(artifactPath) !== manifest.artifacts[artifactName].sha256) {
        throw new Error(`Snapshotted NVX ${artifactName} artifact digest changed`);
      }
    }
    return { manifest, snapshot, tools };
  } catch (error) {
    await dependencies.removeSnapshot(snapshot.directory);
    throw error;
  }
}

async function assertTrustedFile(
  filePath: string,
  label: string,
  executable: boolean,
  dependencies: NvxPreflightDependencies,
): Promise<NvxTrustedFileStat> {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} path must be absolute`);
  const stat = await dependencies.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.size < 1) {
    throw new Error(`${label} must be a non-empty root-owned regular file`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be writable by group or other users`);
  }
  if (executable && (stat.mode & 0o111) === 0) {
    throw new Error(`${label} must be executable`);
  }
  return stat;
}

async function createArtifactSnapshot(
  options: NvxPreflightOptions,
): Promise<NvxArtifactSnapshot> {
  await fs.mkdir(NVX_TRUSTED_ARTIFACT_ROOT, { recursive: true, mode: 0o711 });
  const directory = await fs.mkdtemp(path.join(NVX_TRUSTED_ARTIFACT_ROOT, 'run-'));
  await fs.chmod(directory, 0o555);
  try {
    const copied = {} as Record<NvxTrustedArtifactName, string>;
    for (const name of Object.keys(options.artifacts) as NvxTrustedArtifactName[]) {
      const destination = path.join(directory, path.basename(options.artifacts[name]));
      await fs.copyFile(options.artifacts[name], destination, constants.COPYFILE_EXCL);
      await fs.chmod(destination, name === 'launcher' || name === 'openvmm' ? 0o555 : 0o444);
      copied[name] = destination;
    }
    const manifestPath = path.join(directory, 'manifest.json');
    const bundlePath = path.join(directory, 'manifest.sigstore.json');
    await fs.copyFile(options.manifestPath, manifestPath, constants.COPYFILE_EXCL);
    await fs.copyFile(
      options.artifactManifestBundlePath,
      bundlePath,
      constants.COPYFILE_EXCL,
    );
    await fs.chmod(manifestPath, 0o444);
    await fs.chmod(bundlePath, 0o444);
    return {
      directory,
      launcher: copied.launcher,
      openvmm: copied.openvmm,
      kernel: copied.kernel,
      initramfs: copied.initramfs,
      manifestPath,
      bundlePath,
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function resolveTrustedTool(name: NvxHostToolName): Promise<string> {
  for (const directory of TRUSTED_TOOL_DIRECTORIES) {
    const candidate = path.join(directory, name);
    try {
      const stat = await fs.lstat(candidate);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.uid === 0 &&
        (stat.mode & 0o022) === 0 &&
        (stat.mode & 0o111) !== 0
      ) return candidate;
    } catch {
      // Continue through the bounded PATH.
    }
  }
  throw new Error(`required trusted NVX host tool "${name}" was not found on PATH`);
}

function assertManifestSize(
  name: NvxTrustedArtifactName,
  actualSize: number,
  expectedSize: number,
  label: 'source' | 'snapshotted',
): void {
  if (actualSize !== expectedSize) {
    throw new Error(
      `${label} NVX ${name} artifact size does not match manifest: ` +
      `expected ${expectedSize}, got ${actualSize}`,
    );
  }
}

async function calculateSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
