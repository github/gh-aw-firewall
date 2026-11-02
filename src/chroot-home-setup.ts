import * as fs from 'fs';
import * as path from 'path';
import { WrapperConfig } from './types';
import { logger } from './logger';
import { getSafeHostUid, getSafeHostGid, getRealUserHome } from './host-env';
import { createMissingOwnedDirectorySegments } from './fs-utils';
import { resolveRunnerToolCachePath } from './runner-tool-cache';
import { HOME_TOOL_PATHS } from './config/mount-policy';

function descriptorPath(fd: number): string {
  return `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${fd}`;
}

function openRealDirectory(directory: string): number {
  const lstat = fs.lstatSync(directory);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${directory}`);
  }
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    if (!fs.fstatSync(fd).isDirectory()) {
      throw new Error(`Expected directory but found non-directory path: ${directory}`);
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function setDirectoryOwnership(fd: number, uid: number, gid: number, mode?: number): void {
  if (!fs.fstatSync(fd).isDirectory()) {
    throw new Error('Expected directory but found non-directory descriptor');
  }
  fs.fchownSync(fd, uid, gid);
  if (mode !== undefined) fs.fchmodSync(fd, mode);
}

// Prepare a nested bind-mount destination inside the empty chroot home before
// Docker sees it. Without this, Docker may create intermediate parents such as
// `<emptyHome>/work` as root-owned directories with restrictive traversal bits,
// causing the chrooted runner user to get EACCES before reaching the leaf mount.
// This operates only on the chroot-home placeholder path, e.g.
// `<emptyHome>/work/_tool`; it does not chown or chmod the real host source
// `/home/runner/work/_tool`, which Docker will later mount over the placeholder.
function prepareChrootHomeMountpointAtFd(
  emptyHomeDir: string,
  emptyHomeFd: number,
  relativeMountPath: string,
  uid: number,
  gid: number,
): string {
  let parentFd = emptyHomeFd;
  let ownedFd: number | undefined;
  let chrootPath = emptyHomeDir;
  const segments = relativeMountPath.split(path.sep).filter(Boolean);

  try {
    for (const segment of segments) {
      const segmentPath = path.join(descriptorPath(parentFd), segment);
      chrootPath = path.join(chrootPath, segment);
      try {
        fs.mkdirSync(segmentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      // The final segment may be the leaf mountpoint (`_tool`). That is okay: this
      // is still only the placeholder inside emptyHomeDir, not the host tool cache.
      const nextFd = openRealDirectory(segmentPath);
      setDirectoryOwnership(nextFd, uid, gid, 0o755);
      if (ownedFd !== undefined) fs.closeSync(ownedFd);
      ownedFd = nextFd;
      parentFd = nextFd;
    }
  } finally {
    if (ownedFd !== undefined) fs.closeSync(ownedFd);
  }

  return segments.length === 0 ? emptyHomeDir : chrootPath;
}

export function prepareChrootHomeMountpoint(
  emptyHomeDir: string,
  relativeMountPath: string,
  uid: number,
  gid: number,
): string {
  const emptyHomeFd = openRealDirectory(emptyHomeDir);
  try {
    return prepareChrootHomeMountpointAtFd(emptyHomeDir, emptyHomeFd, relativeMountPath, uid, gid);
  } finally {
    fs.closeSync(emptyHomeFd);
  }
}

function prepareHomeMountsWithFd(
  config: WrapperConfig,
  effectiveHome: string,
  uid: number,
  gid: number,
  emptyHomeDir: string,
  emptyHomeFd: number,
): void {
  // Ensure source directories and nested chroot mountpoints exist before Docker
  // sees them, so it cannot create either side as root-owned.
  const hostHomeMountSourcePaths = HOME_TOOL_PATHS.filter(
    (toolPath) =>
      toolPath !== '.gemini' || Boolean(config.geminiApiKey || config.googleApiKey),
  );
  for (const toolPath of hostHomeMountSourcePaths) {
    const toolPathSource = path.join(effectiveHome, toolPath);
    const existed = fs.existsSync(toolPathSource);
    createMissingOwnedDirectorySegments(toolPathSource, uid, gid);
    if (!existed) {
      logger.debug(`Created host home tool path: ${toolPathSource} (${uid}:${gid})`);
    } else if (toolPath === '.gemini') {
      // Repair existing .gemini ownership for Gemini/Vertex runs where prior
      // root-owned bind mounts can break atomic writes in the CLI.
      const geminiFd = openRealDirectory(toolPathSource);
      try {
        setDirectoryOwnership(geminiFd, uid, gid);
      } finally {
        fs.closeSync(geminiFd);
      }
      logger.debug(`Fixed host home tool path ownership: ${toolPathSource} (${uid}:${gid})`);
    }

    const chrootToolPath = prepareChrootHomeMountpointAtFd(
      emptyHomeDir,
      emptyHomeFd,
      toolPath,
      uid,
      gid,
    );
    logger.debug(`Prepared chroot home tool mountpoint: ${chrootToolPath} (${uid}:${gid})`);
  }

  // Prepare these nested targets before Docker can create them as root-owned,
  // but only when buildHomeMounts() will use the host .copilot bind.
  const copilotHomeDir = path.join(effectiveHome, '.copilot');
  let copilotHomeAccessible = true;
  try {
    fs.accessSync(copilotHomeDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    copilotHomeAccessible = false;
  }
  if (copilotHomeAccessible) {
    for (const name of ['session-state', 'logs']) {
      createMissingOwnedDirectorySegments(path.join(copilotHomeDir, name), uid, gid);
    }
  }

  // Source-side prep: this only applies when the config file explicitly names
  // a runner tool-cache source path that does not exist yet. Create that host
  // source so Docker has something real to bind-mount later.
  if (config.runnerToolCachePath && !fs.existsSync(config.runnerToolCachePath)) {
    const relToHome = path.relative(effectiveHome, config.runnerToolCachePath);
    const isUnderHome = relToHome && !relToHome.startsWith('..') && !path.isAbsolute(relToHome);

    if (isUnderHome) {
      createMissingOwnedDirectorySegments(config.runnerToolCachePath, uid, gid);
      logger.debug(`Created runner tool cache directory: ${config.runnerToolCachePath} (${uid}:${gid})`);
    } else {
      logger.warn(`Runner tool cache path does not exist; refusing to create outside effective home (${effectiveHome}): ${config.runnerToolCachePath}`);
    }
  }

  // Destination-side prep: resolve the same source path that home-strategy.ts
  // will mount. If that source is nested under the empty chroot home, prepare
  // the placeholder mountpoint there so Docker does not create parents as root.
  const runnerToolCachePath = resolveRunnerToolCachePath(config, effectiveHome);
  if (runnerToolCachePath) {
    const relativeToolCachePath = path.relative(effectiveHome, runnerToolCachePath);
    if (relativeToolCachePath && !relativeToolCachePath.startsWith('..') && !path.isAbsolute(relativeToolCachePath)) {
      const chrootToolCachePath = prepareChrootHomeMountpointAtFd(
        emptyHomeDir,
        emptyHomeFd,
        relativeToolCachePath,
        uid,
        gid,
      );
      logger.debug(`Prepared chroot runner tool cache mountpoint: ${chrootToolCachePath} (${uid}:${gid})`);
    }
  }

  // On GitHub-hosted runners the workspace lives under $HOME
  // (`/home/runner/work/<repo>/<repo>`), so its `/host`-prefixed bind lands
  // inside the chroot home. Docker used to create those parents itself, but
  // once filesystem.allowWrite narrows the chroot home bind to read-only runc
  // can no longer do so and container init fails with EROFS. Prepare the
  // mountpoint up front, exactly as for the tool-cache paths above.
  const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
  const relativeWorkspacePath = path.relative(effectiveHome, workspaceDir);
  if (relativeWorkspacePath && !relativeWorkspacePath.startsWith('..') && !path.isAbsolute(relativeWorkspacePath)) {
    const chrootWorkspacePath = prepareChrootHomeMountpointAtFd(
      emptyHomeDir,
      emptyHomeFd,
      relativeWorkspacePath,
      uid,
      gid,
    );
    logger.debug(`Prepared chroot workspace mountpoint: ${chrootWorkspacePath} (${uid}:${gid})`);
  }
}

/**
 * Creates the empty chroot home directory placeholder, all whitelisted ~/.
 * subdirectories on the host, and any runner tool-cache mountpoints so Docker
 * does not create them as root-owned before bind mounts are established.
 *
 * Security note: this enforces correct UID/GID ownership on chroot home paths
 * before Docker bind-mounts overwrite the placeholders at container start.
 */
export function prepareChrootHomeMounts(config: WrapperConfig): void {
  // Ensure chroot home subdirectories exist with correct ownership before Docker
  // bind-mounts them. If a source directory doesn't exist, Docker creates it as
  // root:root, making it inaccessible to the agent user (e.g., UID 1001).
  // Also create an empty writable home directory that gets mounted as $HOME
  // in the chroot, giving tools a writable home without exposing credentials.
  const effectiveHome = getRealUserHome();
  const uid = parseInt(getSafeHostUid(), 10);
  const gid = parseInt(getSafeHostGid(), 10);

  // Create empty writable home directory for the chroot
  // This is mounted as $HOME inside the container so tools can write to it
  // NOTE: Must be outside workDir to avoid being hidden by the tmpfs overlay
  const emptyHomeDir = `${config.workDir}-chroot-home`;
  if (!fs.existsSync(emptyHomeDir)) {
    fs.mkdirSync(emptyHomeDir, { recursive: true });
  }
  const emptyHomeFd = openRealDirectory(emptyHomeDir);
  try {
    setDirectoryOwnership(emptyHomeFd, uid, gid);
    logger.debug(`Created chroot home directory: ${emptyHomeDir} (${uid}:${gid})`);
    prepareHomeMountsWithFd(config, effectiveHome, uid, gid, emptyHomeDir, emptyHomeFd);
  } finally {
    fs.closeSync(emptyHomeFd);
  }
}
