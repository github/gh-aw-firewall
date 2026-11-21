import * as fs from 'fs';
import * as path from 'path';
import { getSafeHostGid, getSafeHostUid } from './host-identity';

const LINUX_O_PATH = 0x200000; // Linux O_PATH is not exposed by Node's fs.constants.

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function descriptorPath(fd: number, entry?: string): string {
  const directory = `/proc/self/fd/${fd}`;
  return entry === undefined ? directory : path.join(directory, entry);
}

export function openDirectoryAt(parentFd: number, entry: string): number {
  const fd = fs.openSync(
    descriptorPath(parentFd, entry),
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    if (!fs.fstatSync(fd).isDirectory()) {
      throw new Error(`Expected directory but found non-directory path: ${entry}`);
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function isVanishedSource(error: unknown): boolean {
  return ['ENOENT', 'ESTALE'].includes((error as NodeJS.ErrnoException).code ?? '');
}

export function openSourceDirectory(rootFd: number, relativePath: string): number {
  let parentFd = rootFd;
  let ownedFd: number | undefined;
  try {
    for (const segment of relativePath.split(path.sep).filter(Boolean)) {
      const nextFd = openDirectoryAt(parentFd, segment);
      if (ownedFd !== undefined) fs.closeSync(ownedFd);
      ownedFd = nextFd;
      parentFd = nextFd;
    }
    if (ownedFd === undefined) throw new Error('NFS home tool state cannot be the host home itself');
    return ownedFd;
  } catch (error) {
    if (ownedFd !== undefined) fs.closeSync(ownedFd);
    throw error;
  }
}

function copyFileContents(sourceFd: number, targetFd: number): void {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesRead: number;
  while ((bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
    let offset = 0;
    while (offset < bytesRead) {
      offset += fs.writeSync(targetFd, buffer, offset, bytesRead - offset);
    }
  }
}

export function createNfsHomeCopier(home: string, excluded: readonly string[]) {
  const uid = Number(getSafeHostUid());
  const gid = Number(getSafeHostGid());
  const setOwnership = (fd: number): void => {
    const stat = fs.fstatSync(fd);
    if (stat.uid !== uid || stat.gid !== gid) fs.fchownSync(fd, uid, gid);
  };

  const copyDirectoryContents = (sourceFd: number, targetFd: number, relativePath: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(descriptorPath(sourceFd));
    } catch (error) {
      if (isVanishedSource(error)) return;
      throw error;
    }
    for (const name of names) {
      const childRelativePath = path.join(relativePath, name);
      const sourcePath = path.join(home, childRelativePath);
      if (excluded.some((entry) => isWithin(entry, sourcePath))) continue;

      const sourcePathAtFd = descriptorPath(sourceFd, name);
      let sourceEntryFd: number;
      try {
        sourceEntryFd = fs.openSync(
          sourcePathAtFd,
          LINUX_O_PATH | fs.constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (isVanishedSource(error)) continue;
        throw error;
      }

      try {
        const sourceStat = fs.fstatSync(sourceEntryFd);
        if (sourceStat.isSymbolicLink()) {
          let linkTarget: string;
          try {
            linkTarget = fs.readlinkSync(sourcePathAtFd);
          } catch (error) {
            if (isVanishedSource(error)) continue;
            throw error;
          }
          fs.symlinkSync(linkTarget, descriptorPath(targetFd, name));
          continue;
        }

        if (sourceStat.isDirectory()) {
          let childSourceFd: number;
          try {
            childSourceFd = fs.openSync(
              descriptorPath(sourceEntryFd),
              fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
            );
          } catch (error) {
            if (isVanishedSource(error)) continue;
            throw error;
          }
          try {
            const openedStat = fs.fstatSync(childSourceFd);
            if (openedStat.dev !== sourceStat.dev || openedStat.ino !== sourceStat.ino) continue;
            fs.mkdirSync(descriptorPath(targetFd, name), { mode: 0o700 });
            const childTargetFd = openDirectoryAt(targetFd, name);
            try {
              copyDirectoryContents(childSourceFd, childTargetFd, childRelativePath);
              setOwnership(childTargetFd);
              fs.fchmodSync(childTargetFd, 0o700);
            } finally {
              fs.closeSync(childTargetFd);
            }
          } finally {
            fs.closeSync(childSourceFd);
          }
          continue;
        }

        if (!sourceStat.isFile()) continue; // Sockets, FIFOs and devices are not staged.
        let sourceFileFd: number;
        try {
          sourceFileFd = fs.openSync(
            descriptorPath(sourceEntryFd),
            fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
          );
        } catch (error) {
          if (isVanishedSource(error)) continue;
          throw error;
        }
        try {
          const openedStat = fs.fstatSync(sourceFileFd);
          if (!openedStat.isFile() || openedStat.dev !== sourceStat.dev || openedStat.ino !== sourceStat.ino) continue;
          const targetFileFd = fs.openSync(
            descriptorPath(targetFd, name),
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            copyFileContents(sourceFileFd, targetFileFd);
            setOwnership(targetFileFd);
            fs.fchmodSync(targetFileFd, (openedStat.mode & 0o777) | 0o600);
          } finally {
            fs.closeSync(targetFileFd);
          }
        } finally {
          fs.closeSync(sourceFileFd);
        }
      } finally {
        fs.closeSync(sourceEntryFd);
      }
    }
  };

  return { copyDirectoryContents, setOwnership };
}
