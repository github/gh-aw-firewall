/**
 * Shared test fixtures for signal-handler tests.
 *
 * Provides a `flushPromises` helper plus a `createSignalHandlerTestHarness`
 * factory that captures registered process signal handlers and manages the
 * Jest spy lifecycle (beforeEach / afterEach) automatically.
 *
 * Usage:
 *   import { flushPromises, createSignalHandlerTestHarness } from './signal-handler.test-utils';
 *   const harness = createSignalHandlerTestHarness();
 *
 *   harness.handlers['SIGINT']();
 *   await flushPromises();
 *   expect(harness.processExitSpy).toHaveBeenCalledWith(130);
 */

export const flushPromises = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * Creates a test harness that captures `process.on` signal handlers and
 * sets up / tears down Jest spies for `process.on`, `process.exit`, and
 * `console.error` around every test automatically.
 *
 * The returned `handlers` map is populated when `registerSignalHandlers` is
 * called inside a test — invoke `handlers['SIGINT']()` or
 * `handlers['SIGTERM']()` to trigger the registered callback.
 */
export function createSignalHandlerTestHarness() {
  const harness = {
    /** Captured handlers keyed by signal name; populated by the mocked `process.on`. */
    handlers: {} as Record<string, (...args: unknown[]) => unknown>,
    processOnSpy: undefined as unknown as jest.SpyInstance,
    processExitSpy: undefined as unknown as jest.SpyInstance,
    consoleErrorSpy: undefined as unknown as jest.SpyInstance,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    harness.processOnSpy = jest.spyOn(process, 'on').mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        harness.handlers[String(event)] = handler;
        return process;
      }
    );
    harness.processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    harness.consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    harness.processOnSpy.mockRestore();
    harness.processExitSpy.mockRestore();
    harness.consoleErrorSpy.mockRestore();
    delete harness.handlers['SIGINT'];
    delete harness.handlers['SIGTERM'];
  });

  return harness;
}

export type SignalHandlerTestHarness = ReturnType<typeof createSignalHandlerTestHarness>;
