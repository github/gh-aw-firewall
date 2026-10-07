import { execInSandbox, testHelpers } from './sbx-manager';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { logger } from './logger';

const { withLocalBinOnPath } = testHelpers;

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedLogger = jest.mocked(logger);

describe('execInSandbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns exit code 0 on success', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

    const result = await execInSandbox('awf-agent-test', 'echo hello');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exit code and warns', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 42 });

    const result = await execInSandbox('awf-agent-test', 'exit 42');
    expect(result.exitCode).toBe(42);
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('exited with code 42'),
    );
  });

  it('returns exit code 1 when exitCode is null', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: null });

    const result = await execInSandbox('awf-agent-test', 'cmd');
    expect(result.exitCode).toBe(1);
  });

  it('returns exit code 124 on timeout', async () => {
    const timeoutError = Object.assign(new Error('timed out'), { timedOut: true });
    mockExecaFn.mockRejectedValueOnce(timeoutError);

    const result = await execInSandbox('awf-agent-test', 'sleep 999', { timeoutMinutes: 1 });
    expect(result.exitCode).toBe(124);
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('timed out after 1 minutes'),
    );
  });

  it('returns exit code 1 on unexpected exec error', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('exec failed'));

    const result = await execInSandbox('awf-agent-test', 'cmd');
    expect(result.exitCode).toBe(1);
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('exec failed'),
    );
  });

  it('passes workDir flag when specified', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

    await execInSandbox('awf-agent-test', 'ls', { workDir: '/workspace' });

    const args: string[] = mockExecaFn.mock.calls[0][1];
    expect(args).toContain('--workdir');
    expect(args).toContain('/workspace');
  });

  it('passes --tty flag when tty option is true', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

    await execInSandbox('awf-agent-test', 'bash', { tty: true });

    const args: string[] = mockExecaFn.mock.calls[0][1];
    expect(args).toContain('--tty');
  });

  it('passes --env flags for environment variables', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

    await execInSandbox('awf-agent-test', 'env', { environment: { FOO: 'bar', BAZ: 'qux' } });

    const args: string[] = mockExecaFn.mock.calls[0][1];
    expect(args).toContain('--env');
    expect(args).toContain('FOO=bar');
    expect(args).toContain('BAZ=qux');
  });

  it('sets timeout when timeoutMinutes is specified', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

    await execInSandbox('awf-agent-test', 'cmd', { timeoutMinutes: 5 });

    const callOptions = mockExecaFn.mock.calls[0][2];
    expect(callOptions.timeout).toBe(5 * 60 * 1000);
  });

  it('wraps the command so ~/.local/bin is on PATH after login init', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

    await execInSandbox('awf-agent-test', 'copilot --version');

    const args: string[] = mockExecaFn.mock.calls[0][1];
    // The command runs via a login shell (`bash -lc`) whose /etc/profile can
    // reset PATH, so the export must be embedded in the command string.
    expect(args).toContain('-lc');
    const shellCommand = args[args.length - 1];
    expect(shellCommand).toBe(
      'export PATH="$HOME/.local/bin${PATH:+:$PATH}"; copilot --version',
    );
    expect(shellCommand.indexOf('.local/bin')).toBeLessThan(
      shellCommand.indexOf('copilot --version'),
    );
  });

  it('does not set timeout when timeoutMinutes is not specified', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 0 });

    await execInSandbox('awf-agent-test', 'cmd');

    const callOptions = mockExecaFn.mock.calls[0][2];
    expect(callOptions.timeout).toBeUndefined();
  });
});

describe('withLocalBinOnPath', () => {
  it('prepends ~/.local/bin using the runtime $HOME', () => {
    expect(withLocalBinOnPath('copilot')).toBe(
      'export PATH="$HOME/.local/bin${PATH:+:$PATH}"; copilot',
    );
  });

  it('guards against an empty PATH producing a trailing colon', () => {
    // ${PATH:+:$PATH} appends the existing PATH only when it is non-empty, so
    // no empty element (which the shell treats as the cwd) is introduced.
    expect(withLocalBinOnPath('x')).toContain('${PATH:+:$PATH}');
  });

  it('preserves the original command verbatim', () => {
    const cmd = 'foo && bar | baz > out.txt';
    expect(withLocalBinOnPath(cmd).endsWith(`; ${cmd}`)).toBe(true);
  });
});
