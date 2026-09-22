import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import { CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT } from './manager-types';
import {
  findMountForPath,
  mountRejectsExecution,
  type CloudHypervisorMountDescription,
} from './preflight-diagnostics';

const CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_PARENT = path.dirname(
  CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT,
);

export interface CloudHypervisorArtifactSnapshotSources {
  cloudHypervisorBinary: string;
  virtiofsdBinary: string;
  kernelPath: string;
  rootfsPath: string;
  supervisorPath: string;
  manifestPath?: string;
  bundlePath?: string;
}

export interface CloudHypervisorArtifactSnapshot extends CloudHypervisorArtifactSnapshotSources {
  directory: string;
}

/**
 * Fails closed before any artifact is staged when the trusted-artifact root
 * sits on a `noexec` mount. Without this the copy succeeds and the failure
 * only surfaces later as an opaque `EACCES` from the `--version` probe,
 * which aborts the whole engine run. See gh-aw-firewall#8827.
 *
 * Best effort: when `/proc/self/mountinfo` is unreadable or has no matching
 * entry the staging continues, and the digest-verified `--version` probe
 * remains the authoritative execution check.
 */
async function assertExecCapableArtifactRoot(directory: string): Promise<void> {
  let resolvedDirectory = directory;
  try {
    resolvedDirectory = await fs.realpath(directory);
  } catch {
    // Fall back to the lexical path so mountinfo can still detect noexec.
  }
  let mount: CloudHypervisorMountDescription | undefined;
  try {
    mount = findMountForPath(
      await fs.readFile('/proc/self/mountinfo', 'utf8'),
      resolvedDirectory,
    );
  } catch {
    return;
  }
  if (!mount || !mountRejectsExecution(mount)) return;
  throw new Error(
    `Cloud Hypervisor trusted artifact root "${directory}" is on a mount that rejects ` +
    `execution (mount: ${mount.mountPoint} type=${mount.filesystemType} ` +
    `source=${mount.source} options=${mount.options} superblock=${mount.superblockOptions}); ` +
    'remount it without "noexec" so the staged cloud-hypervisor binary can be executed',
  );
}

export async function createArtifactSnapshot(
  sources: CloudHypervisorArtifactSnapshotSources,
  copySparseFile: (source: string, destination: string) => Promise<void>,
): Promise<CloudHypervisorArtifactSnapshot> {
  await fs.mkdir(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_PARENT, {
    recursive: true,
    mode: 0o711,
  });
  await fs.chmod(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_PARENT, 0o711);
  await fs.mkdir(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, {
    recursive: true,
    mode: 0o711,
  });
  await fs.chmod(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, 0o711);
  await assertExecCapableArtifactRoot(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT);
  const directory = await fs.mkdtemp(
    path.join(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, 'run-'),
  );
  const copy = async (
    source: string,
    name: string,
    mode: number,
  ): Promise<string> => {
    const destination = path.join(directory, name);
    if (name === 'rootfs.ext4') {
      await copySparseFile(source, destination);
    } else {
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    }
    await fs.chmod(destination, mode);
    return destination;
  };
  try {
    const snapshot: CloudHypervisorArtifactSnapshot = {
      directory,
      cloudHypervisorBinary: await copy(
        sources.cloudHypervisorBinary,
        'cloud-hypervisor',
        0o555,
      ),
      virtiofsdBinary: await copy(sources.virtiofsdBinary, 'virtiofsd', 0o555),
      kernelPath: await copy(sources.kernelPath, 'vmlinux.bin', 0o444),
      rootfsPath: await copy(sources.rootfsPath, 'rootfs.ext4', 0o444),
      supervisorPath: await copy(sources.supervisorPath, 'awf-supervisor', 0o555),
    };
    if (sources.manifestPath) {
      snapshot.manifestPath = await copy(sources.manifestPath, 'manifest.json', 0o444);
    }

    if (sources.bundlePath) {
      snapshot.bundlePath = await copy(
        sources.bundlePath,
        'manifest.sigstore.jsonl',
        0o444,
      );
    }
    await fs.chmod(directory, 0o555);
    return snapshot;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function copySparseFileWithRsync(
  rsyncBinaryPath: string,
  source: string,
  destination: string,
): Promise<void> {
  const result = await execa(rsyncBinaryPath, ['--sparse', '--', source, destination], {
    reject: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `sparse artifact copy failed with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
}
