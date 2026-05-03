/**
 * Shared test helpers for log command tests (stats, summary)
 */

import * as logDiscovery from '../logs/log-discovery';
import * as logAggregator from '../logs/log-aggregator';
import * as statsFormatter from '../logs/stats-formatter';

/**
 * Creates typed mock references and registers shared beforeEach/afterEach
 * hooks for log command tests. Call once at the top of a describe block.
 *
 * Note: jest.mock() calls for log-discovery, log-aggregator, stats-formatter,
 * and logger must remain in each test file — Jest hoists them file-locally.
 *
 * @returns Harness with typed mock references and spy instances (mockExit and
 *          mockConsoleLog are populated before each test runs).
 */
export function createLogCommandTestHarness() {
  const harness = {
    mockedDiscovery: logDiscovery as jest.Mocked<typeof logDiscovery>,
    mockedAggregator: logAggregator as jest.Mocked<typeof logAggregator>,
    mockedFormatter: statsFormatter as jest.Mocked<typeof statsFormatter>,
    // Populated in beforeEach before each test runs; typed as non-null for
    // convenient use in test assertions without optional chaining.
    mockExit: undefined as unknown as jest.SpyInstance,
    mockConsoleLog: undefined as unknown as jest.SpyInstance,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    harness.mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    harness.mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    harness.mockExit.mockRestore();
    harness.mockConsoleLog.mockRestore();
  });

  return harness;
}
