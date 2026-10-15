import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export const RESOLVED_CONFIG_PUBLICATION_ROOT = '/run/awf-config-audit';
const FILE_NAME = 'awf-resolved-config.json';
export const RESOLVED_CONFIG_ENV = 'AWF_RESOLVED_CONFIG';

export function resolveArtifactOwner(): { uid: number; gid: number } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('Host artifact identity unavailable');
  if (uid !== 0 || (process.env.SUDO_UID === undefined && process.env.SUDO_GID === undefined)) {
    return { uid, gid };
  }
  const parse = (value: string | undefined): number => {
    if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new Error('Invalid sudo artifact identity');
    }
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id >= 0xffffffff) throw new Error('Invalid sudo artifact identity');
    return id;
  };
  return { uid: parse(process.env.SUDO_UID), gid: parse(process.env.SUDO_GID) };
}

/**
 * Node has no openat API. On Linux, procfs descriptor paths keep every lookup
 * anchored to the open parent, including when an ancestor is renamed.
 */
export function openArtifactDirectory(directory: string): number {
  if (process.platform !== 'linux') throw new Error('Safe artifact publication requires Linux procfs');
  if (!path.isAbsolute(directory) || directory === '/' ||
    directory.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Artifact directory requires a clean absolute path');
  }
  let fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const part of directory.slice(1).split('/')) {
      const next = fs.openSync(
        `/proc/self/fd/${fd}/${part}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      fs.closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function writeConfigFile(directoryFd: number, contents: string, owner: { uid: number; gid: number }): void {
  const fd = fs.openSync(`/proc/self/fd/${directoryFd}/${FILE_NAME}`, 'wx', 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe resolved config artifact');
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.fchownSync(fd, owner.uid, owner.gid);
  } finally {
    fs.closeSync(fd);
  }
}

/** The shared audit tree must have no remaining privileged writers. */
export function publishFinalResolvedConfig(directory: string, contents: string): void {
  const owner = resolveArtifactOwner();
  const fd = openArtifactDirectory(directory);
  try {
    writeConfigFile(fd, contents, owner);
  } finally {
    fs.closeSync(fd);
  }
}

export function publishEarlyResolvedConfig(contents: string): string {
  const owner = resolveArtifactOwner();
  const runFd = openArtifactDirectory('/run');
  let rootFd: number | undefined;
  let directoryFd: number | undefined;
  try {
    const runStat = fs.fstatSync(runFd);
    if (runStat.uid !== 0 || (runStat.mode & 0o022) !== 0) throw new Error('Untrusted /run directory');
    const rootPath = `/proc/self/fd/${runFd}/awf-config-audit`;
    let created = false;
    try {
      fs.mkdirSync(rootPath, { mode: 0o711 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    rootFd = fs.openSync(rootPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const rootStat = fs.fstatSync(rootFd);
    if (rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0 ||
      (!created && (rootStat.mode & 0o777) !== 0o711)) {
      throw new Error('Untrusted resolved config publication root');
    }
    if (created) fs.fchmodSync(rootFd, 0o711);
    const allocated = fs.mkdtempSync(`/proc/self/fd/${rootFd}/run-`);
    fs.chmodSync(allocated, 0o700);
    const name = path.basename(allocated);
    directoryFd = fs.openSync(allocated, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    fs.fchmodSync(directoryFd, 0o700);
    writeConfigFile(directoryFd, contents, owner);
    // Last privileged operation on this directory. No cleanup/copy/chmod later.
    fs.fchownSync(directoryFd, owner.uid, owner.gid);
    return `${RESOLVED_CONFIG_PUBLICATION_ROOT}/${name}/${FILE_NAME}`;
  } finally {
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
    if (rootFd !== undefined) fs.closeSync(rootFd);
    fs.closeSync(runFd);
  }
}

export function exportResolvedConfigPath(file: string): void {
  if (/[\r\n]/.test(file) ||
    !/^\/run\/awf-config-audit\/run-[a-zA-Z0-9]{6}\/awf-resolved-config\.json$/.test(file)) {
    throw new Error('Invalid resolved config publication path');
  }
  logger.info(`Resolved configuration available at: ${file}`);
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) return;
  const owner = resolveArtifactOwner();
  const directoryFd = openArtifactDirectory(path.dirname(envFile));
  try {
    const fd = fs.openSync(`/proc/self/fd/${directoryFd}/${path.basename(envFile)}`,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner.uid) {
        throw new Error('Unsafe GitHub environment file');
      }
      fs.writeFileSync(fd, `${RESOLVED_CONFIG_ENV}=${file}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(directoryFd);
  }
}
