import execa = require('execa');
import { AwfRunner } from '../../tests/fixtures/awf-runner';

jest.mock('execa');

const mockExeca = execa as unknown as jest.Mock<
  Promise<execa.ExecaReturnValue<string>>,
  [string, string[], execa.Options]
>;

describe.each(['run', 'runWithSudo'] as const)('AwfRunner.%s', method => {
  beforeEach(() => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    } as execa.ExecaReturnValue<string>);
  });

  it('forwards each required input directory before the command separator', async () => {
    const runner = new AwfRunner('/tmp/awf-cli.js');

    await runner[method]('echo clean', {
      inputDirs: ['/sandbox/inputs', '/sandbox/more inputs'],
    });

    const [executable, args] = mockExeca.mock.calls[0];
    expect(executable).toBe(method === 'run' ? 'node' : 'sudo');
    expect(args).toEqual(expect.arrayContaining(['/tmp/awf-cli.js']));
    expect(args.slice(args.indexOf('--input-dir'))).toEqual([
      '--input-dir', '/sandbox/inputs',
      '--input-dir', '/sandbox/more inputs',
      '--', 'echo clean',
    ]);
  });

  it.each([undefined, []])('adds no input flags for %j', async inputDirs => {
    const runner = new AwfRunner('/tmp/awf-cli.js');

    await runner[method]('echo clean', { inputDirs });

    const args = mockExeca.mock.calls[0][1];
    expect(args).not.toContain('--input-dir');
    expect(args.slice(-2)).toEqual(['--', 'echo clean']);
  });
});
