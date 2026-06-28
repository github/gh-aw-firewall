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

  async function runSignalScenario({
    signal,
    containersStarted,
    keepContainers,
    fastKillRejects = false,
  }: {
    signal: 'SIGINT' | 'SIGTERM';
    containersStarted: boolean;
    keepContainers: boolean;
    fastKillRejects?: boolean;
  }): Promise<{ fastKill: jest.Mock; performCleanup: jest.Mock }> {
    const fastKill = fastKillRejects
      ? jest.fn().mockRejectedValue(new Error('kill failed'))
      : jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => containersStarted,
      keepContainers,
      fastKillAgentContainer: fastKill,
      performCleanup,
    };

    registerSignalHandlers(deps);
    handlers[signal]();
    await flushPromises();

    return { fastKill, performCleanup };
  }

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

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'fast-kills agent container on %s when containers are started and keepContainers is false',
    async (signal, exitCode) => {
      const { fastKill, performCleanup } = await runSignalScenario({
        signal,
        containersStarted: true,
        keepContainers: false,
      });

      expect(fastKill).toHaveBeenCalled();
      expect(performCleanup).toHaveBeenCalledWith(signal);
      expect(processExitSpy).toHaveBeenCalledWith(exitCode);
    }
  );

  it('skips fast-kill on SIGINT when containers are not started', async () => {
    const { fastKill, performCleanup } = await runSignalScenario({
      signal: 'SIGINT',
      containersStarted: false,
      keepContainers: false,
    });

    expect(fastKill).not.toHaveBeenCalled();
    expect(performCleanup).toHaveBeenCalledWith('SIGINT');
  });

  it('skips fast-kill on SIGINT when keepContainers is true', async () => {
    const { fastKill } = await runSignalScenario({
      signal: 'SIGINT',
      containersStarted: true,
      keepContainers: true,
    });

    expect(fastKill).not.toHaveBeenCalled();
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('swallows errors thrown during %s handling', async (signal, exitCode) => {
    await runSignalScenario({
      signal,
      containersStarted: true,
      keepContainers: false,
      fastKillRejects: true,
    });

    // Should not throw even though fastKillAgentContainer rejects
    expect(processExitSpy).toHaveBeenCalledWith(exitCode);
  });
});
