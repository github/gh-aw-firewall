import {
  APPLE_CONTAINER_DEFAULT_LOG_LINES,
  APPLE_CONTAINER_DEFAULT_LOG_WINDOW,
  APPLE_CONTAINER_DIAGNOSTICS_TIMEOUT_MS,
  buildAppleContainerLogsArgs,
  buildAppleContainerSystemLogsArgs,
  collectAppleContainerDiagnostics,
} from './diagnostics';
import {
  AppleContainerCli,
  type AppleContainerSpawn,
  type AppleContainerSpawnOptions,
  type AppleContainerSpawnResult,
} from './cli';

describe('buildAppleContainerLogsArgs', () => {
  it('bounds output with the short-only -n flag', () => {
    expect(buildAppleContainerLogsArgs('awf-agent')).toEqual([
      'logs', '-n', String(APPLE_CONTAINER_DEFAULT_LOG_LINES), 'awf-agent',
    ]);
  });

  it('requests the VM boot log before the bound and the ID', () => {
    expect(buildAppleContainerLogsArgs('awf-agent', { boot: true, lines: 10 })).toEqual([
      'logs', '--boot', '-n', '10', 'awf-agent',
    ]);
  });

  it('never emits --follow, which would prevent collection from terminating', () => {
    expect(buildAppleContainerLogsArgs('awf-agent')).not.toContain('--follow');
    expect(buildAppleContainerLogsArgs('awf-agent')).not.toContain('-f');
  });

  it('rejects an unbounded or absurd line count', () => {
    expect(() => buildAppleContainerLogsArgs('awf-agent', { lines: 0 })).toThrow(/1\.\.100000/);
    expect(() => buildAppleContainerLogsArgs('awf-agent', { lines: 100_001 })).toThrow();
  });

  it('rejects an invalid container ID', () => {
    expect(() => buildAppleContainerLogsArgs('-evil')).toThrow(/container ID/);
  });
});

describe('buildAppleContainerSystemLogsArgs', () => {
  it('uses a bounded default window', () => {
    expect(buildAppleContainerSystemLogsArgs()).toEqual([
      'system', 'logs', '--last', APPLE_CONTAINER_DEFAULT_LOG_WINDOW,
    ]);
  });

  it('accepts an explicit window', () => {
    expect(buildAppleContainerSystemLogsArgs('1h')).toEqual(['system', 'logs', '--last', '1h']);
  });

  it('never emits --follow', () => {
    expect(buildAppleContainerSystemLogsArgs('2d')).not.toContain('--follow');
  });

  it('rejects a malformed window', () => {
    expect(() => buildAppleContainerSystemLogsArgs('5 minutes')).toThrow(/log window/);
  });
});

interface RecordedCall {
  args: readonly string[];
  options: AppleContainerSpawnOptions;
}

function harness(
  respond: (args: readonly string[]) => Partial<AppleContainerSpawnResult> = () => ({}),
): { cli: AppleContainerCli; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spawn: AppleContainerSpawn = async (_binary, args, options) => {
    calls.push({ args, options });
    return {
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...respond(args),
    };
  };
  return { cli: new AppleContainerCli({ spawn }), calls };
}

describe('collectAppleContainerDiagnostics', () => {
  it('collects host-scoped captures when no container exists', async () => {
    const { cli, calls } = harness(() => ({ stdout: 'output' }));

    const diagnostics = await collectAppleContainerDiagnostics(cli);

    expect(diagnostics.captures.map((capture) => capture.name)).toEqual([
      'system-status.json',
      'containers.json',
      'system.log',
    ]);
    expect(calls.map((call) => call.args)).toEqual([
      ['system', 'status', '--format', 'json'],
      ['list', '--all', '--format', 'json'],
      ['system', 'logs', '--last', APPLE_CONTAINER_DEFAULT_LOG_WINDOW],
    ]);
  });

  it('adds inspect, boot log and stdio log when a container ID is known', async () => {
    const { cli, calls } = harness(() => ({ stdout: 'output' }));

    const diagnostics = await collectAppleContainerDiagnostics(cli, {
      containerId: 'awf-agent',
      logLines: 50,
      systemLogWindow: '1h',
    });

    expect(diagnostics.captures.map((capture) => capture.name)).toEqual([
      'system-status.json',
      'containers.json',
      'system.log',
      'container-inspect.json',
      'container-boot.log',
      'container-stdio.log',
    ]);
    expect(calls[3].args).toEqual(['inspect', 'awf-agent']);
    expect(calls[4].args).toEqual(['logs', '--boot', '-n', '50', 'awf-agent']);
    expect(calls[5].args).toEqual(['logs', '-n', '50', 'awf-agent']);
    expect(calls[2].args).toEqual(['system', 'logs', '--last', '1h']);
  });

  it('bounds every capture with a timeout so teardown cannot hang', async () => {
    const { cli, calls } = harness();
    await collectAppleContainerDiagnostics(cli, { timeoutMs: 1_234 });
    expect(calls.every((call) => call.options.timeoutMs === 1_234)).toBe(true);
  });

  it('applies a default timeout when none is supplied', async () => {
    const { cli, calls } = harness();
    await collectAppleContainerDiagnostics(cli);
    expect(calls[0].options.timeoutMs).toBe(APPLE_CONTAINER_DIAGNOSTICS_TIMEOUT_MS);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'reports an invalid timeout (%p) without invoking the CLI',
    async (timeoutMs) => {
      const { cli, calls } = harness();
      const diagnostics = await collectAppleContainerDiagnostics(cli, { timeoutMs });
      expect(calls).toHaveLength(0);
      expect(diagnostics.captures[0]).toMatchObject({
        name: 'diagnostics-error.txt',
        ok: false,
      });
    },
  );

  it('records a failing capture without aborting the remaining captures', async () => {
    const { cli } = harness((args) =>
      args[0] === 'list'
        ? { exitCode: 1, stderr: 'daemon unreachable' }
        : { stdout: 'fine' },
    );

    const diagnostics = await collectAppleContainerDiagnostics(cli);

    expect(diagnostics.captures).toHaveLength(3);
    const list = diagnostics.captures.find((capture) => capture.name === 'containers.json');
    expect(list).toMatchObject({ ok: false });
    expect(list?.content).toContain('exit 1');
    expect(list?.content).toContain('daemon unreachable');
    expect(diagnostics.captures.filter((capture) => capture.ok)).toHaveLength(2);
  });

  it('notes a timed-out capture explicitly', async () => {
    const { cli } = harness(() => ({ exitCode: null, signal: 'SIGTERM', timedOut: true }));

    const diagnostics = await collectAppleContainerDiagnostics(cli);

    expect(diagnostics.captures[0].content).toContain('timed out');
    expect(diagnostics.captures[0].ok).toBe(false);
  });

  it('never throws when a spawn itself fails', async () => {
    const cli = new AppleContainerCli({
      spawn: async () => {
        throw new Error('spawn ENOENT');
      },
    });

    const diagnostics = await collectAppleContainerDiagnostics(cli);

    expect(diagnostics.captures).toHaveLength(3);
    expect(diagnostics.captures.every((capture) => !capture.ok)).toBe(true);
    expect(diagnostics.captures[0].content).toContain('spawn ENOENT');
    expect(diagnostics.captures[0].argv[0]).toBe('container');
  });

  it('reports a malformed diagnostics request instead of masking the original failure', async () => {
    const { cli, calls } = harness();

    const diagnostics = await collectAppleContainerDiagnostics(cli, { containerId: '-evil' });

    expect(calls).toHaveLength(0);
    expect(diagnostics.captures).toEqual([
      expect.objectContaining({ name: 'diagnostics-error.txt', ok: false }),
    ]);
    expect(diagnostics.captures[0].content).toMatch(/container ID/);
  });

  it('merges stdout and stderr into the capture body', async () => {
    const { cli } = harness(() => ({ stdout: 'out', stderr: 'err' }));
    const diagnostics = await collectAppleContainerDiagnostics(cli);
    expect(diagnostics.captures[0].content).toBe('out\nerr');
  });

  it('accepts plain CLI options instead of an instance', async () => {
    const spawn: AppleContainerSpawn = async () => ({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    });

    const diagnostics = await collectAppleContainerDiagnostics({ spawn, binary: '/opt/container' });

    expect(diagnostics.captures[0].argv[0]).toBe('/opt/container');
  });
});
