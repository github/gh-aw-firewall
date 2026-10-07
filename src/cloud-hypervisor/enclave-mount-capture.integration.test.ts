import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import {
  HostExecutorResourceJournal, hostExecutorVmRunId,
} from '../enclave/host-executor-journal';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from '../enclave/host-executor-server';
import { HostPreflightReporter, hostPreflightReason, type HostPreflightProgress } from './host-preflight-progress';
import type { CloudHypervisorHostToolPaths } from './preflight';
import { prepareTrustedInvocationStorage } from './trusted-enclave-storage';
import type { MountTopologyEvidence } from './mount-topology';

const live = process.env.AWF_TEST_ENCLAVE_STORAGE === '1';
const tools = { mount: '/usr/bin/mount', umount: '/usr/bin/umount' } as CloudHypervisorHostToolPaths;
jest.setTimeout(30_000);

(live ? describe : describe.skip)('real Linux storage mount capture diagnostics (not VM acceptance)', () => {
  let scratch: string;
  const cleanup = new Set<() => Promise<void>>();
  beforeEach(async () => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) {
      throw new Error('Mount capture probes require Linux root in a private mount namespace');
    }
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-mount-capture-'));
  });
  afterEach(async () => {
    for (const close of [...cleanup].reverse()) await close();
    await fs.rm(scratch, { recursive: true, force: true });
  });

  async function fixture() {
    const run: HostExecutorRunState = {
      runId: randomBytes(16).toString('hex'), seedsDir: path.join(scratch, 'seeds'),
      invocationsDir: path.join(scratch, 'invocations'), journalDir: path.join(scratch, 'journal'), entries: [],
    };
    const invocationId = randomBytes(16).toString('hex');
    const plan: HostExecutorInvocationPlan = {
      runId: run.runId, entryId: 'script', invocationId, executorKind: 'script',
      timeoutMs: 60_000, requestHash: 'a'.repeat(64), admissionId: 'b'.repeat(32),
      schemaHash: 'c'.repeat(64), schema: { type: 'boolean' }, payload: 'synthetic',
      invocationHostDir: path.join(run.invocationsDir, 'script', invocationId),
    };
    await fs.mkdir(path.dirname(plan.invocationHostDir), { recursive: true, mode: 0o700 });
    const journal = await HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan));
    const storage = await prepareTrustedInvocationStorage(run, plan, journal, tools);
    const close = async () => {
      await storage.close();
      cleanup.delete(close);
    };
    cleanup.add(close);
    const snapshot = path.join(storage.workDir, 'artifacts', 'run-diagnostic');
    await fs.mkdir(snapshot, { mode: 0o700 });
    await journal.prepareSnapshot();
    await journal.captureSnapshot(snapshot);
    await journal.prepareStorageMount(snapshot);
    const published: HostPreflightProgress[] = [];
    const capture = () => journal.captureStorageMount(
      new HostPreflightReporter('storage-mount-capture', (value) => published.push(value)),
    );
    const bind = () => execa(tools.mount, ['--bind', snapshot, snapshot]);
    return { journal, storage, snapshot, published, capture, bind, close };
  }

  it.each(['private', 'shared', 'shared-baseline'] as const)(
    'isolates the allocation beneath %s parent propagation without changing that parent', async (mode) => {
      const child = await execa('/usr/bin/unshare', [
        '--mount', '--propagation', 'private', process.execPath, '-e', `
        const fs = require('fs').promises;
        const path = require('path');
        const { execFileSync } = require('child_process');
        const { randomBytes } = require('crypto');
        const { HostExecutorResourceJournal, hostExecutorVmRunId } = require(process.argv[1]);
        const { prepareTrustedInvocationStorage } = require(process.argv[2]);
        const { HostPreflightReporter, hostPreflightReason } = require(process.argv[3]);
        const { observeMountTopology } = require(process.argv[6]);
        (async () => {
          const [scratch, mode] = process.argv.slice(4);
          const parent = '/run/awf-cloud-hypervisor/enclave-storage';
          await fs.mkdir(parent, { recursive: true, mode: 0o711 });
          execFileSync('/usr/bin/mount', ['-t', 'tmpfs', '-o', 'size=4194304,mode=0711', 'probe-parent', parent]);
          execFileSync('/usr/bin/mount', ['--make-' + (mode === 'shared-baseline' ? 'shared' : mode), parent]);
          if (mode === 'shared-baseline') {
            const root = path.join(parent, 'baseline');
            const artifacts = path.join(root, 'artifacts');
            const snapshot = path.join(artifacts, 'run-baseline');
            await fs.mkdir(root, { mode: 0o711 });
            execFileSync('/usr/bin/mount', ['-t', 'tmpfs', '-o', 'size=4194304,mode=0711', 'awf-enclave-invocation', root]);
            await fs.mkdir(artifacts);
            execFileSync('/usr/bin/mount', ['--bind', artifacts, artifacts]);
            await fs.mkdir(snapshot);
            const before = observeMountTopology(await fs.readFile('/proc/self/mountinfo', 'utf8'), root, artifacts, snapshot);
            execFileSync('/usr/bin/mount', ['--bind', snapshot, snapshot]);
            const after = observeMountTopology(await fs.readFile('/proc/self/mountinfo', 'utf8'), root, artifacts, snapshot);
            process.stdout.write(JSON.stringify({ reason: 'baseline', topology: {
              schemaVersion: 1, bindCalls: 'one', before, after
            }}));
            return;
          }
          const run = { runId: randomBytes(16).toString('hex'), seedsDir: path.join(scratch, 'seeds'),
            invocationsDir: path.join(scratch, 'invocations'), journalDir: path.join(scratch, 'journal'), entries: [] };
          const invocationId = randomBytes(16).toString('hex');
          const plan = { runId: run.runId, entryId: 'script', invocationId, executorKind: 'script',
            timeoutMs: 60000, requestHash: 'a'.repeat(64), admissionId: 'b'.repeat(32),
            schemaHash: 'c'.repeat(64), schema: { type: 'boolean' }, payload: 'synthetic',
            invocationHostDir: path.join(run.invocationsDir, 'script', invocationId) };
          await fs.mkdir(path.dirname(plan.invocationHostDir), { recursive: true, mode: 0o700 });
          const journal = await HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan));
          await fs.mkdir(plan.invocationHostDir, { mode: 0o700 });
          await journal.captureDirectory();
          let topology;
          const storage = await prepareTrustedInvocationStorage(run, plan, journal,
            { mount: '/usr/bin/mount', umount: '/usr/bin/umount' },
            new HostPreflightReporter('bounded-runtime', value => {
              if (value.mountTopology) topology = value.mountTopology;
            }));
          await storage.dependencies.mountTmpfs(plan.invocationHostDir, 1073741824, 65534, 65534);
          await journal.captureMount();
          await journal.prepareSnapshot();
          let reason = 'none';
          try {
            await storage.dependencies.createArtifactSnapshot({
              cloudHypervisorBinary: '/usr/bin/true', virtiofsdBinary: '/usr/bin/true',
              kernelPath: '/usr/bin/true', rootfsPath: '/usr/bin/true', supervisorPath: '/usr/bin/true'
            }, fs.copyFile, directory => journal.captureSnapshot(directory));
          } catch (error) { reason = hostPreflightReason(error); }
          if (!topology) throw new Error('Probe did not reach snapshot topology');
          const table = await fs.readFile('/proc/self/mountinfo', 'utf8');
          const parentLine = table.split('\\n').find(line => line.split(' ')[4] === parent);
          const parentStillShared = parentLine.split(' ').some(field => field.startsWith('shared:'));
          await storage.close();
          const allocationRemoved = await fs.lstat(storage.workDir).then(() => false, error => {
            if (error.code !== 'ENOENT') throw error;
            return true;
          });
          process.stdout.write(JSON.stringify({ reason, topology, parentStillShared, allocationRemoved }));
        })().catch(() => { console.error('Mount topology probe setup failed'); process.exitCode = 1; });
        `,
        path.resolve(__dirname, '../../dist/enclave/host-executor-journal.js'),
        path.resolve(__dirname, '../../dist/cloud-hypervisor/trusted-enclave-storage.js'),
        path.resolve(__dirname, '../../dist/cloud-hypervisor/host-preflight-progress.js'),
        scratch, mode, path.resolve(__dirname, '../../dist/cloud-hypervisor/mount-topology.js'),
      ]);
      const result = JSON.parse(child.stdout) as {
        reason: string; topology: MountTopologyEvidence; parentStillShared?: boolean; allocationRemoved?: boolean;
      };
      expect(result.topology.bindCalls).toBe('one');
      expect(result.topology.before?.snapshotEntries).toBe('zero');
      if (mode === 'shared-baseline') {
        expect(result.reason).toBe('baseline');
        expect(result.topology.before?.localPeerRelation).toBe('same-group-overlap');
        expect(result.topology.after).toMatchObject({ snapshotEntries: 'multiple', snapshotIds: 'unique' });
      } else {
        expect(result.reason).toBe('none');
        expect(result.topology.before?.rootPropagation).toBe('private');
        expect(result.topology.before?.artifactsPropagation).toBe('private');
        expect(result.topology.before?.localPeerRelation).toBe('not-shared');
        expect(result.topology.after).toMatchObject({ snapshotEntries: 'one', snapshotIds: 'unique' });
        expect(result.parentStillShared).toBe(mode === 'shared');
        expect(result.allocationRemoved).toBe(true);
      }
      expect(child.stdout).not.toContain(scratch);
    },
  );

  it('captures and durably commits a real self-bind with the inherited tmpfs source', async () => {
    const probe = await fixture();
    try {
      await probe.bind();
      await probe.capture();
      const checks = probe.published[probe.published.length - 1].checks;
      expect(checks.every((check) => check.result === 'passed' && check.reason === 'none')).toBe(true);
      await probe.journal.verifyStorage();
      expect(JSON.stringify(probe.published)).not.toContain(probe.snapshot);
    } finally {
      await probe.close();
    }
  });

  it('rejects a real stacked mount without unmounting either identity', async () => {
    const probe = await fixture();
    await probe.bind();
    await probe.bind();
    try {
      await expect(probe.capture()).rejects.toThrow('Storage mount identity unavailable');
      expect(probe.published[probe.published.length - 1].checks.find((check) => check.id === 'match-count'))
        .toMatchObject({ result: 'failed', reason: 'storage-mount-multiple' });
      await expect(probe.close()).rejects.toThrow('uncommitted');
    } finally {
      // Remove only the extra mount created by this test, then capture the original.
      await execa(tools.umount, [probe.snapshot]);
      await probe.capture();
      await probe.close();
    }
  });

  it.each(['filesystem', 'source'] as const)('identifies real foreign %s mounts', async (kind) => {
    const probe = await fixture();
    if (kind === 'filesystem') {
      await execa(tools.mount, ['--bind', scratch, probe.snapshot]);
    } else {
      await execa(tools.mount, ['-t', 'tmpfs', '-o', 'size=1048576', 'foreign-test-source', probe.snapshot]);
    }
    try {
      await expect(probe.capture()).rejects.toThrow();
      expect(probe.published[probe.published.length - 1].checks.find((check) => check.id === kind))
        .toMatchObject({ result: 'failed', reason: `storage-mount-${kind}` });
      await expect(probe.close()).rejects.toThrow('uncommitted');
    } finally {
      await execa(tools.umount, [probe.snapshot]);
      await probe.bind();
      await probe.capture();
      await probe.close();
    }
  });

  it('identifies a canonical path mismatch after the mount helper resolves a symlink', async () => {
    const probe = await fixture();
    const alias = path.join(path.dirname(probe.snapshot), 'run-alias');
    await fs.symlink(probe.snapshot, alias);
    await probe.journal.prepareStorageMount(alias);
    await execa(tools.mount, ['--bind', alias, alias]);
    try {
      await expect(probe.capture()).rejects.toThrow('Storage mount path changed');
      expect(probe.published[probe.published.length - 1].checks.find((check) => check.id === 'canonical-path'))
        .toMatchObject({ result: 'failed', reason: 'storage-path-changed' });
      await expect(probe.close()).rejects.toThrow('uncommitted');
    } finally {
      await fs.unlink(alias);
      await probe.journal.prepareStorageMount(probe.snapshot);
      await probe.capture();
      await probe.close();
    }
  });

  it('reports a missing mount when a successful helper runs in a different mount namespace', async () => {
    const probe = await fixture();
    const namespace = await fs.readlink('/proc/self/ns/mnt');
    const child = await execa('/usr/bin/unshare', [
      '--mount', '--propagation', 'private', process.execPath, '-e',
      `const fs = require('fs');
       require('child_process').execFileSync('/usr/bin/mount', ['--bind', process.argv[1], process.argv[1]]);
       process.stdout.write(JSON.stringify({ namespaceDifferent: fs.readlinkSync('/proc/self/ns/mnt') !== process.argv[2] }));`,
      probe.snapshot, namespace,
    ]);
    try {
      expect(JSON.parse(child.stdout)).toEqual({ namespaceDifferent: true });
      await expect(probe.capture()).rejects.toThrow('Storage mount identity unavailable');
      expect(probe.published[probe.published.length - 1].checks.find((check) => check.id === 'match-count'))
        .toMatchObject({ result: 'failed', reason: 'storage-mount-missing' });
      try { await probe.close(); throw new Error('expected rejection'); } catch (error) {
        expect(hostPreflightReason(error)).toBe('storage-identity-uncommitted');
      }
    } finally {
      await probe.bind();
      await probe.capture();
      await probe.close();
    }
  });
});
