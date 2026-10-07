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
