import * as fs from 'fs';
import * as path from 'path';
import { CREDENTIAL_ENTRIES, HOME_FORBIDDEN_SUBDIRS, HOME_TOOL_PATHS, credentialFilesToHide, gitLabCredentialFiles } from './config/mount-policy';
import { WrapperConfig } from './types';
import { getSafeHostGid, getSafeHostUid } from './host-identity';
import { resolveRunnerToolCachePath } from './runner-tool-cache';

export function usesNfsHome(config: WrapperConfig, home: string): boolean {
  if (process.platform !== 'linux' || config.runnerTopology === 'arc-dind' ||
      ['sbx', 'nvx', 'cloud-hypervisor'].includes(config.containerRuntime ?? '')) return false;
  try {
    return Number(fs.statfsSync(home).type) === 0x6969; // NFS_SUPER_MAGIC (NFSv3 and NFSv4)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function descriptorPath(fd: number, entry?: string): string {
  const directory = `/proc/self/fd/${fd}`;
  return entry === undefined ? directory : path.join(directory, entry);
}

function openDirectoryAt(parentFd: number, entry: string): number {
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

function isVanishedSource(error: unknown): boolean {
  return ['ENOENT', 'ESTALE'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function isSourceLinkRace(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ELOOP';
}

function openSourceDirectory(rootFd: number, relativePath: string): number {
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

export function nfsHomeRelativePath(home: string, candidate: string): string | undefined {
  const canonicalHome = fs.realpathSync(home);
  const canonicalCandidate = fs.realpathSync(candidate);
  return isWithin(canonicalHome, canonicalCandidate)
    ? path.relative(canonicalHome, canonicalCandidate)
    : undefined;
}

/**
 * Docker's root cannot traverse root-squashed home directories, even when the
 * runner can. Copy only allowlisted tool state into the local chroot home;
 * exclude credential stores before opening them, and never follow symlinks.
 * The snapshot is disposable: writes are not synchronized back to the host home.
 */
export function stageNfsHome(config: WrapperConfig, home: string, destination: string): void {
  home = fs.realpathSync(home);
  const canonicalDestination = fs.realpathSync(destination);
  if (canonicalDestination !== home && isWithin(home, canonicalDestination)) {
    throw new Error('An NFS home requires --work-dir outside the host home.');
  }
  if (Number(fs.statfsSync(canonicalDestination).type) === 0x6969) {
    throw new Error('An NFS home requires --work-dir on a local filesystem writable by the runner and accessible to Docker.');
  }
  if (isWithin(home, canonicalDestination)) {
    throw new Error('An NFS home requires --work-dir outside the host home.');
  }
  const destinationFd = fs.openSync(
    destination,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  let homeFd: number | undefined;
  try {
    if (!fs.fstatSync(destinationFd).isDirectory() ||
        fs.realpathSync(descriptorPath(destinationFd)) !== canonicalDestination ||
        fs.readdirSync(descriptorPath(destinationFd)).length !== 0) {
      throw new Error(`NFS home staging requires an empty, non-symlink chroot home: ${destination}`);
    }
    fs.fchmodSync(destinationFd, 0o700);
    homeFd = fs.openSync(
      home,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    if (fs.realpathSync(descriptorPath(homeFd)) !== home) {
      throw new Error('NFS home changed while staging was being prepared.');
    }

    const excluded = [
      ...CREDENTIAL_ENTRIES.map((entry) => path.join(home, entry.path)),
      ...credentialFilesToHide().map((entry) => path.join(home, entry)),
      ...HOME_FORBIDDEN_SUBDIRS.map((entry) => path.join(home, entry)),
      ...gitLabCredentialFiles(home, process.env),
      ...(config.enableApiProxy && config.envFile ? [path.resolve(config.envFile)] : []),
      path.join(home, '.copilot/session-state'),
      path.join(home, '.copilot/logs'),
    ];
    // A credential store may itself be a symlink into an allowlisted cache.
    for (const entry of [...excluded]) {
      try {
        excluded.push(fs.realpathSync(entry));
      } catch (error) {
        if (!isVanishedSource(error)) throw error;
      }
    }

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
        let sourceStat: fs.Stats;
        try {
          sourceStat = fs.lstatSync(sourcePathAtFd);
        } catch (error) {
          if (isVanishedSource(error)) continue;
          throw error;
        }

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
            childSourceFd = openDirectoryAt(sourceFd, name);
          } catch (error) {
            if (isVanishedSource(error) || isSourceLinkRace(error)) continue;
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
            sourcePathAtFd,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
          );
        } catch (error) {
          if (isVanishedSource(error) || isSourceLinkRace(error)) continue;
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
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let bytesRead: number;
            while ((bytesRead = fs.readSync(sourceFileFd, buffer, 0, buffer.length, null)) > 0) {
              let offset = 0;
              while (offset < bytesRead) {
                offset += fs.writeSync(targetFileFd, buffer, offset, bytesRead - offset);
              }
            }
            setOwnership(targetFileFd);
            fs.fchmodSync(targetFileFd, (openedStat.mode & 0o777) | 0o600);
          } finally {
            fs.closeSync(targetFileFd);
          }
        } finally {
          fs.closeSync(sourceFileFd);
        }
      }
    };

    const toolCache = resolveRunnerToolCachePath(config, home);
    const relativeToolCache = toolCache ? nfsHomeRelativePath(home, toolCache) : undefined;
    const toolPaths = [...HOME_TOOL_PATHS];
    if (relativeToolCache) toolPaths.push(relativeToolCache);
    const uniqueToolPaths = [...new Set(toolPaths
      .filter((toolPath) => toolPath !== '.gemini' || config.geminiApiKey || config.googleApiKey)
      .map((toolPath) => path.normalize(toolPath)))]
      .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length)
      .filter((toolPath, index, all) =>
        !all.slice(0, index).some((parent) => isWithin(parent, toolPath)));

    for (const toolPath of uniqueToolPaths) {
      let sourceFd: number;
      try {
        sourceFd = openSourceDirectory(homeFd, toolPath);
      } catch (error) {
        if (isVanishedSource(error)) continue;
        throw new Error(`NFS home tool state must be a real directory: ${path.join(home, toolPath)}`);
      }
      try {
        let targetParentFd = destinationFd;
        const parentDirectory = path.dirname(toolPath);
        const parentSegments = parentDirectory === '.' ? [] : parentDirectory.split(path.sep).filter(Boolean);
        const openedParentFds: number[] = [];
        try {
          for (const segment of parentSegments) {
            const segmentPath = descriptorPath(targetParentFd, segment);
            try {
              fs.mkdirSync(segmentPath, { mode: 0o700 });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            const nextFd = openDirectoryAt(targetParentFd, segment);
            openedParentFds.push(nextFd);
            targetParentFd = nextFd;
          }
          const targetName = path.basename(toolPath);
          fs.mkdirSync(descriptorPath(targetParentFd, targetName), { mode: 0o700 });
          const targetFd = openDirectoryAt(targetParentFd, targetName);
          try {
            copyDirectoryContents(sourceFd, targetFd, toolPath);
            setOwnership(targetFd);
            fs.fchmodSync(targetFd, 0o700);
          } finally {
            fs.closeSync(targetFd);
          }
        } finally {
          for (const fd of openedParentFds.reverse()) fs.closeSync(fd);
        }
      } finally {
        fs.closeSync(sourceFd);
      }
    }
  } finally {
    if (homeFd !== undefined) fs.closeSync(homeFd);
    fs.closeSync(destinationFd);
  }
}
