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
  if (Number(fs.statfsSync(destination).type) === 0x6969) {
    throw new Error('An NFS home requires --work-dir on a local filesystem writable by the runner and accessible to Docker.');
  }
  if (isWithin(home, destination)) {
    throw new Error('An NFS home requires --work-dir outside the host home.');
  }
  if (fs.lstatSync(destination).isSymbolicLink() || fs.readdirSync(destination).length !== 0) {
    throw new Error(`NFS home staging requires an empty, non-symlink chroot home: ${destination}`);
  }
  fs.chmodSync(destination, 0o700);

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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const copy = (source: string, target: string): void => {
    if (excluded.some((entry) => isWithin(entry, source))) return;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isDirectory()) {
      // Exclusive creation refuses stale trees and destination symlinks.
      fs.mkdirSync(target, { mode: 0o700 });
      for (const name of fs.readdirSync(source)) {
        copy(path.join(source, name), path.join(target, name));
      }
    } else if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else if (stat.isFile()) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, (stat.mode & 0o777) | 0o600);
    } else {
      return; // Sockets, FIFOs and devices are deliberately not staged.
    }
    if (!stat.isSymbolicLink()) {
      fs.chownSync(target, Number(getSafeHostUid()), Number(getSafeHostGid()));
    }
  };

  const toolPaths = [...HOME_TOOL_PATHS];
  const toolCache = resolveRunnerToolCachePath(config, home);
  const relative = toolCache ? nfsHomeRelativePath(home, toolCache) : undefined;
  if (relative) {
    if (!toolPaths.some((entry) => isWithin(entry, relative))) toolPaths.push(relative);
  }
  for (const toolPath of toolPaths) {
    if (toolPath === '.gemini' && !config.geminiApiKey && !config.googleApiKey) continue;
    const source = path.join(home, toolPath);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isDirectory() || fs.realpathSync(source) !== path.join(fs.realpathSync(home), toolPath)) {
      throw new Error(`NFS home tool state must be a real directory: ${source}`);
    }
    const target = path.join(destination, toolPath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    copy(source, target);
  }
}
