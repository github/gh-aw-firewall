import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-agent', 'broker');
const { SbxEnclaveRunner, parseSandboxNames } = require(path.join(brokerDir, 'sbx-enclave-runner.js'));
const {
  SBX_ENCLAVE_TEMPLATE,
  REQUIRED_HARD_ISOLATION_FLAGS,
  deriveSbxEnclaveSpec,
} = require(path.join(brokerDir, 'sbx-enclave-runner-spec.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const RUN_ID = 'a'.repeat(32);
const INVOCATION_ID = 'b'.repeat(24);
const SEED_ID = 'c'.repeat(32);
const config = {
  sbxWorkDir: '/sbx-daemon/private/work',
  sbxSeedsDir: '/sbx-daemon/private/seeds',
  enclaveMountDir: '/agent',
  enclaveSeedPath: '/awf/seed',
  enclaveTaskPath: '/awf/task.txt',
  enclaveSchemaPath: '/awf/schema.json',
  enclaveUid: 65534,
  enclaveGid: 65534,
  network: 'awf-bounded-agent',
  timeoutSeconds: 120,
  memoryLimit: '512m',
  tmpfsLimit: '64m',
  cpuLimit: '1',
  pidsLimit: 128,
};

const result = (overrides: Record<string, unknown> = {}) => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...overrides,
});

function createSbx(handler: (args: string[], timeout: number) => Record<string, unknown> = () => result()) {
  const calls: Array<{ args: string[]; timeout: number }> = [];
  return {
    calls,
    client: {
      runSbx: async (args: string[], timeout: number) => {
        calls.push({ args, timeout });
        return handler(args, timeout);
      },
    },
  };
}

describe('bounded-agent sbx enclave runner contract', () => {
  it('derives a frozen launch surface only from trusted identifiers', () => {
    const spec = deriveSbxEnclaveSpec({ config, runId: RUN_ID, invocationId: INVOCATION_ID, seedId: SEED_ID });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.createArgs)).toBe(true);
    expect(spec.createArgs).toContain(SBX_ENCLAVE_TEMPLATE);
    for (const flag of REQUIRED_HARD_ISOLATION_FLAGS) expect(spec.createArgs).toContain(flag);
    expect(spec.createArgs.join(' ')).toContain(
      `/sbx-daemon/private/seeds/${SEED_ID}:/awf/seed:ro`,
    );
    expect(spec.execArgs).toEqual([
      'exec', '--user', '65534:65534', '--workdir', '/agent',
      spec.sandboxName, '/usr/local/bin/run-bounded-agent',
    ]);
  });

  it('rejects untrusted identifiers before constructing CLI arguments', () => {
    for (const value of ['', '../escape', '--all', 'UPPER']) {
      expect(() => deriveSbxEnclaveSpec({
        config,
        runId: RUN_ID,
        invocationId: value,
        seedId: SEED_ID,
      })).toThrow(/broker-generated identifier/);
    }
  });

  it('blocks launch unless every executable capability is proven', async () => {
    const runner = new SbxEnclaveRunner(config, {
      probe: async () => ({ supported: false, missing: ['mandatory network policy'] }),
    });
    await expect(runner.assertAvailable()).rejects.toThrow(/blocked.*No fallback/s);
  });

  it('always stops and force-removes the invocation while discarding streams', async () => {
    const { calls, client } = createSbx((args) => {
      if (args[0] === 'exec') return result({ stdout: 'SECRET', stderr: 'DIAGNOSTIC' });
      if (args[0] === 'ls' && args[1] === '--quiet') return result();
      return result();
    });
    const runner = new SbxEnclaveRunner(config, {
      sbx: client,
      probe: async () => ({ supported: true, missing: [] }),
      files: { mkdirSync: jest.fn() },
    });
    await runner.assertAvailable();
    const runResult = await runner.runEnclaveContainer({
      runId: RUN_ID,
      invocationId: INVOCATION_ID,
      seedId: SEED_ID,
      timeoutMs: 1000,
    });
    expect(runResult).toEqual({ exitCode: 0, timedOut: false });
    const name = runner.spec(RUN_ID, INVOCATION_ID, SEED_ID).sandboxName;
    expect(calls.map((call) => call.args)).toContainEqual(['stop', name]);
    expect(calls.map((call) => call.args)).toContainEqual(['rm', '--force', name]);
    expect(JSON.stringify(runResult)).not.toContain('SECRET');
  });

  it('shares one deadline across create and exec', async () => {
    let now = 1000;
    const { calls, client } = createSbx((args) => {
      if (args[0] === 'create') now += 400;
      return result();
    });
    const runner = new SbxEnclaveRunner(config, {
      sbx: client,
      files: { mkdirSync: jest.fn() },
      nowMs: () => now,
    });
    await runner.runEnclaveContainer({
      runId: RUN_ID,
      invocationId: INVOCATION_ID,
      seedId: SEED_ID,
      timeoutMs: 1000,
    });
    const createCall = calls.find((call) => call.args[0] === 'create');
    const execCall = calls.find((call) => call.args[0] === 'exec');
    expect(createCall?.timeout).toBeLessThanOrEqual(16_000);
    expect(execCall?.timeout).toBe(15_600);
  });

  it('reconciles only the current trusted run prefix', async () => {
    const stale = `awf-bounded-agent-sbx-${RUN_ID}-${INVOCATION_ID}`;
    const { calls, client } = createSbx((args) => (
      args[0] === 'ls' && args[1] === '--json'
        ? result({ stdout: JSON.stringify([{ name: stale }, { name: 'awf-agent-primary' }]) })
        : result()
    ));
    const runner = new SbxEnclaveRunner(config, { sbx: client });
    await runner.reconcileRun(RUN_ID);
    expect(calls.map((call) => call.args)).toContainEqual(['rm', '--force', stale]);
    expect(calls.map((call) => call.args).flat()).not.toContain('awf-agent-primary');
  });

  it('rejects malformed and option-shaped inventory names', () => {
    expect(() => parseSandboxNames('not-json')).toThrow(/malformed sandbox inventory/);
    expect(() => parseSandboxNames('{"name":"x"}')).toThrow(/malformed sandbox inventory/);
    expect(() => parseSandboxNames('[{"name":"--all"}]')).toThrow(/invalid sandbox name/);
  });

  it('fails closed when cleanup fails after successful execution', async () => {
    const { client } = createSbx((args) => (
      args[0] === 'rm' ? result({ exitCode: 1 }) : result()
    ));
    const runner = new SbxEnclaveRunner(config, {
      sbx: client,
      files: { mkdirSync: jest.fn() },
    });
    await expect(runner.runEnclaveContainer({
      runId: RUN_ID,
      invocationId: INVOCATION_ID,
      seedId: SEED_ID,
    })).rejects.toThrow(/remove bounded-agent sbx VM/);
  });
});
