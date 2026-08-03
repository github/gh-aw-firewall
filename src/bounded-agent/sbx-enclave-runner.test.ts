import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-agent', 'broker');
const { SbxEnclaveRunner, parseSandboxNames } = require(path.join(brokerDir, 'sbx-enclave-runner.js'));
const {
  deriveSbxEnclaveSpec,
  SBX_ENCLAVE_TEMPLATE,
  REQUIRED_HARD_ISOLATION_FLAGS,
} = require(path.join(brokerDir, 'sbx-enclave-runner-spec.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Security-critical contract tests for the bounded-agent sbx enclave runner.
 *
 * This mirrors the coverage bounded queries already have for their sbx
 * backend (`src/bounded-query/query-runner.test.ts:158-305`): a fixed launch
 * specification derived only from trusted identifiers, capability rejection,
 * trusted-ID validation, create/exec timeout accounting, prefix-scoped
 * reconciliation, malformed-inventory rejection, and guaranteed stop/remove
 * cleanup — including when cleanup itself fails.
 */

interface SbxResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const ok = (overrides: Partial<SbxResult> = {}): SbxResult => ({
  exitCode: 0,
  timedOut: false,
  stdout: '',
  stderr: '',
  ...overrides,
});

const config = {
  sbxWorkDir: '/sbx-daemon/private/work',
  sbxSeedsDir: '/sbx-daemon/private/seeds',
  enclaveSeedPath: '/awf/seed',
  enclaveTaskPath: '/awf/task.txt',
  enclaveSchemaPath: '/awf/schema.json',
  enclaveMountDir: '/agent',
  enclaveUid: 65534,
  enclaveGid: 65534,
  cpuLimit: '1',
  memoryLimit: '512m',
  network: 'awf-bounded-agent',
  pidsLimit: 128,
  tmpfsLimit: '64m',
  timeoutSeconds: 120,
};

const RUN_ID = 'abcd1234abcd1234abcd1234abcd1234';
const INVOCATION_ID = '111111111111111111111111';
const SEED_ID = 'a'.repeat(32);

type SbxHandler = (args: readonly string[], timeoutMs: number) => SbxResult | Promise<SbxResult>;

function createSbx(handler: SbxHandler = () => ok()) {
  const calls: string[][] = [];
  const timeouts: number[] = [];
  return {
    calls,
    timeouts,
    client: {
      runSbx: async (args: readonly string[], timeoutMs: number) => {
        calls.push([...args]);
        timeouts.push(timeoutMs);
        return handler(args, timeoutMs);
      },
    },
  };
}

function createFiles() {
  const created: string[] = [];
  return {
    created,
    files: {
      mkdirSync: (target: string) => {
        created.push(target);
      },
    },
  };
}

const availableProbe = async () => ({ supported: true, missing: [] });

describe('bounded-agent sbx enclave runner contract', () => {
  describe('deriveSbxEnclaveSpec: fixed spec derived only from trusted identifiers', () => {
    it('derives a frozen, unique-per-invocation launch specification', () => {
      const first = deriveSbxEnclaveSpec({
        config, runId: RUN_ID, invocationId: INVOCATION_ID, seedId: SEED_ID,
      });
      const second = deriveSbxEnclaveSpec({
        config, runId: RUN_ID, invocationId: '222222222222222222222222', seedId: SEED_ID,
      });

      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.createArgs)).toBe(true);
      expect(Object.isFrozen(first.execArgs)).toBe(true);
      expect(first.sandboxName).not.toBe(second.sandboxName);
      expect(first.runPrefix).toBe(`awf-bounded-agent-sbx-${RUN_ID}-`);
      expect(first.sandboxName).toBe(`${first.runPrefix}${INVOCATION_ID}`);
      expect(first.createArgs).toContain(SBX_ENCLAVE_TEMPLATE);
      for (const flag of REQUIRED_HARD_ISOLATION_FLAGS) {
        expect(first.createArgs).toContain(flag);
      }
      expect(first.createArgs.join(' ')).toContain(
        `${config.sbxSeedsDir}/${SEED_ID}:${config.enclaveSeedPath}:ro`,
      );
      expect(first.createArgs.join(' ')).toContain(`${config.sbxWorkDir}/${INVOCATION_ID}/task.txt`);
      expect(first.createArgs.join(' ')).toContain(`${config.sbxWorkDir}/${INVOCATION_ID}/schema.json`);
      expect(first.execArgs).toContain(`${config.enclaveUid}:${config.enclaveGid}`);
      expect(first.execArgs).toContain(config.enclaveMountDir);
      expect(first.execArgs).toContain(first.sandboxName);
      expect(first.execArgs.slice(-1)).toEqual(['/usr/local/bin/run-bounded-agent']);
      expect(first.stopArgs).toEqual(['stop', first.sandboxName]);
      expect(first.removeArgs).toEqual(['rm', '--force', first.sandboxName]);
      expect(first.listArgs).toEqual(['ls', '--json']);
    });

    it.each([
      ['runId', { runId: 'not-hex', invocationId: INVOCATION_ID, seedId: SEED_ID }, /runId/],
      ['invocationId', { runId: RUN_ID, invocationId: 'short', seedId: SEED_ID }, /invocationId/],
      ['seedId', { runId: RUN_ID, invocationId: INVOCATION_ID, seedId: 'zz' }, /seedId/],
      ['runId with injection', {
        runId: `${RUN_ID}; rm -rf /`, invocationId: INVOCATION_ID, seedId: SEED_ID,
      }, /runId/],
    ])('rejects a malformed or untrusted %s', (_name, params, message) => {
      expect(() => deriveSbxEnclaveSpec({ config, ...params })).toThrow(message);
    });
  });

  describe('assertAvailable: capability rejection', () => {
    it('blocks the audited sbx CLI and reports every missing capability', async () => {
      const missing = ['pinned AWF bounded-agent sbx template and bootstrap', 'sbx create --network'];
      const runner = new SbxEnclaveRunner(config, {
        probe: async () => ({ supported: false, missing }),
      });

      await expect(runner.assertAvailable()).rejects.toThrow(/blocked.*No fallback/s);
      await expect(runner.assertAvailable()).rejects.toThrow(
        'pinned AWF bounded-agent sbx template and bootstrap',
      );
      await expect(runner.assertAvailable()).rejects.toThrow('sbx create --network');
    });

    it('never launches when the probe throws instead of returning a report', async () => {
      const runner = new SbxEnclaveRunner(config, {
        probe: async () => {
          throw new Error('sbx CLI not found');
        },
      });
      await expect(runner.assertAvailable()).rejects.toThrow('sbx CLI not found');
    });
  });

  describe('runEnclaveContainer: create/exec timeout accounting', () => {
    it('runs exec with the remaining budget after a successful create', async () => {
      let now = 0;
      const { calls, timeouts, client } = createSbx((args) => {
        if (args[0] === 'create') {
          now += 10_000; // simulate elapsed wall-clock time during create
        }
        return ok();
      });
      const { files } = createFiles();
      const runner = new SbxEnclaveRunner(config, {
        sbx: client,
        probe: availableProbe,
        files,
        nowMs: () => now,
      });

      const result = await runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        seedId: SEED_ID,
        timeoutMs: 60_000,
      });

      expect(result).toEqual({ exitCode: 0, timedOut: false });
      const createIndex = calls.findIndex((call) => call[0] === 'create');
      const execIndex = calls.findIndex((call) => call[0] === 'exec');
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(execIndex).toBeGreaterThan(createIndex);
      const orderedTimeouts = [...timeouts];
      const [createTimeoutMs, execTimeoutMs] = createIndex < execIndex
        ? [orderedTimeouts[createIndex], orderedTimeouts[execIndex]]
        : [orderedTimeouts[execIndex], orderedTimeouts[createIndex]];
      // create is capped at 120s even though the full budget (60s + grace) is larger.
      expect(createTimeoutMs).toBeLessThanOrEqual(120_000);
      // exec receives the budget remaining after create's simulated 10s elapsed.
      expect(execTimeoutMs).toBeLessThanOrEqual(60_000 + 15_000);
      expect(execTimeoutMs).toBeLessThan(createTimeoutMs);
    });

    it('returns a timed-out result and never execs when create itself times out', async () => {
      const { calls, client } = createSbx((args) => (
        args[0] === 'create' ? ok({ timedOut: true, exitCode: 124 }) : ok()
      ));
      const { files } = createFiles();
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe, files });

      const result = await runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        seedId: SEED_ID,
        timeoutMs: 1_000,
      });

      expect(result).toEqual({ exitCode: 124, timedOut: true });
      expect(calls.some((call) => call[0] === 'exec')).toBe(false);
      // Cleanup still runs deterministically after a create timeout.
      expect(calls).toContainEqual(['stop', `awf-bounded-agent-sbx-${RUN_ID}-${INVOCATION_ID}`]);
      expect(calls).toContainEqual(['rm', '--force', `awf-bounded-agent-sbx-${RUN_ID}-${INVOCATION_ID}`]);
    });

    it('skips exec and reports a synthetic timeout when the deadline elapses between create and exec', async () => {
      let now = 0;
      const { calls, client } = createSbx((args) => {
        if (args[0] === 'create') {
          now += 1_000_000; // blow through the deadline entirely during create
        }
        return ok();
      });
      const { files } = createFiles();
      const runner = new SbxEnclaveRunner(config, {
        sbx: client, probe: availableProbe, files, nowMs: () => now,
      });

      const result = await runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        seedId: SEED_ID,
        timeoutMs: 1_000,
      });

      expect(result).toEqual({ exitCode: 124, timedOut: true });
      expect(calls.some((call) => call[0] === 'exec')).toBe(false);
    });

    it('throws and still cleans up when create fails outright', async () => {
      const { calls, client } = createSbx((args) => (
        args[0] === 'create' ? ok({ exitCode: 1 }) : ok()
      ));
      const { files } = createFiles();
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe, files });

      await expect(runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        seedId: SEED_ID,
      })).rejects.toThrow('Failed to create bounded-agent sbx VM');
      expect(calls.some((call) => call[0] === 'exec')).toBe(false);
      expect(calls).toContainEqual(['stop', `awf-bounded-agent-sbx-${RUN_ID}-${INVOCATION_ID}`]);
      expect(calls).toContainEqual(['rm', '--force', `awf-bounded-agent-sbx-${RUN_ID}-${INVOCATION_ID}`]);
    });
  });

  describe('deterministic stop/rm cleanup, including cleanup failures', () => {
    it('always force-removes the uniquely named VM before returning a success', async () => {
      const { calls, client } = createSbx((args) => (
        args[0] === 'ls' && args[1] === '--quiet' ? ok({ stdout: '' }) : ok()
      ));
      const { files } = createFiles();
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe, files });

      await expect(runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        seedId: SEED_ID,
      })).resolves.toEqual({ exitCode: 0, timedOut: false });

      const name = `awf-bounded-agent-sbx-${RUN_ID}-${INVOCATION_ID}`;
      expect(calls.find((args) => args[0] === 'create')).toContain(name);
      expect(calls.find((args) => args[0] === 'exec')).toContain(name);
      expect(calls).toContainEqual(['stop', name]);
      expect(calls).toContainEqual(['rm', '--force', name]);
      expect(calls[calls.length - 1]).toEqual(['rm', '--force', name]);
    });

    it('preserves a successful result when stop fails but inventory confirms the VM is already gone', async () => {
      const { calls, client } = createSbx((args) => {
        if (args[0] === 'stop') return ok({ exitCode: 1 });
        if (args[0] === 'ls' && args[1] === '--quiet') return ok({ stdout: '' });
        return ok();
      });
      const { files } = createFiles();
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe, files });

      await expect(runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        seedId: SEED_ID,
      })).resolves.toEqual({ exitCode: 0, timedOut: false });
      const name = `awf-bounded-agent-sbx-${RUN_ID}-${INVOCATION_ID}`;
      expect(calls).toContainEqual(['rm', '--force', name]);
    });

    it('fails closed when stop fails and inventory still lists the VM', async () => {
      const name = `awf-bounded-agent-sbx-${RUN_ID}-${INVOCATION_ID}`;
      const { client } = createSbx((args) => {
        if (args[0] === 'stop') return ok({ exitCode: 1 });
        if (args[0] === 'ls' && args[1] === '--quiet') return ok({ stdout: `${name}\n` });
        return ok();
      });
      const { files } = createFiles();
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe, files });

      await expect(runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        seedId: SEED_ID,
      })).rejects.toThrow('Failed to stop bounded-agent sbx VM');
    });

    it('fails closed when remove fails after a successful stop', async () => {
      const { client } = createSbx((args) => (args[0] === 'rm' ? ok({ exitCode: 1 }) : ok()));
      const { files } = createFiles();
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe, files });

      await expect(runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        seedId: SEED_ID,
      })).rejects.toThrow('Failed to remove bounded-agent sbx VM');
    });

    it('surfaces the cleanup failure even when the run itself also failed (cleanup takes priority)', async () => {
      const { client } = createSbx((args) => {
        if (args[0] === 'create') return ok({ exitCode: 1 });
        if (args[0] === 'rm') return ok({ exitCode: 1 });
        return ok();
      });
      const { files } = createFiles();
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe, files });

      await expect(runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: INVOCATION_ID,
        seedId: SEED_ID,
      })).rejects.toThrow('Failed to remove bounded-agent sbx VM');
    });

    it('serializes interruption reconciliation with per-invocation cleanup', async () => {
      const events: string[] = [];
      let releaseStop: (() => void) | undefined;
      const stopGate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      let stopCount = 0;
      const { client } = createSbx(async (args) => {
        if (args[0] === 'stop') {
          stopCount += 1;
          const label = `stop-${stopCount}`;
          events.push(`${label}-start`);
          if (stopCount === 1) await stopGate;
          events.push(`${label}-end`);
          return ok();
        }
        if (args[0] === 'ls' && args[1] === '--json') {
          events.push('reconcile-list');
          return ok({ stdout: '[]' });
        }
        return ok();
      });
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe });

      const invocationCleanup = runner.cleanupInvocation(RUN_ID, INVOCATION_ID);
      const reconciliation = runner.reconcileRun(RUN_ID);
      await Promise.resolve();
      await Promise.resolve();
      expect(events).toEqual(['stop-1-start']);
      releaseStop?.();
      await Promise.all([invocationCleanup, reconciliation]);
      expect(events).toEqual(['stop-1-start', 'stop-1-end', 'reconcile-list']);
    });
  });

  describe('reconcileRun: prefix-scoped reconciliation', () => {
    it('reconciles only sbx VMs with the current trusted run prefix', async () => {
      const staleName = `awf-bounded-agent-sbx-${RUN_ID}-222222222222222222222222`;
      const { calls, client } = createSbx((args) => {
        if (args[0] === 'ls' && args[1] === '--json') {
          return ok({
            stdout: JSON.stringify([
              { name: staleName },
              { name: 'awf-bounded-agent-sbx-other-run-333333333333333333333333' },
              { name: 'awf-query-sbx-primary' },
            ]),
          });
        }
        return ok();
      });
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe });

      await runner.reconcileRun(RUN_ID);

      expect(calls).toContainEqual(['stop', staleName]);
      expect(calls).toContainEqual(['rm', '--force', staleName]);
      expect(calls.join(' ')).not.toContain('other-run');
      expect(calls.join(' ')).not.toContain('awf-query-sbx-primary');
    });

    it('removes nothing when no VM in inventory matches this run prefix', async () => {
      const { calls, client } = createSbx((args) => (
        args[0] === 'ls' && args[1] === '--json'
          ? ok({ stdout: JSON.stringify([{ name: 'awf-bounded-agent-sbx-unrelated-000000000000000000000000' }]) })
          : ok()
      ));
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe });

      await runner.reconcileRun(RUN_ID);

      expect(calls.some((call) => call[0] === 'stop' || call[0] === 'rm')).toBe(false);
    });

    it('fails closed when listing sandboxes itself fails', async () => {
      const { client } = createSbx((args) => (
        args[0] === 'ls' && args[1] === '--json' ? ok({ exitCode: 1 }) : ok()
      ));
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe });

      await expect(runner.reconcileRun(RUN_ID)).rejects.toThrow('Failed to reconcile bounded-agent sbx VMs');
    });
  });

  describe('parseSandboxNames: malformed inventory rejection', () => {
    it('rejects non-JSON, non-array, and shell-metacharacter-bearing inventory', () => {
      expect(() => parseSandboxNames('not json')).toThrow(/malformed sandbox inventory/);
      expect(() => parseSandboxNames('{"name":"x"}')).toThrow(/malformed sandbox inventory/);
      expect(() => parseSandboxNames('[{"name":"--all"}]')).toThrow(/invalid sandbox name/);
      expect(() => parseSandboxNames('[{"name":"; rm -rf /"}]')).toThrow(/invalid sandbox name/);
      expect(() => parseSandboxNames('[{}]')).toThrow(/invalid sandbox name/);
    });

    it('accepts a well-formed sandbox name list', () => {
      expect(parseSandboxNames('[{"name":"awf-bounded-agent-sbx-abc-123"}]')).toEqual([
        'awf-bounded-agent-sbx-abc-123',
      ]);
    });

    it('rejects malformed sbx inventory rather than accepting cleanup injection', async () => {
      const { client } = createSbx((args) => (
        args[0] === 'ls' ? ok({ stdout: '[{"name":"--all"}]' }) : ok()
      ));
      const runner = new SbxEnclaveRunner(config, { sbx: client, probe: availableProbe });

      await expect(runner.reconcileRun(RUN_ID)).rejects.toThrow(/invalid sandbox name/);
    });
  });
});
