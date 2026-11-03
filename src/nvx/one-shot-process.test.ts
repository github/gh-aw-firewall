import { constants as osConstants } from 'os';
import { runNvxProcess, signalExitCode } from './one-shot-process';

const linuxIt = process.platform === 'linux' ? it : it.skip;

describe('NVX one-shot process supervision', () => {
  it('preserves nonzero exits and drains both output streams', async () => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const result = await runNvxProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 42"],
      cwd: process.cwd(),
      env: process.env,
      onStdout: async (chunk) => { stdout.push(chunk); },
      onStderr: async (chunk) => { stderr.push(chunk); },
    });

    expect(result).toEqual({
      exitCode: 42,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
    expect(Buffer.concat(stdout).toString()).toBe('out');
    expect(Buffer.concat(stderr).toString()).toBe('err');
  });

  linuxIt('terminates a timed-out process without reporting cancellation', async () => {
    const result = await runNvxProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 100,
      onStdout: async () => {},
      onStderr: async () => {},
    });

    expect(result).toMatchObject({ timedOut: true, cancelled: false });
  });

  it('maps absent and known termination signals to shell exit codes', () => {
    expect(signalExitCode(null)).toBe(128);
    expect(signalExitCode('SIGTERM')).toBe(128 + osConstants.signals.SIGTERM);
    expect(signalExitCode('SIGKILL')).toBe(128 + osConstants.signals.SIGKILL);
  });
});
