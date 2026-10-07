import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import { CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT } from './manager-types';
import { copySparseFileWithRsync, createArtifactSnapshot } from './artifact-snapshot';
import {
  HostPreflightReporter, hostPreflightReason, HostPreflightCleanupError,
  type HostPreflightCheck, type HostPreflightProgress,
} from './host-preflight-progress';

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

  describe('actual snapshot failure origins', () => {
    const root = `/run/awf-cloud-hypervisor/enclave-storage/${'a'.repeat(32)}/artifacts`;
    const directory = `${root}/run-fixture`;
    const files = [
      ['vmm', 'cloud-hypervisor'], ['virtiofsd', 'virtiofsd'], ['kernel', 'vmlinux.bin'],
      ['rootfs', 'rootfs.ext4'], ['supervisor', 'awf-supervisor'],
      ['manifest', 'manifest.json'], ['bundle', 'manifest.sigstore.jsonl'],
    ] as const;
    let published: HostPreflightProgress[];
    let report: HostPreflightReporter;
    let capture: jest.Mock;
    let sparse: jest.Mock;
    const sources = {
      ...snapshotSources(), manifestPath: '/source/manifest.json', bundlePath: '/source/bundle.jsonl',
    };
    const latest = () => published[published.length - 1];
    const run = () => createArtifactSnapshot(sources, sparse, capture, root, report);

    beforeEach(() => {
      published = [];
      report = new HostPreflightReporter('artifact-snapshot', (value) => published.push(value));
      capture = jest.fn().mockResolvedValue(undefined);
      sparse = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(fs, 'realpath').mockImplementation(async (file) => String(file));
      jest.spyOn(fs, 'readFile').mockResolvedValue(
        `901 1 0:50 /artifacts ${root} rw,nosuid,nodev - tmpfs awf-enclave-invocation rw\n`,
      );
      jest.spyOn(fs, 'mkdtemp').mockResolvedValue(directory);
      jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
      jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);
      jest.spyOn(fs, 'rm').mockResolvedValue(undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it.each([
      'root', 'directory', 'identity', 'directory-mode',
      ...files.flatMap(([gate]) => [`${gate}-copy`, `${gate}-mode`]),
    ] as HostPreflightCheck[])('distinguishes the actual %s operation and never reaches later sealing', async (gate) => {
      const error = Object.assign(new Error('/private/token\n192.0.2.1 Bearer secret'), { code: 'ENOSPC' });
      if (gate === 'root') (fs.realpath as jest.Mock).mockRejectedValue(error);
      if (gate === 'directory') (fs.mkdtemp as jest.Mock).mockRejectedValue(error);
      if (gate === 'identity') capture.mockRejectedValue(error);
      const file = files.find(([id]) => gate.startsWith(`${id}-`))?.[1];
      if (gate.endsWith('-copy')) {
        if (gate === 'rootfs-copy') sparse.mockRejectedValue(error);
        else (fs.copyFile as jest.Mock).mockImplementation(async (_source, target) => {
          if (target === `${directory}/${file}`) throw error;
        });
      }
      if (gate.endsWith('-mode')) (fs.chmod as jest.Mock).mockImplementation(async (target) => {
        if (target === (gate === 'directory-mode' ? directory : `${directory}/${file}`)) throw error;
      });
      await expect(run()).rejects.toBe(error);
      expect(latest().checks.filter((check) => check.result === 'failed'))
        .toEqual([{ id: gate, result: 'failed', reason: 'ENOSPC' }]);
      for (const id of ['mount-intent', 'bind', 'mount-capture', 'readonly-exec', 'sealed-storage']) {
        expect(latest().checks.find((check) => check.id === id)?.result).toBe('not-attempted');
      }
      expect(JSON.stringify(published)).not.toMatch(/private|token|192\.0\.2\.1|Bearer|secret|source/);
      if (gate === 'root' || gate === 'directory') expect(fs.rm).not.toHaveBeenCalled();
      else expect(latest().checks.find((check) => check.id === 'partial-remove')?.result).toBe('passed');
      if (gate === 'rootfs-copy') {
        expect(fs.chmod).not.toHaveBeenCalledWith(`${directory}/rootfs.ext4`, expect.anything());
        expect(fs.copyFile).not.toHaveBeenCalledWith(sources.supervisorPath, expect.anything(), expect.anything());
      }
    });

    it('preserves the primary failure and the failed partial cleanup independently', async () => {
      const primary = Object.assign(new Error('private source'), { code: 'EIO' });
      const cleanup = Object.assign(new Error('private target'), { code: 'EPERM' });
      sparse.mockRejectedValue(primary);
      (fs.rm as jest.Mock).mockRejectedValue(cleanup);
      await expect(run()).rejects.toMatchObject({ cause: primary, cleanupError: cleanup });
      expect(latest().checks.filter((check) => check.result === 'failed')).toEqual([
        { id: 'rootfs-copy', result: 'failed', reason: 'EIO' },
        { id: 'partial-remove', result: 'failed', reason: 'EPERM' },
      ]);
      const combined = new HostPreflightCleanupError(primary, cleanup);
      expect(hostPreflightReason(combined)).toBe('EIO');
    });

    it.each(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO', 'ELOOP', 'unrecognized'])(
      'reports only the allowlisted errno %s, never malicious error text', async (code) => {
        const error = Object.assign(new Error('ENOSPC /private/SECRET\nBearer token'), { code });
        capture.mockRejectedValue(error);
        await expect(run()).rejects.toBe(error);
        expect(latest().checks.find((check) => check.id === 'identity')?.reason)
          .toBe(code === 'unrecognized' ? 'unknown' : code);
        expect(JSON.stringify(published)).not.toMatch(/private|SECRET|Bearer|token/);
      },
    );

    it.each([
      [11, 'rsync-file-io'], [23, 'rsync-partial-transfer'], [24, 'rsync-source-vanished'],
      [12, 'command-failed'], [null, 'command-failed'],
    ])('classifies rsync exit %s without claiming that stderr proves ENOSPC', async (exitCode, reason) => {
      mockedExeca.mockResolvedValue({ exitCode, stderr: 'ENOSPC /private/token', stdout: '' } as never);
      sparse.mockImplementation((source, destination) => copySparseFileWithRsync('/trusted/rsync', source, destination));
      await expect(run()).rejects.toThrow('sparse artifact copy failed');
      expect(latest().checks.find((check) => check.id === 'rootfs-copy'))
        .toEqual({ id: 'rootfs-copy', result: 'failed', reason });
      expect(JSON.stringify(published)).not.toContain('token');
    });

    it('reports each successful copy and mode transition, without claiming the bind view is sealed', async () => {
      await run();
      for (const [gate] of files) {
        for (const id of [`${gate}-copy`, `${gate}-mode`]) {
          expect(published.map((value) => value.checks.find((check) => check.id === id)?.result))
            .toEqual(expect.arrayContaining(['not-attempted', 'attempted', 'passed']));
        }
      }
      expect(latest().checks.find((check) => check.id === 'partial-remove')?.result).toBe('not-required');
      expect(latest().checks.find((check) => check.id === 'readonly-exec')?.result).toBe('not-attempted');
    });

    it('retains a trusted rsync spawn errno rather than interpreting the message', async () => {
      const error = Object.assign(new Error('ENOSPC /private/secret'), { code: 'EACCES' });
      mockedExeca.mockRejectedValue(error);
      sparse.mockImplementation((source, destination) => copySparseFileWithRsync('/trusted/rsync', source, destination));
      await expect(run()).rejects.toBe(error);
      expect(latest().checks.find((check) => check.id === 'rootfs-copy')?.reason).toBe('EACCES');
      expect(JSON.stringify(published)).not.toContain('secret');
    });

    it('identifies a noexec staging root before allocating or copying', async () => {
      (fs.readFile as jest.Mock).mockResolvedValue(
        `901 1 0:50 /artifacts ${root} rw,nosuid,nodev,noexec - tmpfs awf-enclave-invocation rw\n`,
      );
      await expect(run()).rejects.toThrow('rejects execution');
      expect(latest().checks.find((check) => check.id === 'root'))
        .toEqual({ id: 'root', result: 'failed', reason: 'mount-noexec' });
      expect(fs.mkdtemp).not.toHaveBeenCalled();
      expect(fs.copyFile).not.toHaveBeenCalled();
      expect(fs.rm).not.toHaveBeenCalled();
    });

    it('keeps overlapping snapshots and partial cleanup confined to their own allocated directories', async () => {
      (fs.mkdtemp as jest.Mock).mockResolvedValueOnce(`${root}/run-one`).mockResolvedValueOnce(`${root}/run-two`);
      const error = Object.assign(new Error('partial write'), { code: 'EIO' });
      sparse.mockImplementation(async (_source, destination) => {
        if (String(destination).includes('/run-one/')) throw error;
      });
      const results = await Promise.allSettled([run(), createArtifactSnapshot(sources, sparse, capture, root)]);
      expect(results).toEqual(expect.arrayContaining([
        { status: 'rejected', reason: error },
        expect.objectContaining({ status: 'fulfilled', value: expect.objectContaining({ directory: `${root}/run-two` }) }),
      ]));
      expect(fs.rm).toHaveBeenCalledTimes(1);
      expect(fs.rm).toHaveBeenCalledWith(`${root}/run-one`, { recursive: true, force: true });
    });
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

  it('stages every invocation artifact only inside the exact bounded invocation root', async () => {
    const root = `/run/awf-cloud-hypervisor/enclave-storage/${'a'.repeat(32)}/artifacts`;
    const directory = path.join(root, 'run-fixture');
    jest.spyOn(fs, 'realpath').mockResolvedValue(root);
    jest.spyOn(fs, 'readFile').mockResolvedValue(`901 1 0:50 /artifacts ${root} rw,nosuid,nodev - tmpfs awf-enclave-invocation rw\n`);
    const mkdir = jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const mkdtemp = jest.spyOn(fs, 'mkdtemp').mockResolvedValue(directory);
    const copyFile = jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
    const chmod = jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);
    const sparseCopy = jest.fn().mockResolvedValue(undefined);
    const capture = jest.fn();
    const snapshot = await createArtifactSnapshot({
      ...snapshotSources(), manifestPath: '/source/manifest.json', bundlePath: '/source/bundle.jsonl',
    }, sparseCopy, capture, root);
    expect(mkdir).not.toHaveBeenCalled();
    expect(mkdtemp).toHaveBeenCalledWith(path.join(root, 'run-'));
    expect(capture).toHaveBeenCalledWith(directory);
    expect(copyFile).toHaveBeenCalledTimes(6);
    expect(sparseCopy).toHaveBeenCalledWith('/source/rootfs.ext4', path.join(directory, 'rootfs.ext4'));
    for (const file of Object.values(snapshot)) expect(String(file).startsWith(`${directory}/`) || file === directory).toBe(true);
    for (const [, destination] of copyFile.mock.calls) expect(String(destination).startsWith(`${directory}/`)).toBe(true);
    for (const [destination] of chmod.mock.calls) expect(String(destination).startsWith(`${directory}/`) || destination === directory).toBe(true);
  });

  it('rejects arbitrary custom artifact roots without creating a global fallback snapshot', async () => {
    const mkdir = jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const mkdtemp = jest.spyOn(fs, 'mkdtemp').mockResolvedValue('/unused');
    await expect(createArtifactSnapshot(snapshotSources(), jest.fn(), undefined, '/arbitrary/artifacts'))
      .rejects.toThrow('Invalid invocation artifact root');
    expect(mkdir).not.toHaveBeenCalled();
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it('requires an exec-capable invocation artifact view before copying binaries', async () => {
    const root = `/run/awf-cloud-hypervisor/enclave-storage/${'a'.repeat(32)}/artifacts`;
    jest.spyOn(fs, 'realpath').mockResolvedValue(root);
    jest.spyOn(fs, 'readFile').mockResolvedValue(`901 1 0:50 /artifacts ${root} rw,nosuid,nodev,noexec - tmpfs awf-enclave-invocation rw\n`);
    const mkdtemp = jest.spyOn(fs, 'mkdtemp').mockResolvedValue('/unused');
    await expect(createArtifactSnapshot(snapshotSources(), jest.fn(), undefined, root))
      .rejects.toThrow('rejects execution');
    expect(mkdtemp).not.toHaveBeenCalled();
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

  it('commits the snapshot identity before copying any artifacts', async () => {
    const directory = `${CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT}/run-journaled`;
    jest.spyOn(fs, 'readFile').mockResolvedValue(mountInfo('rw,relatime'));
    jest.spyOn(fs, 'realpath').mockResolvedValue(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT);
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'mkdtemp').mockResolvedValue(directory);
    jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);
    let committed = false;
    const copyFile = jest.spyOn(fs, 'copyFile').mockImplementation(async () => {
      expect(committed).toBe(true);
    });
    const copySparseFile = jest.fn(async () => {
      expect(committed).toBe(true);
    });
    const onDirectoryCreated = jest.fn(async (created: string) => {
      expect(created).toBe(directory);
      expect(copyFile).not.toHaveBeenCalled();
      expect(copySparseFile).not.toHaveBeenCalled();
      committed = true;
    });
    await expect(createArtifactSnapshot(snapshotSources(), copySparseFile, onDirectoryCreated))
      .resolves.toHaveProperty('directory', directory);
    expect(onDirectoryCreated).toHaveBeenCalledTimes(1);
  });

  it('removes the new snapshot and copies nothing if the identity commit fails', async () => {
    const directory = `${CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT}/run-uncommitted`;
    jest.spyOn(fs, 'readFile').mockResolvedValue(mountInfo('rw,relatime'));
    jest.spyOn(fs, 'realpath').mockResolvedValue(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT);
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'mkdtemp').mockResolvedValue(directory);
    jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);
    const copyFile = jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
    const remove = jest.spyOn(fs, 'rm').mockResolvedValue(undefined);
    const copySparseFile = jest.fn();
    await expect(createArtifactSnapshot(snapshotSources(), copySparseFile, async () => {
      throw new Error('journal unavailable');
    })).rejects.toThrow('journal unavailable');
    expect(copyFile).not.toHaveBeenCalled();
    expect(copySparseFile).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(directory, { recursive: true, force: true });
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
