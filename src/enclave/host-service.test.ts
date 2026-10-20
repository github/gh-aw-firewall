import { startHostExecutorService } from './host-service';
import { startHostExecutorServer } from './host-executor-server';

jest.mock('./host-executor-server');
const startServer = jest.mocked(startHostExecutorServer);

describe('backend-neutral authenticated host service', () => {
  const runState = {
    runId: 'a'.repeat(32), seedsDir: '/private/seeds', invocationsDir: '/private/invocations', entries: [],
  };
  beforeEach(() => jest.resetAllMocks());

  it('allows an atomic backend without startInstance or readiness methods', async () => {
    const backend = { execute: jest.fn() };
    const server = { close: jest.fn() };
    startServer.mockResolvedValue(server as never);
    await expect(startHostExecutorService({
      runtimeDir: '/private/service', runState, createBackend: async () => backend,
      startupFailureMessage: 'service unavailable',
    })).resolves.toBe(server);
    expect(startServer).toHaveBeenCalledWith({ runtimeDir: '/private/service', runState, backend });
  });

  it('completes backend preflight and recovery before publishing the listener', async () => {
    await expect(startHostExecutorService({
      runtimeDir: '/private/service', runState,
      createBackend: async () => { throw new Error('recovery pending'); },
      startupFailureMessage: 'service unavailable',
    })).rejects.toThrow('recovery pending');
    expect(startServer).not.toHaveBeenCalled();
  });

  it('closes a container-owning backend on failed startup without exposing private errors', async () => {
    const backend = { execute: jest.fn(), close: jest.fn().mockRejectedValue(new Error('private cleanup')) };
    startServer.mockRejectedValue(new Error('private listener'));
    await expect(startHostExecutorService({
      runtimeDir: '/private/service', runState, createBackend: async () => backend,
      startupFailureMessage: 'service unavailable',
    })).rejects.toThrow('service unavailable');
    expect(backend.close).toHaveBeenCalledTimes(1);
  });
});
