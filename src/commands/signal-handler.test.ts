import { registerSignalHandlers } from './signal-handler';

type SignalHandlerDependencies = Parameters<typeof registerSignalHandlers>[0];

const flushPromises = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('registerSignalHandlers', () => {
  let processOnSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    // Capture registered handlers instead of actually registering them
    processOnSpy = jest.spyOn(process, 'on').mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        handlers[String(event)] = handler;
        return process;
      }
    );
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    delete handlers['SIGINT'];
    delete handlers['SIGTERM'];
  });

  it('registers SIGINT and SIGTERM handlers', () => {
    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => false,
      keepContainers: false,
      fastKillAgentContainer: jest.fn().mockResolvedValue(undefined),
      performCleanup: jest.fn().mockResolvedValue(undefined),
    };

    registerSignalHandlers(deps);

    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('fast-kills agent container on SIGINT when containers are started and keepContainers is false', async () => {
    const fastKill = jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => true,
      keepContainers: false,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    handlers['SIGINT']();
    await flushPromises();
    expect(fastKill).toHaveBeenCalled();
    expect(performCleanup).toHaveBeenCalledWith('SIGINT');
    expect(processExitSpy).toHaveBeenCalledWith(130);
  });

  it('skips fast-kill on SIGINT when containers are not started', async () => {
    const fastKill = jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => false,
      keepContainers: false,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    handlers['SIGINT']();
    await flushPromises();
    expect(fastKill).not.toHaveBeenCalled();
    expect(performCleanup).toHaveBeenCalledWith('SIGINT');
  });

  it('skips fast-kill on SIGINT when keepContainers is true', async () => {
    const fastKill = jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => true,
      keepContainers: true,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    handlers['SIGINT']();
    await flushPromises();
    expect(fastKill).not.toHaveBeenCalled();
  });

  it('fast-kills agent container on SIGTERM when containers are started and keepContainers is false', async () => {
    const fastKill = jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => true,
      keepContainers: false,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    handlers['SIGTERM']();
    await flushPromises();
    expect(fastKill).toHaveBeenCalled();
    expect(performCleanup).toHaveBeenCalledWith('SIGTERM');
    expect(processExitSpy).toHaveBeenCalledWith(143);
  });

  it('swallows errors thrown during SIGINT handling', async () => {
    const fastKill = jest.fn().mockRejectedValue(new Error('kill failed'));
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => true,
      keepContainers: false,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    // Should not throw even though fastKillAgentContainer rejects
    handlers['SIGINT']();
    await flushPromises();
    expect(processExitSpy).toHaveBeenCalledWith(130);
  });

  it('swallows errors thrown during SIGTERM handling', async () => {
    const fastKill = jest.fn().mockRejectedValue(new Error('kill failed'));
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => true,
      keepContainers: false,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    // Should not throw even though fastKillAgentContainer rejects
    handlers['SIGTERM']();
    await flushPromises();
    expect(processExitSpy).toHaveBeenCalledWith(143);
  });
});
