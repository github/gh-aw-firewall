import { registerSignalHandlers, SignalHandlerDependencies } from './signal-handler';

describe('registerSignalHandlers', () => {
  let processOnSpy: jest.SpyInstance;
  const handlers: Record<string, (...args: unknown[]) => void> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    // Capture registered handlers instead of actually registering them
    processOnSpy = jest.spyOn(process, 'on').mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        handlers[String(event)] = handler;
        return process;
      }
    );
  });

  afterEach(() => {
    processOnSpy.mockRestore();
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
    const processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => true,
      keepContainers: false,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    await expect(handlers['SIGINT']()).rejects.toThrow('exit');
    expect(fastKill).toHaveBeenCalled();
    expect(performCleanup).toHaveBeenCalledWith('SIGINT');
    expect(processExitSpy).toHaveBeenCalledWith(130);

    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('skips fast-kill on SIGINT when containers are not started', async () => {
    const fastKill = jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => false,
      keepContainers: false,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    await expect(handlers['SIGINT']()).rejects.toThrow('exit');
    expect(fastKill).not.toHaveBeenCalled();
    expect(performCleanup).toHaveBeenCalledWith('SIGINT');

    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('skips fast-kill on SIGINT when keepContainers is true', async () => {
    const fastKill = jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => true,
      keepContainers: true,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    await expect(handlers['SIGINT']()).rejects.toThrow('exit');
    expect(fastKill).not.toHaveBeenCalled();

    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('fast-kills agent container on SIGTERM when containers are started and keepContainers is false', async () => {
    const fastKill = jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => true,
      keepContainers: false,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);

    await expect(handlers['SIGTERM']()).rejects.toThrow('exit');
    expect(fastKill).toHaveBeenCalled();
    expect(performCleanup).toHaveBeenCalledWith('SIGTERM');
    expect(processExitSpy).toHaveBeenCalledWith(143);

    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
