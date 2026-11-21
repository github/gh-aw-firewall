import * as fs from 'fs';
import { WrapperConfig } from './types';
import { createNfsHomeCopier, descriptorPath, isWithin } from './nfs-home-copy';
import { buildNfsHomeExclusions } from './nfs-home-exclusions';
import { stageNfsHomeTools } from './nfs-home-tools';

export { nfsHomeRelativePath } from './nfs-home-tools';

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

    const excluded = buildNfsHomeExclusions(config, home);
    const copier = createNfsHomeCopier(home, excluded);
    stageNfsHomeTools(config, home, homeFd, destinationFd, copier);
  } finally {
    if (homeFd !== undefined) fs.closeSync(homeFd);
    fs.closeSync(destinationFd);
  }
}
