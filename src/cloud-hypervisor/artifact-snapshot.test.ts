import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import { CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT } from './manager-types';
import { copySparseFileWithRsync, createArtifactSnapshot } from './artifact-snapshot';

jest.mock('execa');

const mockedExeca = execa as jest.MockedFunction<typeof execa>;

function mountInfo(options: string, superblockOptions = 'rw,discard'): string {
  return [
    '27 2 259:1 / / rw,relatime shared:1 - ext4 /dev/root rw,discard',
    `31 27 259:1 /trusted ${CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT} ` +
    `${options} shared:2 - ext4 /dev/root ${superblockOptions}`,
    '',
  ].join('\n');
}

function snapshotSources() {
  return {
    cloudHypervisorBinary: '/source/cloud-hypervisor',
    virtiofsdBinary: '/source/virtiofsd',
    kernelPath: '/source/vmlinux.bin',
    rootfsPath: '/source/rootfs.ext4',
    supervisorPath: '/source/awf-supervisor',
  };
}

describe('Cloud Hypervisor artifact snapshots', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('copies sparse rootfs images with the trusted rsync binary', async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    } as never);

    await copySparseFileWithRsync(
      '/usr/bin/rsync',
      '/source/rootfs.ext4',
      '/destination/rootfs.ext4',
    );

    expect(mockedExeca).toHaveBeenCalledWith(
      '/usr/bin/rsync',
      [
        '--sparse',
        '--',
        '/source/rootfs.ext4',
        '/destination/rootfs.ext4',
      ],
      {
        reject: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  });

  it('fails closed when the sparse rootfs copy fails', async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 23,
      stdout: '',
      stderr: 'No space left on device',
    } as never);

    await expect(copySparseFileWithRsync(
      '/usr/bin/rsync',
      '/source/rootfs.ext4',
      '/destination/rootfs.ext4',
    )).rejects.toThrow(
      'sparse artifact copy failed with code 23: No space left on device',
    );
  });

  it('uses sparse copying only for the trusted rootfs snapshot', async () => {
    expect(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT).toBe(
      '/var/lib/awf-cloud-hypervisor/trusted-artifacts',
    );
    const snapshotDirectory = `${CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT}/snapshot-test`;
    jest.spyOn(fs, 'readFile').mockResolvedValue(mountInfo('rw,relatime'));
    jest.spyOn(fs, 'realpath').mockResolvedValue(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT);
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'mkdtemp').mockResolvedValue(snapshotDirectory);
    const copyFile = jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);
    const copySparseFile = jest.fn().mockResolvedValue(undefined);
    const sources = {
      cloudHypervisorBinary: '/source/cloud-hypervisor',
      virtiofsdBinary: '/source/virtiofsd',
      kernelPath: '/source/vmlinux.bin',
      rootfsPath: '/source/rootfs.ext4',
      supervisorPath: '/source/awf-supervisor',
      manifestPath: '/source/manifest.json',
      bundlePath: '/source/manifest.sigstore.jsonl',
    };

    const snapshot = await createArtifactSnapshot(
      sources,
      copySparseFile,
    );

    expect(snapshot.rootfsPath).toBe(`${snapshotDirectory}/rootfs.ext4`);
    expect(copySparseFile).toHaveBeenCalledWith(
      '/source/rootfs.ext4',
      `${snapshotDirectory}/rootfs.ext4`,
    );
    for (const [source, name] of [
      [sources.cloudHypervisorBinary, 'cloud-hypervisor'],
      [sources.virtiofsdBinary, 'virtiofsd'],
      [sources.kernelPath, 'vmlinux.bin'],
      [sources.supervisorPath, 'awf-supervisor'],
      [sources.manifestPath, 'manifest.json'],
      [sources.bundlePath, 'manifest.sigstore.jsonl'],
    ]) {
      expect(copyFile).toHaveBeenCalledWith(
        source,
        `${snapshotDirectory}/${name}`,
        constants.COPYFILE_EXCL,
      );
    }
    expect(copyFile).not.toHaveBeenCalledWith(
      sources.rootfsPath,
      expect.any(String),
      expect.any(Number),
    );
    expect(fs.mkdir).toHaveBeenCalledWith(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, {
      recursive: true,
      mode: 0o711,
    });
    expect(fs.mkdtemp).toHaveBeenCalledWith(
      path.join(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, 'run-'),
    );
  });

  it('fails closed before staging when the trusted artifact root rejects execution', async () => {
    jest.spyOn(fs, 'readFile').mockResolvedValue(mountInfo('rw,nosuid,nodev,noexec,relatime'));
    jest.spyOn(fs, 'realpath').mockResolvedValue(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT);
    const mkdtemp = jest.spyOn(fs, 'mkdtemp');
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);

    await expect(createArtifactSnapshot(
      snapshotSources(),
      jest.fn(),
    )).rejects.toThrow(
      /trusted artifact root ".*" is on a mount that rejects execution.*options=rw,nosuid,nodev,noexec,relatime.*remount it without "noexec"/s,
    );
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it('checks the resolved mount when the trusted artifact root is a symlink', async () => {
    const resolvedRoot = '/noexec-volume/trusted-artifacts';
    jest.spyOn(fs, 'realpath').mockResolvedValue(resolvedRoot);
    jest.spyOn(fs, 'readFile').mockResolvedValue(
      `27 2 259:1 / / rw,relatime - ext4 /dev/root rw\n` +
      `31 27 0:25 / ${resolvedRoot} rw,nosuid,nodev,noexec - tmpfs tmpfs rw\n`,
    );
    const mkdtemp = jest.spyOn(fs, 'mkdtemp');
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);

    await expect(createArtifactSnapshot(
      snapshotSources(),
      jest.fn(),
    )).rejects.toThrow(
      /mount: \/noexec-volume\/trusted-artifacts .*options=rw,nosuid,nodev,noexec/s,
    );
    expect(fs.realpath).toHaveBeenCalledWith(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT);
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it('checks the lexical mount when resolving the trusted artifact root fails', async () => {
    jest.spyOn(fs, 'realpath').mockRejectedValue(new Error('EACCES'));
    jest.spyOn(fs, 'readFile').mockResolvedValue(mountInfo('rw,noexec'));
    const mkdtemp = jest.spyOn(fs, 'mkdtemp');
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);

    await expect(createArtifactSnapshot(
      snapshotSources(),
      jest.fn(),
    )).rejects.toThrow(/mount that rejects execution/);
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it('rejects a trusted artifact root whose superblock options carry noexec', async () => {
    jest.spyOn(fs, 'readFile').mockResolvedValue(
      mountInfo('rw,relatime', 'rw,noexec,discard'),
    );
    jest.spyOn(fs, 'realpath').mockResolvedValue(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT);
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);

    await expect(createArtifactSnapshot(
      snapshotSources(),
      jest.fn(),
    )).rejects.toThrow(/rejects execution/);
  });

  it('stages artifacts when /proc/self/mountinfo is unreadable', async () => {
    jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('EACCES'));
    jest.spyOn(fs, 'realpath').mockResolvedValue(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT);
    const snapshotDirectory = `${CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT}/run-unreadable`;
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'mkdtemp').mockResolvedValue(snapshotDirectory);
    jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);

    const snapshot = await createArtifactSnapshot(
      snapshotSources(),
      jest.fn().mockResolvedValue(undefined),
    );

    expect(snapshot.directory).toBe(snapshotDirectory);
  });
});
