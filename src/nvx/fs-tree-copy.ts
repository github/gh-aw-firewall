import { createHash } from 'crypto';
import {
  constants,
  createReadStream,
  createWriteStream,
  promises as fs,
  type Stats,
} from 'fs';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import type { NvxLayerSourceManifestEntry } from './filesystem-builder';
import {
  assertContained,
  normalizeNvxLayerSymlinkTarget,
} from './filesystem-layer-validation';
import {
  assertDescriptorTraversalSupport,
  assertSourceUnchanged,
  descriptorPath,
  noFollowFlag,
  openDirectoryNoFollow,
} from './fs-no-follow';

interface TreeCopyContext {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly excludedPaths: readonly string[];
  readonly manifest: NvxLayerSourceManifestEntry[];
  readonly sourceDateEpoch: number;
  readonly preserveOwnership: boolean;
  readonly includeRoot: boolean;
}

export async function copyDeterministicTree(
  sourceRoot: string,
  destinationRoot: string,
  excludedPaths: readonly string[],
  manifest: NvxLayerSourceManifestEntry[],
  sourceDateEpoch: number,
  preserveOwnership = false,
  includeRoot = true,
): Promise<void> {
  const context: TreeCopyContext = {
    sourceRoot, destinationRoot, excludedPaths, manifest,
    sourceDateEpoch, preserveOwnership, includeRoot,
  };
  await assertDescriptorTraversalSupport();
  const root = await openDirectoryNoFollow(sourceRoot);
  try {
    await copyDirectory(context, root, '');
  } finally {
    await root.close();
  }
}

async function copyDirectory(
  context: TreeCopyContext,
  directory: FileHandle,
  relativePath: string,
): Promise<void> {
  const current = descriptorPath(directory);
  if (relativePath || context.includeRoot) {
    const destination = stagingPath(context.destinationRoot, relativePath);
    const stat = await directory.stat();
    const mode = normalizedMode(stat);
    await prepareDestination(destination, true);
    await fs.chmod(destination, mode);
    const ownership = await applyOwnership(context, destination, stat, false);
    context.manifest.push({ path: relativePath, type: 'directory', mode, size: 0, ...ownership });
  }
  const before = await directory.stat();
  const children = await fs.readdir(current);
  children.sort();
  for (const child of children) {
    const childPath = path.join(current, child);
    const childRelativePath = relativePath ? `${relativePath}/${child}` : child;
    if (isExcluded(childRelativePath, context.excludedPaths)) continue;
    const stat = await fs.lstat(childPath);
    const destination = stagingPath(context.destinationRoot, childRelativePath);
    if (stat.isSymbolicLink()) {
      const sourceTarget = await fs.readlink(childPath);
      const target = normalizeNvxLayerSymlinkTarget(childRelativePath, sourceTarget);
      assertContained(
        context.sourceRoot,
        path.resolve(context.sourceRoot, path.dirname(childRelativePath), target),
        `NVX layer symlink target for ${childRelativePath}`,
      );
      const after = await fs.lstat(childPath);
      assertSourceUnchanged(stat, after, childRelativePath);
      await prepareDestination(destination, false);
      await fs.symlink(target, destination);
      await fs.lutimes(destination, context.sourceDateEpoch, context.sourceDateEpoch);
      const ownership = await applyOwnership(context, destination, stat, true);
      context.manifest.push({
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
        await copyDirectory(context, childDirectory, childRelativePath);
      } finally {
        await childDirectory.close();
      }
    } else if (stat.isFile()) {
      await copyRegularFile(context, childPath, destination, stat, childRelativePath);
    } else {
      throw new Error(`Special filesystem entry is not safe for NVX layer: ${childRelativePath}`);
    }
  }
  assertSourceUnchanged(before, await directory.stat(), relativePath || '/');
  await fs.utimes(
    stagingPath(context.destinationRoot, relativePath),
    context.sourceDateEpoch,
    context.sourceDateEpoch,
  );
}

async function applyOwnership(
  context: TreeCopyContext,
  destination: string,
  stat: Pick<Stats, 'uid' | 'gid'>,
  symbolicLink: boolean,
): Promise<{ uid?: number; gid?: number }> {
  const uid = context.preserveOwnership ? stat.uid : 0;
  const gid = context.preserveOwnership ? stat.gid : 0;
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
  context: TreeCopyContext,
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
    await fs.utimes(destination, context.sourceDateEpoch, context.sourceDateEpoch);
    const copied = await fs.stat(destination);
    const ownership = await applyOwnership(context, destination, stat, false);
    context.manifest.push({
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

function stagingPath(root: string, relativePath: string): string {
  const destination = path.join(root, relativePath);
  assertContained(root, destination, 'NVX layer staging destination');
  return destination;
}

function normalizedMode(stat: Stats): number {
  return stat.mode & 0o777;
}

function isExcluded(relativePath: string, excludedPaths: readonly string[]): boolean {
  return excludedPaths.some((excluded) =>
    relativePath === excluded ||
    relativePath.startsWith(`${excluded}/`) ||
    relativePath.endsWith(`/${excluded}`) ||
    relativePath.includes(`/${excluded}/`)
  );
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
