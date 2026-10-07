import * as fs from 'fs';
import * as path from 'path';
import {
  HostExecutorJournal, HostExecutorResourceJournal, reapHostExecutorResources,
  hostExecutorVmRunId, hostExecutorJournalDirectory,
  HOST_EXECUTOR_STORAGE_ROOT, hostExecutorStorageDirectory,
} from './host-executor-journal';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from './host-executor-server';
import type { CleanupRegistryDependencies } from '../cloud-hypervisor/cleanup-dependencies';
import type { CloudHypervisorCleanupRegistry } from '../cloud-hypervisor/cleanup-registry';
import {
  HostPreflightReporter, hostPreflightReason,
  type HostPreflightProgress, type HostPreflightReason,
} from '../cloud-hypervisor/host-preflight-progress';

describe('durable host executor journal', () => {
  let root: string;
  let run: HostExecutorRunState;
  let plan: HostExecutorInvocationPlan;
  let bootId: string;
  let mountInfo: string;
  let dependencies: CleanupRegistryDependencies;
  let registry: CloudHypervisorCleanupRegistry;
  const vmRunId = () => hostExecutorVmRunId(plan);
  const tools = {
    ip: '/trusted/ip', umount: '/trusted/umount', getfacl: '/trusted/getfacl',
    groupdel: '/trusted/groupdel', getent: '/trusted/getent', id: '/trusted/id',
    setfacl: '/trusted/setfacl', useradd: '/trusted/useradd', userdel: '/trusted/userdel',
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.hj-'));
    run = {
      runId: 'a'.repeat(32), seedsDir: path.join(root, 'seeds'),
      invocationsDir: path.join(root, 'invocations'), journalDir: path.join(root, 'journal'),
      entries: [],
    };
    fs.mkdirSync(path.join(run.invocationsDir, 'script'), { recursive: true, mode: 0o700 });
    plan = {
      runId: run.runId, entryId: 'script', invocationId: 'b'.repeat(24),
      executorKind: 'script', timeoutMs: 1000, requestHash: 'c'.repeat(64),
      admissionId: 'd'.repeat(24), schemaHash: 'e'.repeat(64),
      schema: { type: 'boolean' }, payload: 'private-script',
      invocationHostDir: path.join(run.invocationsDir, 'script', 'b'.repeat(24)),
    };
    bootId = 'initial-boot';
    mountInfo = '';
    const processStartTime = '12345';
    const processExecutable = process.execPath;
    const processNetworkNamespace = 'net:[4026531840]';
    dependencies = {
      rootDirectory: path.join(root, 'vm-registry'),
      readFile: (async (file: fs.PathLike | fs.promises.FileHandle, options?: BufferEncoding) => {
        if (file === '/proc/sys/kernel/random/boot_id') return bootId;
        if (file === '/proc/self/mountinfo') return mountInfo;
        if (file === `/proc/${process.pid}/stat`) {
          const fields = Array(20).fill('0');
          fields[0] = 'S';
          fields[19] = processStartTime;
          return `${process.pid} (node) ${fields.join(' ')}`;
        }
        if (file === `/proc/${process.pid}/status`) {
          const uid = process.getuid?.() ?? 0;
          const gid = process.getgid?.() ?? 0;
          return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${gid}\t${gid}\t${gid}\t${gid}\n`;
        }
        return fs.promises.readFile(file, options ?? null);
      }) as typeof fs.promises.readFile,
      readlink: (async (file: fs.PathLike) => {
        if (file === `/proc/${process.pid}/exe`) return processExecutable;
        if (file === `/proc/${process.pid}/ns/net`) return processNetworkNamespace;
        return fs.promises.readlink(file);
      }) as typeof fs.promises.readlink,
      stat: (async (file: fs.PathLike, options?: fs.StatOptions) => {
        if (file === `/proc/${process.pid}/exe`) return fs.promises.stat(processExecutable, options);
        return fs.promises.stat(file, options);
      }) as typeof fs.promises.stat,
      run: jest.fn(async () => {
        mountInfo = '';
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };
    registry = {
      hasPendingRecord: jest.fn(async (runId: string) => {
        try {
          await fs.promises.lstat(path.join(
            dependencies.rootDirectory!, 'pending-cleanup', `${runId}.json`,
          ));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      }),
      reapPending: jest.fn(async () => undefined),
      create: jest.fn(), createPending: jest.fn(),
    };
    jest.spyOn(dependencies, 'readFile');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function resourceJournal() {
    return HostExecutorResourceJournal.create(run, plan, vmRunId(), dependencies);
  }

  const reap = () => reapHostExecutorResources(run.journalDir!, registry, tools, dependencies);
  const recordFile = () => path.join(run.journalDir!, `${run.runId}-${plan.invocationId}.resources.json`);
  const readRecord = () => JSON.parse(fs.readFileSync(recordFile(), 'utf8'));

  async function mountedJournal() {
    const journal = await resourceJournal();
    fs.mkdirSync(plan.invocationHostDir, { mode: 0o700 });
    await journal.captureDirectory();
    mountInfo = `901 1 0:50 / ${plan.invocationHostDir} rw - tmpfs awf-enclave-invocation rw\n`;
    await journal.captureMount();
    return journal;
  }

  async function aggregateStorageJournal(captureSnapshotMount = true) {
    const storageRoot = hostExecutorStorageDirectory(vmRunId());
    let storageExists = true;
    const originalLstat = fs.promises.lstat;
    dependencies = { ...dependencies, lstat: (async (file: fs.PathLike) => {
      const directory = String(file);
      if (['/', '/run', path.dirname(HOST_EXECUTOR_STORAGE_ROOT), HOST_EXECUTOR_STORAGE_ROOT].includes(directory) || directory === storageRoot ||
        directory.startsWith(`${storageRoot}/`)) {
        if (!storageExists && (directory === storageRoot || directory.startsWith(`${storageRoot}/`))) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return {
          uid: process.getuid?.() ?? 0, mode: 0o40711, dev: 50,
          ino: directory === HOST_EXECUTOR_STORAGE_ROOT ? 600 : 700,
          isDirectory: () => true, isSymbolicLink: () => false,
        };
      }
      return originalLstat(file);
    }) as typeof fs.promises.lstat,
    realpath: (async (file: fs.PathLike) => String(file)) as typeof fs.promises.realpath,
    rm: jest.fn(async (directory, options) => {
      if (directory === storageRoot) { storageExists = false; return; }
      await fs.promises.rm(directory, options);
    }),
    run: jest.fn(async (_command, args) => {
      mountInfo = mountInfo.split('\n').filter((line) => !line.includes(` ${args[0]} `)).join('\n');
      return { exitCode: 0, stdout: '', stderr: '' };
    }) };
    jest.spyOn(dependencies, 'realpath');
    const journal = await resourceJournal();
    await journal.prepareStorage();
    await journal.captureStorageDirectory();
    await journal.prepareStorageMount(storageRoot);
    mountInfo = `1000 1 0:50 / ${storageRoot} rw,nosuid,nodev - tmpfs awf-enclave-invocation rw\n`;
    await journal.captureStorageMount();
    fs.mkdirSync(plan.invocationHostDir, { mode: 0o700 });
    await journal.captureDirectory();
    await journal.prepareStorageMount(plan.invocationHostDir);
    mountInfo += `1001 1 0:50 /state ${plan.invocationHostDir} rw,nosuid,nodev,noexec - tmpfs awf-enclave-invocation rw\n`;
    await journal.captureStorageMount();
    await journal.captureMount();
    const snapshot = path.join(storageRoot, 'artifacts', 'run-fixture');
    await journal.prepareSnapshot();
    await journal.captureSnapshot(snapshot);
    await journal.prepareStorageMount(snapshot);
    mountInfo += `1002 1 0:50 /artifacts/run-fixture ${snapshot} ro,nosuid,nodev - tmpfs awf-enclave-invocation rw\n`;
    if (captureSnapshotMount) await journal.captureStorageMount();
    return { journal, storageRoot, snapshot };
  }

  const captureIds = [
    'canonical-path', 'mountinfo-read', 'mountinfo-parse', 'match-count', 'filesystem', 'source',
    'journal-open', 'journal-write', 'journal-file-sync', 'journal-file-close',
    'journal-publish', 'journal-directory-sync', 'journal-staging-remove',
  ];

  it.each([
    ['stacked', 'match-count', 'storage-mount-multiple'],
    ['missing', 'match-count', 'storage-mount-missing'],
    ['canonical', 'canonical-path', 'storage-path-changed'],
    ['filesystem', 'filesystem', 'storage-mount-filesystem'],
    ['source', 'source', 'storage-mount-source'],
    ['read', 'mountinfo-read', 'EIO'],
    ['parse', 'mountinfo-parse', 'mountinfo-malformed'],
  ] as const)('distinguishes %s mount capture failure and retains fail-closed cleanup', async (failure, id, reason) => {
    const { journal, snapshot } = await aggregateStorageJournal(false);
    if (failure === 'stacked') {
      mountInfo += `2002 1002 0:50 /artifacts/run-fixture ${snapshot} rw - tmpfs awf-enclave-invocation rw\n`;
    }
    if (failure === 'missing') {
      mountInfo = mountInfo.split('\n').filter((line) => !line.includes(` ${snapshot} `)).join('\n');
    }
    if (failure === 'canonical') {
      (dependencies.realpath as jest.Mock).mockImplementation(async (file) =>
        String(file) === snapshot ? '/private/SECRET' : String(file));
    }
    if (failure === 'filesystem' || failure === 'source') {
      mountInfo = mountInfo.split('\n').map((line) => line.includes(` ${snapshot} `)
        ? line.replace('tmpfs awf-enclave-invocation', failure === 'filesystem'
          ? 'ext4 /private/SECRET' : 'tmpfs PRIVATE_SENTINEL')
        : line).join('\n');
    }
    if (failure === 'parse') mountInfo += '\nmalformed PRIVATE_SENTINEL\n';
    const original = Object.assign(new Error('/private/SECRET Bearer credential'), { code: 'EIO' });
    if (failure === 'read') (dependencies.readFile as jest.Mock).mockRejectedValueOnce(original);
    const publish = jest.fn<void, [HostPreflightProgress]>();
    await expect(journal.captureStorageMount(new HostPreflightReporter('storage-mount-capture', publish)))
      .rejects.toThrow();
    const last = publish.mock.calls[publish.mock.calls.length - 1][0];
    expect(last.checks).toEqual(captureIds.map((check, index) => ({
      id: check, result: index < captureIds.indexOf(id) ? 'passed' : check === id ? 'failed' : 'not-attempted',
      reason: check === id ? reason : 'none',
    })));
    expect(readRecord().storage.pending).toBe(snapshot);
    expect(readRecord().storage.mounts.some((mount: { mountPoint: string }) => mount.mountPoint === snapshot)).toBe(false);
    await expect(journal.closeStorage(tools.umount)).rejects.toThrow('Storage identity is uncommitted');
    try { await journal.closeStorage(tools.umount); } catch (error) {
      expect(hostPreflightReason(error)).toBe('storage-identity-uncommitted');
    }
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(dependencies.rm).not.toHaveBeenCalled();
    expect(JSON.stringify(publish.mock.calls)).not.toMatch(/private|SECRET|PRIVATE_SENTINEL|Bearer|credential/);
  });

  it('captures escaped mountpoints and optional fields without exporting any mount-table data', async () => {
    const { journal, snapshot } = await aggregateStorageJournal(false);
    mountInfo += '3100 1 8:1 / /unrelated\\040directory rw shared:12 future:tag - ext4 /dev/SECRET rw\n';
    mountInfo = mountInfo.replace(` ${snapshot} `, ` ${snapshot.replace('run-fixture', '\\162un-fixture')} `);
    const publish = jest.fn<void, [HostPreflightProgress]>();
    await journal.captureStorageMount(new HostPreflightReporter('storage-mount-capture', publish));
    const last = publish.mock.calls[publish.mock.calls.length - 1][0];
    expect(last.checks.map((check) => check.id)).toEqual(captureIds);
    expect(last.checks.every((check) => check.result === 'passed' && check.reason === 'none')).toBe(true);
    expect(readRecord().storage.pending).toBeUndefined();
    expect(readRecord().storage.mounts.filter((mount: { mountPoint: string }) => mount.mountPoint === snapshot)).toHaveLength(1);
    expect(JSON.stringify(publish.mock.calls)).not.toMatch(/SECRET|unrelated|run-fixture/);
  });

  it.each([
    ['journal-open', 'ENOSPC'],
    ['journal-write', 'ENOSPC'],
    ['journal-file-sync', 'EIO'],
    ['journal-file-close', 'EIO'],
    ['journal-publish', 'EROFS'],
    ['journal-directory-sync', 'EIO'],
    ['journal-staging-remove', 'EACCES'],
    ['journal-write', 'unrecognized-private-code'],
  ] as const)('separates successful mount identity from %s failure (%s)', async (id, code) => {
    const { journal, snapshot } = await aggregateStorageJournal(false);
    const nodeFs = jest.requireActual<typeof fs>('fs');
    const original = Object.assign(new Error('/private/SECRET Bearer credential'), { code });
    if (id === 'journal-open') jest.spyOn(nodeFs, 'openSync').mockImplementationOnce(() => { throw original; });
    if (id === 'journal-write') jest.spyOn(nodeFs, 'writeFileSync').mockImplementationOnce(() => { throw original; });
    if (id === 'journal-file-sync' || id === 'journal-directory-sync') {
      const sync = nodeFs.fsyncSync;
      jest.spyOn(nodeFs, 'fsyncSync').mockImplementation((fd) => {
        if (nodeFs.fstatSync(fd).isDirectory() === (id === 'journal-directory-sync')) throw original;
        sync(fd);
      });
    }
    if (id === 'journal-file-close') {
      const close = nodeFs.closeSync;
      jest.spyOn(nodeFs, 'closeSync').mockImplementationOnce((fd) => { close(fd); throw original; });
    }
    if (id === 'journal-publish') jest.spyOn(nodeFs, 'renameSync').mockImplementationOnce(() => { throw original; });
    if (id === 'journal-staging-remove') jest.spyOn(nodeFs, 'existsSync').mockImplementationOnce(() => { throw original; });
    const publish = jest.fn<void, [HostPreflightProgress]>();
    await expect(journal.captureStorageMount(new HostPreflightReporter('storage-mount-capture', publish)))
      .rejects.toBe(original);
    const last = publish.mock.calls[publish.mock.calls.length - 1][0];
    expect(last.checks.filter((check) => check.result === 'failed')).toEqual([{
      id, result: 'failed', reason: code === 'unrecognized-private-code' ? 'unknown' : code as HostPreflightReason,
    }]);
    for (const check of captureIds.slice(0, 6)) {
      expect(last.checks.find((item) => item.id === check)?.result).toBe('passed');
    }
    const recordPublished = ['journal-directory-sync', 'journal-staging-remove'].includes(id);
    jest.restoreAllMocks();
    expect(readRecord().storage.pending).toBe(recordPublished ? undefined : snapshot);
    if (!recordPublished) {
      const stale = readRecord();
      stale.owner.startTime = '999';
      fs.writeFileSync(recordFile(), JSON.stringify(stale), { mode: 0o600 });
      await expect(reap()).rejects.toThrow('uncommitted');
      expect(dependencies.run).not.toHaveBeenCalled();
      expect(dependencies.rm).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(publish.mock.calls)).not.toMatch(/private|SECRET|Bearer|credential|unrecognized/);
  });

  it('classifies unrecorded and replaced mounts independently of the original capture error', async () => {
    const { journal, snapshot } = await aggregateStorageJournal();
    mountInfo += '2000 1 0:50 / /outside-bind rw - tmpfs awf-enclave-invocation rw\n';
    try { await journal.verifyStorage(); throw new Error('expected rejection'); } catch (error) {
      expect(hostPreflightReason(error)).toBe('storage-mount-unrecorded');
    }
    mountInfo = mountInfo.split('\n').filter((line) => !line.includes(' /outside-bind ')).join('\n');
    mountInfo = mountInfo.replace(`1002 1 0:50 /artifacts/run-fixture ${snapshot}`, `2002 1 0:50 /artifacts/run-fixture ${snapshot}`);
    try { await journal.closeStorage(tools.umount); throw new Error('expected rejection'); } catch (error) {
      expect(hostPreflightReason(error)).toBe('storage-mount-identity-changed');
    }
    expect(dependencies.run).not.toHaveBeenCalled();
  });

  it('recovers one identity-matched aggregate superblock after VM cleanup, never replaying the invocation', async () => {
    const { storageRoot, snapshot } = await aggregateStorageJournal();
    const stale = readRecord();
    stale.owner.startTime = '999';
    fs.writeFileSync(recordFile(), JSON.stringify(stale), { mode: 0o600 });
    await reap();
    expect(dependencies.run).toHaveBeenNthCalledWith(1, tools.umount, [plan.invocationHostDir]);
    expect(dependencies.run).toHaveBeenNthCalledWith(2, tools.umount, [snapshot]);
    expect(dependencies.run).toHaveBeenNthCalledWith(3, tools.umount, [storageRoot]);
    expect(dependencies.rm).toHaveBeenCalledWith(storageRoot, { recursive: true, force: false });
    expect(readRecord().state).toBe('cleaned');
    await expect(resourceJournal()).rejects.toThrow('EEXIST');
  });

  it('retains the enforcing superblock and durable intent on a failed close', async () => {
    const { journal, storageRoot } = await aggregateStorageJournal();
    (dependencies.run as jest.Mock).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'busy' });
    await expect(journal.closeStorage(tools.umount)).rejects.toThrow('unmount failed');
    expect(mountInfo).toContain(storageRoot);
    expect(dependencies.rm).not.toHaveBeenCalled();
    expect(readRecord().state).toBe('pending');
  });

  it('rejects a remounted identity after a kernel reboot instead of guessing from reused IDs', async () => {
    await aggregateStorageJournal();
    bootId = 'different-kernel-boot';
    await expect(reap()).rejects.toThrow('different boot');
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(dependencies.rm).not.toHaveBeenCalled();
  });

  it('requires every committed mount while in use, allowing missing mounts only for idempotent close', async () => {
    const { journal, snapshot, storageRoot } = await aggregateStorageJournal();
    mountInfo = mountInfo.split('\n').filter((line) => !line.includes(` ${snapshot} `)).join('\n');
    await expect(journal.verifyStorage()).rejects.toThrow('mount identity changed');
    await journal.closeStorage(tools.umount);
    expect(dependencies.rm).toHaveBeenCalledWith(storageRoot, { recursive: true, force: false });
  });

  it.each(['mount', 'inode', 'ancestor', 'domain-ancestor', 'alias', 'uncommitted'] as const)(
    'rejects aggregate storage %s replacement or uncertain recovery without touching resources',
    async (replacement) => {
      const { journal, storageRoot } = await aggregateStorageJournal();
      if (replacement === 'mount') mountInfo = mountInfo.replace('1000 1', '2000 1');
      if (replacement === 'alias') {
        mountInfo += `2000 1 0:50 / /outside-global-bind rw - tmpfs awf-enclave-invocation rw\n`;
      }
      if (replacement === 'ancestor') {
        const record = readRecord();
        record.storage.parentIdentity.inode = '999';
        fs.writeFileSync(recordFile(), JSON.stringify(record), { mode: 0o600 });
      }
      if (replacement === 'inode') {
        const record = readRecord();
        record.storage.mountedIdentity.inode = '999';
        fs.writeFileSync(recordFile(), JSON.stringify(record), { mode: 0o600 });
      }
      if (replacement === 'domain-ancestor') {
        const record = readRecord();
        record.storage.ancestors[1].identity.inode = '999';
        fs.writeFileSync(recordFile(), JSON.stringify(record), { mode: 0o600 });
      }
      if (replacement === 'uncommitted') await journal.prepareStorageMount(storageRoot);
      const stale = readRecord();
      stale.owner.startTime = '999';
      fs.writeFileSync(recordFile(), JSON.stringify(stale), { mode: 0o600 });
      await expect(reap()).rejects.toThrow(/changed|Unrecorded|uncommitted/);
      expect(dependencies.run).not.toHaveBeenCalled();
      expect(dependencies.rm).not.toHaveBeenCalled();
      expect(fs.existsSync(recordFile())).toBe(true);
    },
  );

  it('retains permanent run tombstones, including closed and torn journals', () => {
    const journal = new HostExecutorJournal(run);
    journal.record({
      state: 'running', invocationId: plan.invocationId,
      admissionId: plan.admissionId, requestHash: plan.requestHash,
    });
    journal.record({ state: 'closed' });
    const file = path.join(run.journalDir!, `${run.runId}.journal`);
    expect(() => new HostExecutorJournal(run)).toThrow('EEXIST');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(fd, 'utf8')).not.toContain(plan.payload);
    } finally {
      fs.closeSync(fd);
    }

    const malformedRun = { ...run, runId: 'f'.repeat(32) };
    const malformedFile = path.join(run.journalDir!, `${malformedRun.runId}.journal`);
    const malformedFd = fs.openSync(
      malformedFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(malformedFd, '{"state":');
    } finally {
      fs.closeSync(malformedFd);
    }
    expect(() => new HostExecutorJournal(malformedRun)).toThrow('EEXIST');
  });

  it('keeps the durable default outside ephemeral invocation storage', () => {
    expect(hostExecutorJournalDirectory({ ...run, journalDir: undefined }))
      .toBe('/var/lib/awf-cloud-hypervisor/host-executor-journal');
    expect(hostExecutorJournalDirectory(run)).toBe(run.journalDir);
  });

  it.each(['unknown.resources.json', `${'a'.repeat(16)}-${'b'.repeat(15)}.resources.json`])(
    'fails closed on malformed resource filenames: %s',
    async (name) => {
      new HostExecutorJournal(run);
      const file = path.join(run.journalDir!, name);
      fs.writeFileSync(file, '{}', { mode: 0o600 });
      await expect(reap()).rejects.toThrow('Invalid resource recovery filename');
      expect(fs.existsSync(file)).toBe(true);
      expect(dependencies.run).not.toHaveBeenCalled();
    },
  );

  it('refuses symlinked or writable journal roots without touching their target', () => {
    fs.mkdirSync(run.journalDir!, { mode: 0o700 });
    fs.symlinkSync(run.journalDir!, path.join(root, 'linked'));
    expect(() => new HostExecutorJournal({ ...run, journalDir: path.join(root, 'linked') })).toThrow();
    fs.chmodSync(run.journalDir!, 0o777);
    expect(() => new HostExecutorJournal(run)).toThrow();
    expect(fs.readdirSync(run.journalDir!)).toEqual([]);
  });

  it('journals write-ahead storage intent and reaps only after VM cleanup', async () => {
    await mountedJournal();
    fs.writeFileSync(path.join(plan.invocationHostDir, 'private-input'), 'private');
    expect(readRecord().owner.pid).toBe(process.pid);
    expect(fs.readFileSync(recordFile(), 'utf8')).not.toContain('private-input');
    bootId = 'restarted-boot';
    await reap();
    expect(registry.reapPending).toHaveBeenCalledWith(tools.ip, tools.umount, tools);
    expect(dependencies.run).toHaveBeenCalledWith(tools.umount, [plan.invocationHostDir]);
    expect(fs.existsSync(plan.invocationHostDir)).toBe(false);
    expect(readRecord().state).toBe('cleaned');
    await reap();
    expect(dependencies.run).toHaveBeenCalledTimes(1);
    await expect(resourceJournal()).rejects.toThrow('EEXIST');
  });

  it('recovers the minimum protocol identity length', async () => {
    run = { ...run, runId: 'a'.repeat(16) };
    plan = {
      ...plan, runId: run.runId, invocationId: 'b'.repeat(16),
      invocationHostDir: path.join(run.invocationsDir, 'script', 'b'.repeat(16)),
    };
    await mountedJournal();
    bootId = 'restarted-boot';
    await reap();
    expect(readRecord().state).toBe('cleaned');
  });

  it('never reclaims storage belonging to a live host owner', async () => {
    await mountedJournal();
    await reap();
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
    expect(dependencies.run).not.toHaveBeenCalled();
  });

  it('reconciles a closed run even if the host process is still alive', async () => {
    const runJournal = new HostExecutorJournal(run);
    await mountedJournal();
    runJournal.record({ state: 'closed' });
    await reap();
    expect(readRecord().state).toBe('cleaned');
    expect(fs.existsSync(plan.invocationHostDir)).toBe(false);
  });

  it('blocks restart on ambiguous storage from a closed run in the same process', async () => {
    const runJournal = new HostExecutorJournal(run);
    const journal = await mountedJournal();
    await journal.prepareSnapshot();
    runJournal.record({ state: 'closed' });
    await expect(reap()).rejects.toThrow('Artifact staging identity is uncommitted');
    expect(dependencies.run).not.toHaveBeenCalled();
  });

  it('forwards trusted VMM account/ACL tools for complete VM recovery', async () => {
    const vmmTools = {
      ip: tools.ip, getfacl: '/trusted/getfacl', groupdel: '/trusted/groupdel',
      getent: '/trusted/getent', id: '/trusted/id', setfacl: '/trusted/setfacl',
      useradd: '/trusted/useradd', userdel: '/trusted/userdel',
    };
    const completeTools = { ...tools, ...vmmTools };
    await reapHostExecutorResources(run.journalDir!, registry, completeTools, dependencies);
    expect(registry.reapPending).toHaveBeenCalledWith(tools.ip, tools.umount, completeTools);
    expect((registry.reapPending as jest.Mock).mock.calls[0][2]).toBe(completeTools);
  });

  it('retains resources when the VM cleanup registry cannot recover safely', async () => {
    await mountedJournal();
    bootId = 'restarted-boot';
    registry.reapPending = jest.fn(async () => { throw new Error('unresolved VM identity'); });
    await expect(reap()).rejects.toThrow('unresolved VM identity');
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(readRecord().state).toBe('pending');
  });

  it('retains same-process resources while a VM record remains in a custom registry root', async () => {
    const runJournal = new HostExecutorJournal(run);
    await mountedJournal();
    fs.mkdirSync(path.join(root, 'vm-registry', 'pending-cleanup'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'vm-registry', 'pending-cleanup', `${vmRunId()}.json`), '{}');
    runJournal.record({ state: 'closed' });
    await expect(reap()).rejects.toThrow('VM cleanup must finish');
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
    expect(registry.hasPendingRecord).toHaveBeenCalledWith(vmRunId());
  });

  it.each(['changed-mount', 'uncommitted-mount'] as const)('retains %s without unmounting', async (kind) => {
    if (kind === 'changed-mount') {
      await mountedJournal();
      mountInfo = mountInfo.replace('901 ', '902 ');
    } else {
      const journal = await resourceJournal();
      fs.mkdirSync(plan.invocationHostDir, { mode: 0o700 });
      await journal.captureDirectory();
      mountInfo = `901 1 0:50 / ${plan.invocationHostDir} rw - tmpfs awf-enclave-invocation rw\n`;
    }
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('mount identity');
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
  });

  it.each([
    { mountId: 0 }, { mountId: 901.5 }, { device: 'invalid' },
    { device: '9007199254740992:1' }, { root: '/unrelated' }, { mountPoint: '/unrelated' },
  ])('rejects malformed mount metadata %j even after the mount disappears', async (malformed) => {
    await mountedJournal();
    const record = readRecord();
    Object.assign(record.mount, malformed);
    fs.writeFileSync(recordFile(), JSON.stringify(record), { mode: 0o600 });
    mountInfo = '';
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('Invalid invocation mount record');
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
    expect(dependencies.run).not.toHaveBeenCalled();
  });

  it('rejects missing trusted ancestor identities before touching resources', async () => {
    await mountedJournal();
    const record = readRecord();
    delete record.ancestors[0].identity;
    fs.writeFileSync(recordFile(), JSON.stringify(record), { mode: 0o600 });
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('Invalid recovery file identity');
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
    expect(dependencies.run).not.toHaveBeenCalled();
  });

  it('does not guess ownership in the crash gap between mkdir and identity commit', async () => {
    await resourceJournal();
    fs.mkdirSync(plan.invocationHostDir, { mode: 0o700 });
    fs.writeFileSync(path.join(plan.invocationHostDir, 'partial'), 'uncommitted directory');
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('without a committed identity');
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
    expect(readRecord().directoryIdentity).toBeUndefined();
    expect(readRecord().state).toBe('pending');
    expect(fs.readFileSync(path.join(plan.invocationHostDir, 'partial'), 'utf8')).toBe('uncommitted directory');
  });

  it('retains unknown staging intent instead of guessing an artifact directory', async () => {
    const journal = await mountedJournal();
    await journal.prepareSnapshot();
    const partialSnapshot = path.join(root, 'trusted-artifacts', 'run-uncommitted');
    fs.mkdirSync(partialSnapshot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(partialSnapshot, 'rootfs.partial'), 'partial copy');
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('Artifact staging identity is uncommitted');
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(readRecord().state).toBe('pending');
    expect(readRecord().snapshot).toBeUndefined();
    expect(fs.readFileSync(path.join(partialSnapshot, 'rootfs.partial'), 'utf8')).toBe('partial copy');
  });

  it('rejects symlink replacement and does not delete unrelated content', async () => {
    await mountedJournal();
    mountInfo = '';
    const unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'keep'), 'untouched');
    fs.rmSync(plan.invocationHostDir, { recursive: true });
    fs.symlinkSync(unrelated, plan.invocationHostDir);
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('symlink');
    expect(fs.readFileSync(path.join(unrelated, 'keep'), 'utf8')).toBe('untouched');
    expect(readRecord().state).toBe('pending');
  });

  it('refuses an ancestor replacement even if the invocation itself is unchanged', async () => {
    await mountedJournal();
    mountInfo = '';
    const parent = path.dirname(plan.invocationHostDir);
    fs.renameSync(parent, `${parent}-old`);
    fs.mkdirSync(parent, { mode: 0o700 });
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('identity changed');
    expect(fs.existsSync(path.join(`${parent}-old`, plan.invocationId))).toBe(true);
  });

  it('recovers an interrupted partial artifact copy after the early directory callback', async () => {
    const journal = await mountedJournal();
    await journal.prepareSnapshot();
    const snapshot = path.join(root, 'trusted-artifacts', 'run-fixture');
    fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    await journal.captureSnapshot(snapshot);
    fs.writeFileSync(path.join(snapshot, 'rootfs.partial'), 'incomplete copy');
    bootId = 'restarted-boot';
    await reap();
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(readRecord().state).toBe('cleaned');
  });

  it('rejects a validly shaped but unrelated VM run identity', async () => {
    await mountedJournal();
    const record = readRecord();
    record.vmRunId = 'f'.repeat(32);
    fs.writeFileSync(recordFile(), JSON.stringify(record), { mode: 0o600 });
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('Invalid resource recovery record');
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
  });

  it('rejects snapshot cleanup paths outside trusted artifact storage', async () => {
    const journal = await mountedJournal();
    const snapshot = path.join(root, 'trusted-artifacts', 'run-fixture');
    fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    await journal.captureSnapshot(snapshot);
    const record = readRecord();
    record.snapshot.path = path.join(root, 'unrelated');
    fs.writeFileSync(recordFile(), JSON.stringify(record), { mode: 0o600 });
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('Invalid snapshot path');
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
  });

  it('keeps recovery retryable when artifact deletion fails after invocation cleanup', async () => {
    const journal = await mountedJournal();
    const snapshot = path.join(root, 'trusted-artifacts', 'run-fixture');
    fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    await journal.captureSnapshot(snapshot);
    dependencies = { ...dependencies, rm: async (directory, options) => {
      if (directory === snapshot) throw new Error('busy snapshot');
      return fs.promises.rm(directory, options);
    } };
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('busy snapshot');
    expect(readRecord().state).toBe('pending');
    dependencies = { ...dependencies, rm: fs.promises.rm };
    await reap();
    expect(readRecord().state).toBe('cleaned');
  });

  it('requires all storage to disappear before recording cleanup completion', async () => {
    const journal = await mountedJournal();
    await expect(journal.complete()).rejects.toThrow('cleanup is incomplete');
    await expect(journal.verifyMount()).resolves.toBeUndefined();
    mountInfo = mountInfo.replace('901 ', '902 ');
    await expect(journal.verifyMount()).rejects.toThrow('identity changed');
    mountInfo = '';
    fs.rmSync(plan.invocationHostDir, { recursive: true });
    await journal.complete();
    expect(readRecord().state).toBe('cleaned');
  });
});
