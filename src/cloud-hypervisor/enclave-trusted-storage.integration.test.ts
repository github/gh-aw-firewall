import { createHash, randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
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
import {
  ENCLAVE_ARTIFACT_VERIFICATION_STORAGE_PROFILE,
  prepareTrustedArtifactVerificationStorage,
  prepareTrustedInvocationStorage,
} from './trusted-enclave-storage';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES as profiles } from './workload-profile';
import { stageArtifact } from './diagnostics';

const live = process.env.AWF_TEST_ENCLAVE_STORAGE === '1';
const tools = {
  mount: '/usr/bin/mount', umount: '/usr/bin/umount',
  ip: '/usr/sbin/ip', getfacl: '/usr/bin/getfacl', getent: '/usr/bin/getent',
  groupdel: '/usr/sbin/groupdel', id: '/usr/bin/id', setfacl: '/usr/bin/setfacl',
  useradd: '/usr/sbin/useradd', userdel: '/usr/sbin/userdel',
  debugfs: '/usr/sbin/debugfs', e2fsck: '/usr/sbin/e2fsck',
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

  async function provision(role: 'script' | 'agent', rootfsBytes = 4096, formatRootfs = false) {
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
    }, async (_source, destination) => {
      const handle = await fs.open(destination,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const chunk = Buffer.alloc(Math.min(rootfsBytes, 1024 ** 2), 1);
      try {
        for (let offset = 0; offset < rootfsBytes; offset += chunk.length) {
          expect((await handle.write(chunk.subarray(0, Math.min(chunk.length, rootfsBytes - offset)))).bytesWritten)
            .toBe(Math.min(chunk.length, rootfsBytes - offset));
        }
        if (formatRootfs) {
          await execa('/usr/sbin/mkfs.ext4', ['-F', '-E',
            'nodiscard,lazy_itable_init=0,lazy_journal_init=0', destination]);
          for (const directory of ['/usr', '/usr/sbin']) {
            await execa(tools.debugfs, ['-w', '-R', `mkdir ${directory}`, destination]);
          }
          // Formatting may punch zero-filled holes; materialize every page
          // through the original exclusive descriptor, without reopening a path.
          for (let offset = 0; offset < rootfsBytes; offset += chunk.length) {
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
            expect(bytesRead).toBe(chunk.length);
            expect((await handle.write(chunk, 0, bytesRead, offset)).bytesWritten).toBe(bytesRead);
          }
        }
      } finally {
        await handle.close();
      }
    }, (directory) => journal.captureSnapshot(directory));
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

  it('allocates full release-sized verification images sequentially, then enforces the independent host cap', async () => {
    const { run, plan } = await invocation('script');
    const journal = await HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan));
    const storage = await prepareTrustedArtifactVerificationStorage(run, plan, journal, tools);
    const close = async () => {
      await storage.close();
      await journal.verifyDirectory();
      await fs.rm(plan.invocationHostDir, { recursive: true, force: true });
      await journal.complete();
    };
    cleanup.add(close);
    await fs.mkdir(plan.invocationHostDir, { mode: 0o700 });
    await journal.captureDirectory();
    const { writableStorageBytes: capacity, uid, gid } = ENCLAVE_ARTIFACT_VERIFICATION_STORAGE_PROFILE;
    await storage.dependencies.mountTmpfs!(plan.invocationHostDir, capacity, uid, gid, tools);
    await journal.captureMount();
    await storage.dependencies.verifyStorage!(plan.invocationHostDir, capacity);
    const verification = path.join(storage.workDir, 'verification');
    await fs.mkdir(verification, { mode: 0o700 });
    const chunk = Buffer.alloc(1024 * 1024, 1);
    const metadata = path.join(verification, 'bounded-metadata');
    const metadataFile = await fs.open(metadata, 'wx');
    try {
      for (let index = 0; index < 33; index++) await metadataFile.write(chunk);
    } finally {
      await metadataFile.close();
    }
    for (const [role, imageMiB] of [['script', 512], ['agent', 1536]] as const) {
      const file = path.join(verification, `${role}.ext4`);
      const handle = await fs.open(file, 'wx');
      try {
        for (let index = 0; index < imageMiB; index++) {
          expect((await handle.write(chunk)).bytesWritten).toBe(chunk.length);
        }
        const stat = await handle.stat();
        expect(stat.size).toBe(imageMiB * chunk.length);
        expect(stat.blocks * 512).toBe(stat.size);
        if (role === 'agent') {
          expect(stat.size).toBeGreaterThan(profiles.script.writableStorageBytes);
          await expect((async () => {
            for (;;) await handle.write(chunk);
          })()).rejects.toMatchObject({ code: 'ENOSPC' });
          const full = await fs.statfs(verification, { bigint: true });
          expect(full.blocks * full.bsize).toBe(BigInt(capacity));
          expect(full.bfree).toBe(0n);
        }
      } finally {
        await handle.close();
        await fs.unlink(file);
      }
    }
    expect((await fs.stat(verification)).uid).toBe(0);
    expect((await fs.stat(verification)).dev).toBe((await fs.stat(plan.invocationHostDir)).dev);
    await storage.dependencies.verifyStorage!(plan.invocationHostDir, capacity);
    await close();
    cleanup.delete(close);
    await expect(fs.lstat(storage.workDir)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('seals a fully allocated primary runtime snapshot without using the agent invocation budget', async () => {
    const { run, plan } = await invocation('agent');
    const journal = await HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan));
    const storage = await prepareTrustedArtifactVerificationStorage(run, plan, journal, tools);
    const close = async () => {
      await storage.close();
      await journal.verifyDirectory();
      await fs.rm(plan.invocationHostDir, { recursive: true, force: true });
      await journal.complete();
    };
    cleanup.add(close);
    await fs.mkdir(plan.invocationHostDir, { mode: 0o700 });
    await journal.captureDirectory();
    const { writableStorageBytes: capacity, uid, gid } = ENCLAVE_ARTIFACT_VERIFICATION_STORAGE_PROFILE;
    await storage.dependencies.mountTmpfs!(plan.invocationHostDir, capacity, uid, gid, tools);
    await journal.captureMount();
    await journal.prepareSnapshot();
    const rootfsBytes = 1536 * 1024 ** 2;
    const snapshot = await storage.dependencies.createArtifactSnapshot!({
      cloudHypervisorBinary: '/usr/bin/true', virtiofsdBinary: '/usr/bin/true',
      kernelPath: '/usr/bin/true', rootfsPath: '/synthetic-primary-rootfs',
      supervisorPath: '/usr/bin/true',
    }, async (_source, destination) => {
      const handle = await fs.open(destination, 'wx');
      const chunk = Buffer.alloc(1024 ** 2, 1);
      try {
        for (let index = 0; index < 1536; index++) {
          expect((await handle.write(chunk)).bytesWritten).toBe(chunk.length);
        }
      } finally {
        await handle.close();
      }
    }, (directory) => journal.captureSnapshot(directory));
    await expect((async () => {
      const handle = await fs.open(snapshot.rootfsPath, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await handle.writeFile('changed');
      } finally {
        await handle.close();
      }
    })()).rejects.toMatchObject({ code: 'EROFS' });
    const handle = await fs.open(snapshot.rootfsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let image;
    try {
      image = await handle.stat();
    } finally {
      await handle.close();
    }
    expect(image.size).toBe(rootfsBytes);
    expect(image.blocks * 512).toBe(rootfsBytes);
    expect(image.size).toBeGreaterThan(profiles.agent.writableStorageBytes);
    expect(image.uid).toBe(0);
    expect(image.mode & 0o777).toBe(0o444);
    expect((await execa(snapshot.cloudHypervisorBinary)).exitCode).toBe(0);
    await storage.dependencies.verifyStorage!(plan.invocationHostDir, capacity);
    await expect(storage.dependencies.verifyStorage!(plan.invocationHostDir, profiles.agent.writableStorageBytes))
      .rejects.toThrow('escape');
    await close();
    cleanup.delete(close);
    await expect(fs.lstat(storage.workDir)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it.each(['script', 'agent'] as const)(
    '%s isolates host image budgets from the aggregate writable export ceiling',
    async (role) => {
      const domain = await provision(role);
      const root = hostExecutorStorageDirectory(hostExecutorVmRunId(domain.plan));
      const size = profiles[role].writableStorageBytes;
      const writable = [
        path.join(root, 'state', 'sparse'),
        ...domain.exports.map((directory) => path.join(directory, 'sparse')),
      ];
      const devices = await Promise.all([
        path.join(root, 'state'), ...domain.exports,
      ].map(async (directory) => (await fs.stat(directory)).dev));
      expect(new Set(devices).size).toBe(1);
      expect((await fs.stat(domain.snapshot.directory)).dev).not.toBe(devices[0]);
      const hostDevices = await Promise.all([
        domain.snapshot.directory, domain.rootfsPreparation, domain.paths.runDirectory,
      ].map(async (directory) => {
        const capacity = await fs.statfs(directory, { bigint: true });
        expect(capacity.blocks * capacity.bsize)
          .toBe(BigInt(ENCLAVE_ARTIFACT_VERIFICATION_STORAGE_PROFILE.writableStorageBytes));
        return (await fs.stat(directory)).dev;
      }));
      expect(new Set([...hostDevices, devices[0]]).size).toBe(4);
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
        const stats = await Promise.all(files.map((file) => file.stat()));
        const written = stats.reduce((bytes, stat) => bytes + stat.blocks * 512, 0);
        expect(written).toBe(size);
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

  it('snapshots, prepares and stages a full 1.5 GiB agent image while exports remain bounded to 512 MiB', async () => {
    const rootfsBytes = 1536 * 1024 ** 2;
    const domain = await provision('agent', rootfsBytes, true);
    await expect((async () => {
      const handle = await fs.open(domain.snapshot.rootfsPath, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await handle.writeFile('changed');
      } finally {
        await handle.close();
      }
    })()).rejects.toMatchObject({ code: 'EROFS' });
    const snapshotFile = await fs.open(domain.snapshot.rootfsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let snapshot;
    try {
      snapshot = await snapshotFile.stat();
    } finally {
      await snapshotFile.close();
    }
    expect(snapshot.size).toBe(rootfsBytes);
    expect(snapshot.blocks * 512).toBe(rootfsBytes);
    expect(snapshot.uid).toBe(0);
    expect(snapshot.mode & 0o777).toBe(0o444);
    const staging = await fs.statfs(domain.snapshot.directory, { bigint: true });
    expect(staging.blocks * staging.bsize)
      .toBe(BigInt(ENCLAVE_ARTIFACT_VERIFICATION_STORAGE_PROFILE.writableStorageBytes));
    expect((await execa(domain.snapshot.cloudHypervisorBinary)).exitCode).toBe(0);
    const output = domain.exports[0];
    const guest = await fs.statfs(output, { bigint: true });
    expect(guest.blocks * guest.bsize).toBe(BigInt(512 * 1024 ** 2));
    expect((await fs.stat(output)).dev).not.toBe(snapshot.dev);
    const dependencies = domain.storage.managerDependencies;
    const preparer = dependencies.createRootfsPreparer({
      runDirectory: domain.rootfsPreparation,
      baseRootfsPath: domain.snapshot.rootfsPath,
      supervisorBinaryPath: domain.snapshot.supervisorPath,
      supervisorSha256: createHash('sha256').update(await fs.readFile('/usr/bin/true')).digest('hex'),
      supervisorGuestPath: '/usr/sbin/awf-supervisor',
      hostAliases: { 'api-proxy': '172.30.0.30' },
    }, tools, (source, destination) => fs.copyFile(source, destination));
    const prepared = await preparer.prepare();
    await stageArtifact(dependencies, prepared, domain.paths.rootfsPath, 0o600,
      { uid: 65534, gid: 65534 }, () => fs.copyFile(prepared, domain.paths.rootfsPath));
    const images = [domain.snapshot.rootfsPath, prepared, domain.paths.rootfsPath];
    const imageDevices: number[] = [];
    for (const image of images) {
      const handle = await fs.open(image, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        expect(stat.size).toBe(rootfsBytes);
        expect(stat.blocks * 512).toBe(rootfsBytes);
        imageDevices.push(stat.dev);
      } finally {
        await handle.close();
      }
    }
    expect(new Set([...imageDevices, (await fs.stat(output)).dev]).size).toBe(4);
    const injected = await execa(tools.debugfs, ['-R', 'stat /usr/sbin/awf-supervisor', domain.paths.rootfsPath]);
    expect(injected.stdout).toContain('Type: regular');
    for (const directory of [domain.rootfsPreparation, domain.paths.runDirectory]) {
      const capacity = await fs.statfs(directory, { bigint: true });
      expect(capacity.blocks * capacity.bsize)
        .toBe(BigInt(ENCLAVE_ARTIFACT_VERIFICATION_STORAGE_PROFILE.writableStorageBytes));
      const fill = path.join(directory, 'fill');
      const handle = await fs.open(fill, 'wx');
      try {
        const chunk = Buffer.alloc(1024 ** 2, 1);
        await expect((async () => {
          for (;;) await handle.write(chunk);
        })()).rejects.toMatchObject({ code: 'ENOSPC' });
        expect((await fs.statfs(directory, { bigint: true })).bfree).toBe(0n);
        expect((await fs.statfs(output, { bigint: true })).bfree).toBe(guest.bfree);
      } finally {
        await handle.close();
        await fs.unlink(fill);
      }
    }
    const stagingFill = path.join(domain.storage.workDir, 'artifacts', 'fill');
    const stagingFile = await fs.open(stagingFill, 'wx');
    try {
      const chunk = Buffer.alloc(1024 ** 2, 1);
      await expect((async () => {
        for (;;) await stagingFile.write(chunk);
      })()).rejects.toMatchObject({ code: 'ENOSPC' });
      expect((await fs.statfs(domain.snapshot.directory, { bigint: true })).bfree).toBe(0n);
      expect((await fs.statfs(output, { bigint: true })).bfree).toBe(guest.bfree);
    } finally {
      await stagingFile.close();
      await fs.unlink(stagingFill);
    }
    const file = await fs.open(path.join(output, 'fill'), 'wx');
    try {
      const chunk = Buffer.alloc(1024 ** 2, 1);
      await expect((async () => {
        for (;;) await file.write(chunk);
      })()).rejects.toMatchObject({ code: 'ENOSPC' });
      expect((await file.stat()).blocks * 512).toBeLessThanOrEqual(profiles.agent.writableStorageBytes);
    } finally {
      await file.close();
    }
    expect((await fs.statfs(output, { bigint: true })).bfree).toBe(0n);
    expect((await fs.statfs(domain.snapshot.directory, { bigint: true })).bfree).toBe(staging.bfree);
    await domain.storage.dependencies.verifyStorage!(domain.plan.invocationHostDir,
      profiles.agent.writableStorageBytes, domain.exports);
    await domain.close();
    cleanup.delete(domain.close);
    await expect(fs.lstat(domain.storage.workDir)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('retains the allocation ceiling when close encounters a busy snapshot', async () => {
    const domain = await provision('agent');
    const handle = await fs.open(domain.snapshot.cloudHypervisorBinary, 'r');
    try {
      await expect(domain.close()).rejects.toThrow();
      await domain.storage.dependencies.verifyStorage!(
        domain.plan.invocationHostDir, profiles.agent.writableStorageBytes, domain.exports,
      );
      const capacity = await fs.statfs(domain.plan.invocationHostDir, { bigint: true });
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
        for (const name of ['artifacts', 'runs', 'cloud-hypervisor-rootfs']) {
          await fs.writeFile(storage.workDir + '/' + name + '/orphan', 'synthetic');
        }
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

    for (const directory of [root, ...['artifacts', 'runs', 'cloud-hypervisor-rootfs'].map((name) => path.join(root, name))]) {
      await execa(tools.mount, ['-t', 'tmpfs', '-o', 'size=4194304,mode=0711,nosuid,nodev,noexec', 'foreign', directory]);
      try {
        await fs.writeFile(path.join(directory, 'unrelated'), 'preserve');
        await expect(reap()).rejects.toThrow(/identity|Unrecorded|changed/);
        expect(await fs.readFile(path.join(directory, 'unrelated'), 'utf8')).toBe('preserve');
      } finally {
        await execa(tools.umount, [directory]);
      }
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
