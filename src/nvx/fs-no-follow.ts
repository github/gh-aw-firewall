import { constants, promises as fs, type Stats } from 'fs';
import type { FileHandle } from 'fs/promises';

export function assertSourceUnchanged(before: Stats, after: Stats, relativePath: string): void {
  if (
    before.dev !== after.dev || before.ino !== after.ino ||
    before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`NVX layer source changed during staging: ${relativePath}`);
  }
}

export async function openDirectoryNoFollow(directoryPath: string): Promise<FileHandle> {
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

export function descriptorPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

export function noFollowFlag(): number {
  return constants.O_NOFOLLOW as number;
}

function directoryFlag(): number {
  return constants.O_DIRECTORY as number;
}

export async function assertDescriptorTraversalSupport(): Promise<void> {
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
