import { constants, createReadStream, promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import type { NvxFilesystemBundle } from './filesystem-builder';
import {
  parseNvxOneShotOutcome,
  type NvxOneShotOutcome,
} from './outcome';
import {
  assertContained,
  assertRegularFile,
  assertSafeDiskPath,
  assertSha256,
  assertUuid,
  formatError,
  orderedLayers,
} from './one-shot-validation';

const NVX_MAX_OUTCOME_BYTES = 64 * 1024;

export async function verifyFilesystemBundle(bundle: NvxFilesystemBundle): Promise<void> {
  const runDirectory = path.resolve(bundle.runDirectory);
  const runDirectoryStat = await fs.lstat(runDirectory);
  if (!runDirectoryStat.isDirectory() || runDirectoryStat.isSymbolicLink()) {
    throw new Error(`NVX run directory must be a real directory: ${runDirectory}`);
  }
  if ((runDirectoryStat.mode & 0o077) !== 0) {
    throw new Error('NVX run directory must not be accessible to group or other users');
  }
  if (bundle.layers.length !== 1 || bundle.layers[0].role !== 'distro') {
    throw new Error('NVX filesystem bundle must contain exactly one distro layer');
  }
  const roles = new Set<string>();
  for (const layer of orderedLayers(bundle.layers)) {
    if (layer.role !== 'distro') {
      throw new Error(`Unsupported NVX layer role: ${String(layer.role)}`);
    }
    if (roles.has(layer.role)) throw new Error(`Duplicate NVX layer role: ${layer.role}`);
    roles.add(layer.role);
    assertContained(runDirectory, layer.path, `NVX ${layer.role} layer`);
    if (path.resolve(layer.path) !== path.join(runDirectory, `${layer.role}.erofs`)) {
      throw new Error(`NVX ${layer.role} layer has an unexpected artifact path`);
    }
    assertSafeDiskPath(layer.path);
    const stat = await assertRegularFile(layer.path, `NVX ${layer.role} layer`);
    if ((stat.mode & 0o777) !== 0o400) {
      throw new Error(`NVX ${layer.role} layer image must have mode 0400`);
    }
    assertUuid(layer.uuid, `NVX ${layer.role} layer UUID`);
    assertSha256(layer.sha256, `NVX ${layer.role} layer digest`);
    assertSha256(
      layer.sourceManifestSha256,
      `NVX ${layer.role} source manifest digest`,
    );
    const digest = await sha256File(layer.path);
    if (digest !== layer.sha256) {
      throw new Error(`NVX ${layer.role} layer digest changed after preparation`);
    }
  }
  assertContained(runDirectory, bundle.scratch.path, 'NVX scratch image');
  if (path.resolve(bundle.scratch.path) !== path.join(runDirectory, 'scratch.ext4')) {
    throw new Error('NVX scratch image has an unexpected artifact path');
  }
  assertSafeDiskPath(bundle.scratch.path);
  assertUuid(bundle.scratch.uuid, 'NVX scratch UUID');
  const scratch = await assertRegularFile(bundle.scratch.path, 'NVX scratch image');
  if (scratch.size !== bundle.scratch.sizeBytes) {
    throw new Error('NVX scratch image size changed after preparation');
  }
  if ((scratch.mode & 0o077) !== 0) {
    throw new Error('NVX scratch image must not be accessible to group or other users');
  }
  if (path.resolve(bundle.manifestPath) !== path.join(runDirectory, 'manifest.json')) {
    throw new Error('NVX filesystem manifest has an unexpected artifact path');
  }
  const manifestStat = await assertRegularFile(
    bundle.manifestPath,
    'NVX filesystem manifest',
  );
  if ((manifestStat.mode & 0o777) !== 0o400) {
    throw new Error('NVX filesystem manifest must have mode 0400');
  }
  if (manifestStat.size < 1 || manifestStat.size > NVX_MAX_OUTCOME_BYTES) {
    throw new Error('NVX filesystem manifest has an invalid size');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(bundle.manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`NVX filesystem manifest is invalid: ${formatError(error)}`);
  }
  const expectedManifest = {
    schemaVersion: 1,
    sourceDateEpoch: bundle.sourceDateEpoch,
    layers: orderedLayers(bundle.layers).map((layer) => ({
      role: layer.role,
      file: path.basename(layer.path),
      uuid: layer.uuid,
      sha256: layer.sha256,
      sourceManifestSha256: layer.sourceManifestSha256,
      sourceEntries: layer.sourceEntries,
      excludedPaths: layer.excludedPaths,
    })),
    scratch: {
      file: path.basename(bundle.scratch.path),
      uuid: bundle.scratch.uuid,
      sizeBytes: bundle.scratch.sizeBytes,
      uid: bundle.scratch.uid,
      gid: bundle.scratch.gid,
    },
  };
  if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
    throw new Error('NVX filesystem manifest does not match the prepared artifacts');
  }
}

export async function readOutcome(outcomePath: string): Promise<NvxOneShotOutcome> {
  let handle;
  try {
    handle = await fs.open(
      outcomePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('NVX one-shot execution did not produce a structured outcome report');
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`NVX outcome report must be a regular file: ${outcomePath}`);
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`NVX outcome report must be a regular file: ${outcomePath}`);
    }
    if (stat.size < 1 || stat.size > NVX_MAX_OUTCOME_BYTES) {
      throw new Error(`NVX outcome report size must be 1-${NVX_MAX_OUTCOME_BYTES} bytes`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('NVX outcome report must not be accessible to group or other users');
    }
    const contents = await handle.readFile();
    if (contents.length < 1 || contents.length > NVX_MAX_OUTCOME_BYTES) {
      throw new Error(`NVX outcome report size must be 1-${NVX_MAX_OUTCOME_BYTES} bytes`);
    }
    return parseNvxOneShotOutcome(contents.toString('utf8'));
  } finally {
    await handle.close();
  }
}

export async function assertNewOutcomePath(outcomePath: string, runDirectory: string): Promise<void> {
  assertContained(runDirectory, outcomePath, 'NVX outcome report');
  const parent = await fs.lstat(path.dirname(outcomePath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('NVX outcome report parent must be a real directory');
  }
  try {
    await fs.lstat(outcomePath);
    throw new Error(`NVX outcome report already exists: ${outcomePath}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

export function assertMatchingExitCode(
  wrapperExitCode: number,
  outcome: NvxOneShotOutcome,
): void {
  if (wrapperExitCode !== outcome.outcome.statusCode) {
    throw new Error(
      `NVX wrapper exit ${wrapperExitCode} does not match structured outcome ` +
      `${outcome.outcome.category}:${outcome.outcome.statusCode}`,
    );
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
