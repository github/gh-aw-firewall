import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import {
  HostExecutorJournal,
  HostExecutorResourceJournal,
  hostExecutorStorageDirectory,
  hostExecutorVmRunId,
  reapHostExecutorResources,
} from '../enclave/host-executor-journal';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from '../enclave/host-executor-server';
import { DurableCloudHypervisorCleanupRegistry } from './cleanup-registry';
import type { CloudHypervisorHostToolPaths } from './preflight';
import { prepareTrustedInvocationStorage } from './trusted-enclave-storage';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES as profiles } from './workload-profile';

const live = process.env.AWF_TEST_ENCLAVE_STORAGE === '1';
const tools = {
  mount: '/usr/bin/mount', umount: '/usr/bin/umount',
  ip: '/usr/sbin/ip', getfacl: '/usr/bin/getfacl', getent: '/usr/bin/getent',
  groupdel: '/usr/sbin/groupdel', id: '/usr/bin/id', setfacl: '/usr/bin/setfacl',
  useradd: '/usr/sbin/useradd', userdel: '/usr/sbin/userdel',
} as CloudHypervisorHostToolPaths;

(live ? describe : describe.skip)('production invocation allocation domain', () => {
  let scratch: string;
  const cleanup = new Set<() => Promise<void>>();

  beforeEach(async () => {
    if (process.getuid?.() !== 0) throw new Error('Trusted storage probes require privileged mount isolation');
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-trusted-storage-'));
  });

  afterEach(async () => {
    for (const close of [...cleanup].reverse()) {
      await close();
      cleanup.delete(close);
    }
    await fs.rm(scratch, { recursive: true, force: true });
  });

  async function invocation(role: 'script' | 'agent') {
    const run: HostExecutorRunState = {
      runId: randomBytes(16).toString('hex'), seedsDir: path.join(scratch, 'seeds'),
      invocationsDir: path.join(scratch, 'invocations'), journalDir: path.join(scratch, 'journal'),
      entries: [],
    };
    const invocationId = randomBytes(16).toString('hex');
    const plan: HostExecutorInvocationPlan = {
      runId: run.runId, entryId: role, invocationId, executorKind: role,
      timeoutMs: 60_000, requestHash: 'a'.repeat(64), admissionId: 'b'.repeat(32),
      schemaHash: 'c'.repeat(64), schema: { type: 'boolean' }, payload: 'synthetic',
      invocationHostDir: path.join(run.invocationsDir, role, invocationId),
    };
    await fs.mkdir(path.dirname(plan.invocationHostDir), { recursive: true, mode: 0o700 });
    return { run, plan };
  }

  async function provision(role: 'script' | 'agent') {
    const { run, plan } = await invocation(role);
    const journal = await HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan));
    await fs.mkdir(plan.invocationHostDir, { mode: 0o700 });
    await journal.captureDirectory();
    const storage = await prepareTrustedInvocationStorage(run, plan, journal, tools);
    let snapshotDirectory: string | undefined;
    let mounted = false;
    const close = async () => {
      if (snapshotDirectory) {
        await journal.verifySnapshot();
        await storage.dependencies.removeArtifactSnapshot!(snapshotDirectory);
        snapshotDirectory = undefined;
      }
      if (mounted) {
        await journal.verifyMount();
        await execa(tools.umount, [plan.invocationHostDir]);
        mounted = false;
      }
      await journal.verifyDirectory();
      await fs.rm(plan.invocationHostDir, { recursive: true, force: true });
      await storage.close();
      await journal.complete();
    };
    cleanup.add(close);
    await storage.dependencies.mountTmpfs!(
      plan.invocationHostDir, profiles[role].writableStorageBytes,
      profiles[role].uid, profiles[role].gid, tools,
    );
    mounted = true;
    await journal.captureMount();
    const source = path.join(scratch, 'rootfs-source');
    await fs.writeFile(source, Buffer.alloc(4096, 1));
    await journal.prepareSnapshot();
    const snapshot = await storage.dependencies.createArtifactSnapshot!({
      cloudHypervisorBinary: '/usr/bin/true', virtiofsdBinary: '/usr/bin/true',
      kernelPath: source, rootfsPath: source, supervisorPath: '/usr/bin/true',
    }, fs.copyFile, (directory) => journal.captureSnapshot(directory));
    snapshotDirectory = snapshot.directory;
    await journal.captureSnapshot(snapshot.directory);
    const paths = storage.managerDependencies.createRunPaths!(
      snapshot.cloudHypervisorBinary, hostExecutorVmRunId(plan),
      { kind: `${role}-enclave`, ownerId: role, invocationId: plan.invocationId },
    );
    const rootfsPreparation = path.join(storage.workDir, 'cloud-hypervisor-rootfs', paths.runId);
    const exports = ['output', 'runtime', ...(role === 'agent' ? ['session-handoff', 'session-state'] : [])]
      .map((name) => path.join(plan.invocationHostDir, name));
    await Promise.all([paths.runDirectory, paths.virtiofsdShareDirectory, rootfsPreparation, ...exports]
      .map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    await storage.dependencies.verifyStorage!(plan.invocationHostDir, profiles[role].writableStorageBytes, exports);
    return { run, plan, journal, storage, snapshot, paths, rootfsPreparation, exports, close };
  }

  it.each(['script', 'agent'] as const)(
    '%s charges snapshots, rootfs preparation/staging, runtime and sparse concurrent exports to one ceiling',
    async (role) => {
      const domain = await provision(role);
      const root = hostExecutorStorageDirectory(hostExecutorVmRunId(domain.plan));
      const size = profiles[role].writableStorageBytes;
      const writable = [
        path.join(domain.rootfsPreparation, 'prepared.ext4'), domain.paths.rootfsPath,
        domain.paths.logPath, path.join(domain.paths.virtiofsdShareDirectory, 'state'),
        ...domain.exports.map((directory) => path.join(directory, 'sparse')),
      ];
      const devices = await Promise.all([
        domain.snapshot.directory, domain.rootfsPreparation, domain.paths.runDirectory,
        domain.paths.virtiofsdShareDirectory, ...domain.exports,
      ].map(async (directory) => (await fs.stat(directory)).dev));
      expect(new Set(devices).size).toBe(1);
      expect(domain.storage.workDir).toBe(root);
      await expect(fs.writeFile(path.join(domain.snapshot.directory, 'forbidden'), 'x'))
        .rejects.toMatchObject({ code: 'EROFS' });
      expect((await execa(domain.snapshot.cloudHypervisorBinary)).exitCode).toBe(0);
      for (const directory of [
        path.join(root, 'state'), domain.paths.runDirectory, domain.rootfsPreparation, ...domain.exports,
      ]) {
        const binary = path.join(directory, 'cannot-execute');
        await fs.copyFile('/usr/bin/true', binary);
        await fs.chmod(binary, 0o555);
        await expect(execa(binary)).rejects.toMatchObject({ code: 'EACCES' });
        await fs.unlink(binary);
      }

      const files = await Promise.all(writable.map((file) => fs.open(file, 'wx')));
      const chunk = Buffer.alloc(1024 * 1024, 1);
      try {
        await Promise.all(files.map((file) => file.truncate(size * 4)));
        const outcomes = await Promise.all(files.map(async (file) => {
          for (let offset = size * 2; ; offset += chunk.length) {
            try {
              await file.write(chunk, 0, chunk.length, offset);
            } catch (error) {
              return (error as NodeJS.ErrnoException).code;
            }
          }
        }));
        expect(outcomes).toEqual(files.map(() => 'ENOSPC'));
        const capacity = await fs.statfs(root, { bigint: true });
        expect(capacity.blocks * capacity.bsize).toBe(BigInt(size));
        expect(capacity.bfree).toBe(0n);
        // Immutable snapshots still consume pages: writers cannot allocate the
        // entire budget in addition to the pre-existing artifact copies.
        const stats = await Promise.all(files.map((file) => file.stat()));
        const written = stats.reduce((bytes, stat) => bytes + stat.blocks * 512, 0);
        expect(written).toBeLessThan(size);
        expect(written).toBeGreaterThan(size - 1024 * 1024);
        for (const file of files) {
          await expect(file.write(Buffer.alloc(4096), 0, 4096, 0))
            .rejects.toMatchObject({ code: 'ENOSPC' });
        }
      } finally {
        await Promise.all(files.map((file) => file.close()));
      }
    }, 120_000,
  );

  it('retains the allocation ceiling when close encounters a busy snapshot', async () => {
    const domain = await provision('agent');
    const handle = await fs.open(domain.snapshot.cloudHypervisorBinary, 'r');
    try {
      await expect(domain.close()).rejects.toThrow();
      await domain.storage.dependencies.verifyStorage!(
        domain.plan.invocationHostDir, profiles.agent.writableStorageBytes, domain.exports,
      );
      const capacity = await fs.statfs(domain.paths.runDirectory, { bigint: true });
      expect(capacity.blocks * capacity.bsize)
        .toBe(BigInt(profiles.agent.writableStorageBytes));
    } finally {
      await handle.close();
    }
  });

  it('cleans identity-known mounts after a partial artifact copy fails without replay', async () => {
    const { run, plan } = await invocation('agent');
    const journal = await HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan));
    const storage = await prepareTrustedInvocationStorage(run, plan, journal, tools);
    await fs.mkdir(plan.invocationHostDir, { mode: 0o700 });
    await journal.captureDirectory();
    const close = async () => {
      await storage.close();
      await journal.verifyDirectory();
      await fs.rm(plan.invocationHostDir, { recursive: true, force: true });
      await journal.complete();
    };
    cleanup.add(close);
    await storage.dependencies.mountTmpfs!(
      plan.invocationHostDir, profiles.agent.writableStorageBytes, profiles.agent.uid, profiles.agent.gid, tools,
    );
    await journal.captureMount();
    await journal.prepareSnapshot();
    await expect(storage.dependencies.createArtifactSnapshot!({
      cloudHypervisorBinary: '/usr/bin/true', virtiofsdBinary: '/usr/bin/true',
      kernelPath: '/usr/bin/true', rootfsPath: '/usr/bin/true', supervisorPath: '/usr/bin/true',
    }, async (_source, destination) => {
      await fs.writeFile(destination, 'partial-copy');
      throw new Error('artifact copy failed');
    }, (directory) => journal.captureSnapshot(directory))).rejects.toThrow('artifact copy failed');
    await close();
    cleanup.delete(close);
    await expect(fs.lstat(storage.workDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan)))
      .rejects.toThrow('EEXIST');
  });

  it('reaps a crashed owner only after exact mount identity matches and never replays the invocation', async () => {
    const { run, plan } = await invocation('agent');
    const root = hostExecutorStorageDirectory(hostExecutorVmRunId(plan));
    const registry = new DurableCloudHypervisorCleanupRegistry({ rootDirectory: path.join(scratch, 'vm-journal') });
    const reap = () => reapHostExecutorResources(run.journalDir!, registry, tools);
    const recover = async () => { await reap(); };
    cleanup.add(recover);
    // Kill the child without closing its mounts. Recovery uses its real dead
    // PID/start-time identity, not a fabricated path-only ownership claim.
    const child = execa(process.execPath, ['-e', `
      const fs = require('fs').promises;
      const { HostExecutorJournal, HostExecutorResourceJournal, hostExecutorVmRunId } = require(process.argv[1]);
      const { prepareTrustedInvocationStorage } = require(process.argv[2]);
      const { run, plan, tools, size } = JSON.parse(process.argv[3]);
      (async () => {
        new HostExecutorJournal(run);
        const journal = await HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan));
        await fs.mkdir(plan.invocationHostDir, { mode: 0o700 });
        await journal.captureDirectory();
        const storage = await prepareTrustedInvocationStorage(run, plan, journal, tools);
        await storage.dependencies.mountTmpfs(plan.invocationHostDir, size, 65534, 65534, tools);
        await journal.captureMount();
        await fs.writeFile(plan.invocationHostDir + '/orphan', 'synthetic');
        process.stdin.resume();
        console.log('READY');
      })().catch(() => { process.exitCode = 1; });
    `, path.resolve(__dirname, '../../dist/enclave/host-executor-journal.js'),
    path.resolve(__dirname, '../../dist/cloud-hypervisor/trusted-enclave-storage.js'),
    JSON.stringify({ run, plan, tools, size: profiles.agent.writableStorageBytes })]);
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once('data', (data: Buffer) => {
          if (data.toString('utf8').trim() === 'READY') resolve();
          else reject(new Error('Unexpected crash-probe readiness response'));
        });
        void child.then(() => reject(new Error('Crash probe exited before readiness')), reject);
      });
    } finally {
      child.kill('SIGKILL');
      await child.catch(() => undefined);
    }

    await execa(tools.mount, ['-t', 'tmpfs', '-o', 'size=4194304,nosuid,nodev,noexec', 'foreign', root]);
    try {
      await fs.writeFile(path.join(root, 'unrelated'), 'preserve');
      await expect(reap()).rejects.toThrow(/identity|Unrecorded|changed/);
      expect(await fs.readFile(path.join(root, 'unrelated'), 'utf8')).toBe('preserve');
    } finally {
      await execa(tools.umount, [root]);
    }
    await reap();
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(plan.invocationHostDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await reap();
    expect(() => new HostExecutorJournal(run)).toThrow('EEXIST');
    await expect(HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan)))
      .rejects.toThrow('EEXIST');
    cleanup.delete(recover);
  }, 60_000);
});
