import * as fs from 'fs';
import * as path from 'path';
import {
  HostExecutorJournal, HostExecutorResourceJournal, reapHostExecutorResources,
  hostExecutorVmRunId, hostExecutorJournalDirectory,
} from './host-executor-journal';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from './host-executor-server';
import type { CleanupRegistryDependencies } from '../cloud-hypervisor/cleanup-dependencies';
import type { CloudHypervisorCleanupRegistry } from '../cloud-hypervisor/cleanup-registry';

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
    dependencies = {
      rootDirectory: path.join(root, 'vm-registry'),
      readFile: (async (file: fs.PathLike | fs.promises.FileHandle, options?: BufferEncoding) => {
        if (file === '/proc/sys/kernel/random/boot_id') return bootId;
        if (file === '/proc/self/mountinfo') return mountInfo;
        return fs.promises.readFile(file, options ?? null);
      }) as typeof fs.promises.readFile,
      run: jest.fn(async () => {
        mountInfo = '';
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };
    registry = {
      reapPending: jest.fn(async () => undefined),
      create: jest.fn(), createPending: jest.fn(),
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

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

  it('retains permanent run tombstones, including closed and torn journals', () => {
    const journal = new HostExecutorJournal(run);
    journal.record({
      state: 'running', invocationId: plan.invocationId,
      admissionId: plan.admissionId, requestHash: plan.requestHash,
    });
    journal.record({ state: 'closed' });
    const file = path.join(run.journalDir!, `${run.runId}.journal`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => new HostExecutorJournal(run)).toThrow('EEXIST');
    fs.appendFileSync(file, '{"state":');
    expect(() => new HostExecutorJournal(run)).toThrow('EEXIST');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(plan.payload);
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

  it('retains resources with a still-pending VM record', async () => {
    await mountedJournal();
    fs.mkdirSync(path.join(root, 'vm-registry', 'pending-cleanup'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'vm-registry', 'pending-cleanup', `${vmRunId()}.json`), '{}');
    bootId = 'restarted-boot';
    await expect(reap()).rejects.toThrow('VM cleanup must finish');
    expect(dependencies.run).not.toHaveBeenCalled();
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
