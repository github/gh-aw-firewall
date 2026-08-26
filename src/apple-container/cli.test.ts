import { constants as osConstants } from 'os';
import {
  APPLE_CONTAINER_DEFAULT_BINARY,
  APPLE_CONTAINER_UNKNOWN_EXIT_CODE,
  AppleContainerCli,
  AppleContainerCliError,
  exitCodeForSignal,
  normalizeExitCode,
  type AppleContainerSpawn,
  type AppleContainerSpawnOptions,
  type AppleContainerSpawnResult,
} from './cli';

function spawnResult(
  overrides: Partial<AppleContainerSpawnResult> = {},
): AppleContainerSpawnResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

interface RecordedCall {
  binary: string;
  args: readonly string[];
  options: AppleContainerSpawnOptions;
}

function recordingSpawn(result: Partial<AppleContainerSpawnResult> = {}): {
  spawn: AppleContainerSpawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const spawn: AppleContainerSpawn = async (binary, args, options) => {
    calls.push({ binary, args, options });
    return spawnResult(result);
  };
  return { spawn, calls };
}

describe('exitCodeForSignal', () => {
  it('maps SIGTERM and SIGKILL to the 128 + signum convention', () => {
    expect(exitCodeForSignal('SIGTERM')).toBe(128 + (osConstants.signals.SIGTERM as number));
    expect(exitCodeForSignal('SIGKILL')).toBe(128 + (osConstants.signals.SIGKILL as number));
  });

  it('never reports success for an unrecognised signal', () => {
    expect(exitCodeForSignal('SIGNOPE' as NodeJS.Signals)).toBe(APPLE_CONTAINER_UNKNOWN_EXIT_CODE);
  });

  it('does not treat inherited Object prototype keys as signals', () => {
    expect(exitCodeForSignal('toString' as NodeJS.Signals)).toBe(
      APPLE_CONTAINER_UNKNOWN_EXIT_CODE,
    );
  });
});

describe('normalizeExitCode', () => {
  it('preserves a zero exit code', () => {
    expect(normalizeExitCode(spawnResult({ exitCode: 0 }))).toBe(0);
  });

  it('preserves an arbitrary non-zero exit code', () => {
    expect(normalizeExitCode(spawnResult({ exitCode: 137 }))).toBe(137);
  });

  it('prefers a real exit code over a reported signal', () => {
    expect(normalizeExitCode(spawnResult({ exitCode: 3, signal: 'SIGTERM' }))).toBe(3);
  });

  it('falls back to the signal when there is no exit code', () => {
    expect(normalizeExitCode(spawnResult({ exitCode: null, signal: 'SIGKILL' }))).toBe(
      128 + (osConstants.signals.SIGKILL as number),
    );
  });

  it('reports an unknown death as a failure rather than success', () => {
    expect(normalizeExitCode(spawnResult({ exitCode: undefined, signal: undefined }))).toBe(
      APPLE_CONTAINER_UNKNOWN_EXIT_CODE,
    );
  });
});

describe('AppleContainerCli.run', () => {
  it('defaults to the "container" binary and forwards argv unchanged', async () => {
    const { spawn, calls } = recordingSpawn();
    const cli = new AppleContainerCli({ spawn });

    const result = await cli.run(['system', 'status', '--format', 'json']);

    expect(cli.binary).toBe(APPLE_CONTAINER_DEFAULT_BINARY);
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe('container');
    expect(calls[0].args).toEqual(['system', 'status', '--format', 'json']);
    expect(result.argv).toEqual(['container', 'system', 'status', '--format', 'json']);
  });

  it('honours a pinned binary path', async () => {
    const { spawn, calls } = recordingSpawn();
    const cli = new AppleContainerCli({ spawn, binary: '/usr/local/bin/container' });

    await cli.run(['--version']);

    expect(calls[0].binary).toBe('/usr/local/bin/container');
  });

  it('applies constructor defaults to spawn options', async () => {
    const { spawn, calls } = recordingSpawn();
    const cli = new AppleContainerCli({
      spawn,
      cwd: '/work',
      env: { PATH: '/bin' },
      timeoutMs: 1_000,
      killSignal: 'SIGKILL',
    });

    await cli.run(['list']);

    expect(calls[0].options).toMatchObject({
      cwd: '/work',
      env: { PATH: '/bin' },
      timeoutMs: 1_000,
      killSignal: 'SIGKILL',
    });
  });

  it('lets per-call overrides win over constructor defaults', async () => {
    const { spawn, calls } = recordingSpawn();
    const cli = new AppleContainerCli({ spawn, timeoutMs: 1_000, cwd: '/work' });

    await cli.run(['list'], { timeoutMs: 50, cwd: '/other', inheritStdio: true });

    expect(calls[0].options).toMatchObject({
      timeoutMs: 50,
      cwd: '/other',
      inheritStdio: true,
    });
  });

  it('propagates a non-zero exit code without throwing', async () => {
    const cli = new AppleContainerCli({ spawn: async () => spawnResult({ exitCode: 42 }) });

    await expect(cli.run(['run'])).resolves.toMatchObject({ exitCode: 42, timedOut: false });
  });

  it('reports a timeout distinctly from an ordinary failure', async () => {
    const cli = new AppleContainerCli({
      spawn: async () => spawnResult({ exitCode: null, signal: 'SIGTERM', timedOut: true }),
    });

    const result = await cli.run(['run']);

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBe(128 + (osConstants.signals.SIGTERM as number));
  });

  it('normalises missing captured output to empty strings', async () => {
    const cli = new AppleContainerCli({
      spawn: async () =>
        ({ exitCode: 0, signal: null, timedOut: false } as unknown as AppleContainerSpawnResult),
    });

    await expect(cli.run(['list'])).resolves.toMatchObject({ stdout: '', stderr: '' });
  });

  it('does not swallow a spawn rejection', async () => {
    const cli = new AppleContainerCli({
      spawn: async () => {
        throw new Error('spawn ENOENT');
      },
    });

    await expect(cli.run(['--version'])).rejects.toThrow('spawn ENOENT');
  });
});

describe('AppleContainerCli.runChecked', () => {
  it('returns the result on success', async () => {
    const cli = new AppleContainerCli({
      spawn: async () => spawnResult({ stdout: 'ok' }),
    });

    await expect(cli.runChecked(['list'])).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
  });

  it('throws an AppleContainerCliError that carries the failing result', async () => {
    const cli = new AppleContainerCli({
      spawn: async () => spawnResult({ exitCode: 2, stderr: 'no such container' }),
    });

    expect.assertions(4);
    try {
      await cli.runChecked(['inspect', 'missing']);
    } catch (error) {
      expect(error).toBeInstanceOf(AppleContainerCliError);
      const cliError = error as AppleContainerCliError;
      expect(cliError.exitCode).toBe(2);
      expect(cliError.result.argv).toEqual(['container', 'inspect', 'missing']);
      expect(cliError.message).toContain('no such container');
    }
  });

  it('describes a timeout in the error message and flags it', async () => {
    const cli = new AppleContainerCli({
      spawn: async () => spawnResult({ exitCode: null, signal: 'SIGTERM', timedOut: true }),
    });

    expect.assertions(2);
    try {
      await cli.runChecked(['image', 'pull', 'ubuntu:22.04']);
    } catch (error) {
      expect((error as AppleContainerCliError).message).toContain('timed out');
      expect((error as AppleContainerCliError).timedOut).toBe(true);
    }
  });

  it('describes a fatal signal when there was no timeout', async () => {
    const cli = new AppleContainerCli({
      spawn: async () => spawnResult({ exitCode: null, signal: 'SIGKILL' }),
    });

    await expect(cli.runChecked(['stop', 'abc'])).rejects.toThrow(/terminated by SIGKILL/);
  });

  it('falls back to stdout when stderr is empty', async () => {
    const cli = new AppleContainerCli({
      spawn: async () => spawnResult({ exitCode: 1, stdout: 'apiserver is not running' }),
    });

    await expect(cli.runChecked(['system', 'status'])).rejects.toThrow(/apiserver is not running/);
  });

  it('still produces a message when there is no output at all', async () => {
    const cli = new AppleContainerCli({ spawn: async () => spawnResult({ exitCode: 1 }) });

    await expect(cli.runChecked(['list'])).rejects.toThrow(
      '"container list" exited with code 1',
    );
  });
});
