import { registerSignalHandlers } from './signal-handler';
import { flushPromises, createSignalHandlerTestHarness } from './signal-handler.test-utils';

type SignalHandlerDependencies = Parameters<typeof registerSignalHandlers>[0];

describe('registerSignalHandlers', () => {
  const harness = createSignalHandlerTestHarness();

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
  }): Promise<{ fastKill: jest.Mock; performCleanup: jest.Mock; cleanupRouting: jest.Mock }> {
    const fastKill = fastKillRejects
      ? jest.fn().mockRejectedValue(new Error('kill failed'))
      : jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const cleanupRouting = jest.fn();

    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => containersStarted,
      keepContainers,
      fastKillAgentContainer: fastKill,
      performCleanup,
      cleanupRouting,
    };

    registerSignalHandlers(deps);
    harness.handlers[signal]();
    await flushPromises();

    return { fastKill, performCleanup, cleanupRouting };
  }

  it('registers SIGINT and SIGTERM handlers', () => {
    const deps: SignalHandlerDependencies = {
      getContainersStarted: () => false,
      keepContainers: false,
      fastKillAgentContainer: jest.fn().mockResolvedValue(undefined),
      performCleanup: jest.fn().mockResolvedValue(undefined),
      cleanupRouting: jest.fn(),
    };

    registerSignalHandlers(deps);

    expect(harness.processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(harness.processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
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
      expect(harness.processExitSpy).toHaveBeenCalledWith(exitCode);
    }
  );

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'cleans private routing state on %s',
    async signal => {
      const { cleanupRouting } = await runSignalScenario({
        signal,
        containersStarted: true,
        keepContainers: false,
      });

      expect(cleanupRouting).toHaveBeenCalledTimes(1);
    },
  );

  it('exits with the signal status when routing cleanup fails', async () => {
    registerSignalHandlers({
      getContainersStarted: () => false,
      keepContainers: false,
      fastKillAgentContainer: jest.fn().mockResolvedValue(undefined),
      performCleanup: jest.fn().mockResolvedValue(undefined),
      cleanupRouting: jest.fn(() => { throw new Error('cleanup failed'); }),
    });

    harness.handlers.SIGTERM();
    await flushPromises();

    expect(harness.processExitSpy).toHaveBeenCalledWith(143);
  });

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
    expect(harness.processExitSpy).toHaveBeenCalledWith(exitCode);
  });
});
