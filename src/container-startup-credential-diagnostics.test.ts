import { startContainers } from './container-startup';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('./compose-network-conflicts', () => ({ removeConflictingComposeNetworks: jest.fn() }));
jest.mock('./enclave/startup-diagnostics', () => ({ captureEnclaveStartupDiagnostics: jest.fn() }));

const mountFailure = 'error mounting "/dev/null" to rootfs at "/home/runner/.config/glab-cli/config.yml": permission denied';
const ok = { stdout: '', stderr: '', exitCode: 0 };

function failingCompose(stderr: string, options: object) {
  const realExeca = jest.requireActual<typeof import('execa')>('execa');
  return realExeca(process.execPath, [
    '-e',
    `process.stderr.write(${JSON.stringify(stderr + '\n')}); setTimeout(() => process.exit(1), 200);`,
  ], options);
}

describe('credential mount diagnosis during Compose startup', () => {
  beforeEach(() => {
    mockExecaFn.mockReset();
  });

  it.each([false, true])('streams and diagnoses Compose stderr with readiness=%s', async readiness => {
    let output = '';
    let sawOutput!: () => void;
    const streamed = new Promise<void>(resolve => { sawOutput = resolve; });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      output += String(chunk);
      if (output.includes(mountFailure)) sawOutput();
      return true;
    });
    let upCalls = 0;
    mockExecaFn.mockImplementation((_command, args, options) => {
      if (args.join(' ') === 'compose config --services') {
        return Promise.resolve({ ...ok, stdout: 'squid-proxy\nagent\n' });
      }
      if (args[0] === 'compose' && args[1] === 'up') {
        upCalls++;
        if (readiness && upCalls === 1) return Promise.resolve(ok);
        return failingCompose(mountFailure, options);
      }
      return Promise.resolve(ok);
    });

    try {
      let settled = false;
      const startup = startContainers(process.cwd(), [], undefined, undefined, undefined,
        readiness ? async () => undefined : undefined);
      const result = startup.then(() => undefined, error => error).finally(() => { settled = true; });
      await streamed;
      expect(settled).toBe(false);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/root-squash.*--home/);
      expect(error.message).toContain('/home/runner/.config/glab-cli/config.yml');
      expect(upCalls).toBe(readiness ? 2 : 1);
      expect(mockExecaFn.mock.calls.some(([, args]) => args[0] === 'inspect')).toBe(false);
    } finally {
      write.mockRestore();
    }
  });

  it('diagnoses a mount error on the retry before inspecting infrastructure', async () => {
    let upCalls = 0;
    mockExecaFn.mockImplementation((_command, args, options) => {
      if (args[0] === 'compose' && args[1] === 'up') {
        upCalls++;
        return upCalls === 1
          ? Promise.reject(new Error('dependency failed to start: container awf-api-proxy is unhealthy'))
          : failingCompose(mountFailure, options);
      }
      return Promise.resolve(ok);
    });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(startContainers(process.cwd(), [])).rejects.toThrow(/root-squash.*--home/);
      expect(upCalls).toBe(2);
      expect(mockExecaFn.mock.calls.some(([, args]) => args[0] === 'inspect')).toBe(false);
    } finally {
      write.mockRestore();
    }
  });

  it('preserves an unrelated post-readiness agent failure without retrying', async () => {
    let upCalls = 0;
    mockExecaFn.mockImplementation((_command, args) => {
      if (args.join(' ') === 'compose config --services') {
        return Promise.resolve({ ...ok, stdout: 'squid-proxy\nagent\n' });
      }
      if (args[0] === 'compose' && args[1] === 'up' && ++upCalls === 2) {
        return Promise.reject(new Error('unrelated startup failure'));
      }
      return Promise.resolve(ok);
    });
    await expect(startContainers(process.cwd(), [], undefined, undefined, undefined, async () => undefined))
      .rejects.toThrow('unrelated startup failure');
    expect(upCalls).toBe(2);
    expect(mockExecaFn.mock.calls.some(([, args]) => args[0] === 'inspect')).toBe(false);
  });

  it('does not reinterpret a readiness callback failure as a Compose mount failure', async () => {
    mockExecaFn.mockImplementation((_command, args) =>
      Promise.resolve(args.join(' ') === 'compose config --services'
        ? { ...ok, stdout: 'squid-proxy\nagent\n' } : ok));
    const readinessError = new Error(mountFailure);
    await expect(startContainers(process.cwd(), [], undefined, undefined, undefined, async () => {
      throw readinessError;
    })).rejects.toMatchObject({ message: mountFailure, cause: readinessError });
  });
});
