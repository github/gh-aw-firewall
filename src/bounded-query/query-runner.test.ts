import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker');
const {
  createQueryRunner,
  deriveQueryContainerSpec,
} = require(path.join(brokerDir, 'query-runner.js'));
const { DockerQueryRunner } = require(path.join(brokerDir, 'docker-query-runner.js'));
const { GvisorQueryRunner } = require(path.join(brokerDir, 'gvisor-query-runner.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

interface DockerResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const ok = (overrides: Partial<DockerResult> = {}): DockerResult => ({
  exitCode: 0,
  timedOut: false,
  stdout: '',
  stderr: '',
  ...overrides,
});

const config = {
  queryBackend: 'docker',
  hostWorkDir: '/daemon/private/work',
  queryMountDir: '/query',
  queryScriptPath: '/awf/query-script.py',
  querySeccompPath: '/opt/awf/query-seccomp.json',
  queryImage: 'ghcr.io/example/bounded-query:1',
  memoryLimit: '256m',
  timeoutSeconds: 30,
  queryUid: 65534,
  queryGid: 65534,
};

function createDocker(
  handler: (args: readonly string[]) => DockerResult | Promise<DockerResult> = () => ok(),
) {
  const calls: string[][] = [];
  return {
    calls,
    client: {
      runDocker: async (args: readonly string[]) => {
        calls.push([...args]);
        return handler(args);
      },
    },
  };
}

describe('trusted bounded-query runner contract', () => {
  it('derives a frozen launch specification with no request-controlled surface', () => {
    const maliciousRequest = {
      image: 'attacker/image',
      command: ['sh'],
      mounts: ['/etc:/host'],
      runtime: 'runc',
      env: { LEAK: '1' },
    };
    const spec = deriveQueryContainerSpec({
      config,
      runId: 'abcd1234',
      invocationId: '0123456789abcdef',
      runtimeName: undefined,
      request: maliciousRequest,
    });

    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.launchArgs)).toBe(true);
    expect(spec.launchArgs.join(' ')).not.toContain('attacker');
    expect(spec.launchArgs.join(' ')).not.toContain('/etc:/host');
    expect(spec.launchArgs.join(' ')).not.toContain('LEAK');
    expect(spec.launchArgs.slice(-3)).toEqual([
      '--entrypoint',
      '/usr/local/bin/run-query',
      config.queryImage,
    ]);
    expect(spec.launchArgs.filter((value: string) => value === '-v')).toHaveLength(3);
  });

  it('creates a distinct named sandbox for every invocation', () => {
    const first = deriveQueryContainerSpec({
      config,
      runId: 'abcd1234',
      invocationId: '1111111111111111',
    });
    const second = deriveQueryContainerSpec({
      config,
      runId: 'abcd1234',
      invocationId: '2222222222222222',
    });

    expect(first.containerName).not.toBe(second.containerName);
    expect(first.launchArgs).toContain(first.containerName);
    expect(second.launchArgs).toContain(second.containerName);
    expect(first.launchArgs.join(' ')).toContain('/1111111111111111/repo:');
    expect(second.launchArgs.join(' ')).toContain('/2222222222222222/repo:');
  });

  it('selects Docker default runtime versus the fixed runsc runtime explicitly', () => {
    const dockerRunner = createQueryRunner(config, { docker: createDocker().client });
    const gvisorRunner = createQueryRunner(
      { ...config, queryBackend: 'gvisor' },
      { docker: createDocker().client },
    );

    expect(dockerRunner).toBeInstanceOf(DockerQueryRunner);
    expect(gvisorRunner).toBeInstanceOf(GvisorQueryRunner);
    expect(dockerRunner.spec('abcd1234', '1111111111111111').launchArgs).not.toContain('--runtime');
    const gvisorArgs = gvisorRunner.spec('abcd1234', '1111111111111111').launchArgs;
    expect(gvisorArgs.slice(gvisorArgs.indexOf('--runtime'), gvisorArgs.indexOf('--runtime') + 2))
      .toEqual(['--runtime', 'runsc']);
  });

  it('fails closed for unknown and unavailable runtimes', async () => {
    expect(() => createQueryRunner({ ...config, queryBackend: 'runc' })).toThrow(
      /Unsupported bounded-query backend/,
    );

    const { client } = createDocker((args) => {
      if (args[0] === 'info') return ok({ stdout: '{"runc":{}}' });
      return ok();
    });
    const runner = createQueryRunner({ ...config, queryBackend: 'gvisor' }, { docker: client });
    await expect(runner.assertAvailable()).rejects.toThrow(/runsc OCI runtime; no fallback/);
  });

  it.each([
    ['timeout', false],
    ['error', true],
  ])('removes the labelled invocation after a %s', async (_case, launchThrows) => {
    const containerId = 'a'.repeat(64);
    const { calls, client } = createDocker((args) => {
      if (args[0] === 'run') {
        if (launchThrows) throw new Error('daemon disconnected');
        return ok({ exitCode: 137, timedOut: true });
      }
      if (args[0] === 'ps') return ok({ stdout: `${containerId}\n` });
      return ok();
    });
    const runner = createQueryRunner(config, { docker: client });
    const run = runner.runQueryContainer({
      runId: 'abcd1234',
      invocationId: '1111111111111111',
      timeoutMs: 100,
    });

    if (_case === 'error') {
      await expect(run).rejects.toThrow('daemon disconnected');
    } else {
      await expect(run).resolves.toMatchObject({ timedOut: true });
    }
    const list = calls.find((args) => args[0] === 'ps');
    expect(list).toEqual([
      'ps', '-aq',
      '--filter', 'label=awf.bounded-query.run=abcd1234',
      '--filter', 'label=awf.bounded-query.invocation=1111111111111111',
    ]);
    expect(calls).toContainEqual(['rm', '-f', containerId]);
  });

  it('preserves a successful stopped-container result when cleanup reports it already absent', async () => {
    const { client } = createDocker((args) => {
      if (args[0] === 'run') return ok();
      if (args[0] === 'ps') return ok({ stdout: 'c'.repeat(64) });
      if (args[0] === 'rm') return ok({ exitCode: 1, stderr: 'No such container' });
      return ok();
    });
    const runner = createQueryRunner(config, { docker: client });

    await expect(runner.runQueryContainer({
      runId: 'abcd1234',
      invocationId: '1111111111111111',
    })).resolves.toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('serializes interruption reconciliation with per-invocation cleanup', async () => {
    const events: string[] = [];
    let releaseList: (() => void) | undefined;
    const firstList = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listCount = 0;
    const { client } = createDocker(async (args) => {
      if (args[0] !== 'ps') return ok();
      listCount += 1;
      events.push(`list-${listCount}-start`);
      if (listCount === 1) await firstList;
      events.push(`list-${listCount}-end`);
      return ok();
    });
    const runner = createQueryRunner(config, { docker: client });

    const invocationCleanup = runner.cleanupInvocation('abcd1234', '1111111111111111');
    const reconciliation = runner.reconcileRun('abcd1234');
    await Promise.resolve();
    expect(events).toEqual(['list-1-start']);
    releaseList?.();
    await Promise.all([invocationCleanup, reconciliation]);
    expect(events).toEqual([
      'list-1-start',
      'list-1-end',
      'list-2-start',
      'list-2-end',
    ]);
  });

  it('reconciles interruption leftovers by run label without touching unrelated containers', async () => {
    const abandonedId = 'b'.repeat(64);
    const { calls, client } = createDocker((args) => (
      args[0] === 'ps' ? ok({ stdout: abandonedId }) : ok()
    ));
    const runner = createQueryRunner(config, { docker: client });

    await runner.reconcileRun('abcd1234');

    expect(calls[0]).toEqual([
      'ps', '-aq',
      '--filter', 'label=awf.bounded-query.run=abcd1234',
    ]);
    expect(calls[1]).toEqual(['rm', '-f', abandonedId]);
  });

  it('rejects daemon output that could become an untrusted cleanup argument', async () => {
    const { client } = createDocker((args) => (
      args[0] === 'ps' ? ok({ stdout: '--force' }) : ok()
    ));
    const runner = createQueryRunner(config, { docker: client });

    await expect(runner.reconcileRun('abcd1234')).rejects.toThrow(/invalid.*container id/);
  });
});
