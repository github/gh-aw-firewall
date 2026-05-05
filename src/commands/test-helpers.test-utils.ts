/**
 * Shared test helpers for log command tests (stats, summary)
 */

import * as logDiscovery from '../logs/log-discovery';
import * as logAggregator from '../logs/log-aggregator';
import * as statsFormatter from '../logs/stats-formatter';
import { LogSource } from '../types';

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

/**
 * Generates a shared suite of parameterised tests that are common to every log
 * sub-command (stats, summary). Call at the top level of a test file (outside
 * any `describe`) — Jest will register the tests under their own describe block.
 *
 * Note: jest.mock() calls for log-discovery, log-aggregator, stats-formatter,
 * and logger must remain in each calling test file — Jest hoists them file-locally.
 *
 * @param commandName  - Short name used in the describe label ("stats" / "summary")
 * @param runCommand   - The command handler under test
 * @param defaultFormat - The command's default output format string
 * @param makeOptions  - Factory that merges overrides onto the command's default options
 */
export function createLogCommandTests<TOptions extends { format: string; source?: string }>(
  commandName: string,
  runCommand: (opts: TOptions) => Promise<void>,
  defaultFormat: string,
  makeOptions: (overrides?: Partial<TOptions>) => TOptions,
): void {
  describe(`logs-${commandName} command`, () => {
    const harness = createLogCommandTestHarness();

    it('should discover and use most recent log source', async () => {
      const mockSource: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs-123',
        timestamp: Date.now(),
        dateStr: new Date().toLocaleString(),
      };

      harness.mockedDiscovery.discoverLogSources.mockResolvedValue([mockSource]);
      harness.mockedDiscovery.selectMostRecent.mockReturnValue(mockSource);
      harness.mockedAggregator.loadAndAggregate.mockResolvedValue({
        totalRequests: 10,
        allowedRequests: 8,
        deniedRequests: 2,
        uniqueDomains: 3,
        byDomain: new Map(),
        timeRange: { start: 1000, end: 2000 },
      });
      harness.mockedFormatter.formatStats.mockReturnValue('formatted output');

      await runCommand(makeOptions({ format: defaultFormat } as Partial<TOptions>));

      expect(harness.mockedDiscovery.discoverLogSources).toHaveBeenCalled();
      expect(harness.mockedDiscovery.selectMostRecent).toHaveBeenCalled();
      expect(harness.mockedAggregator.loadAndAggregate).toHaveBeenCalledWith(mockSource);
      expect(harness.mockedFormatter.formatStats).toHaveBeenCalled();
      expect(harness.mockConsoleLog).toHaveBeenCalledWith('formatted output');
    });

    it('should use specified source when provided', async () => {
      const mockSource: LogSource = {
        type: 'preserved',
        path: '/custom/path',
      };

      harness.mockedDiscovery.discoverLogSources.mockResolvedValue([]);
      harness.mockedDiscovery.validateSource.mockResolvedValue(mockSource);
      harness.mockedAggregator.loadAndAggregate.mockResolvedValue({
        totalRequests: 5,
        allowedRequests: 5,
        deniedRequests: 0,
        uniqueDomains: 2,
        byDomain: new Map(),
        timeRange: null,
      });
      harness.mockedFormatter.formatStats.mockReturnValue('formatted');

      await runCommand(
        makeOptions({ format: defaultFormat, source: '/custom/path' } as Partial<TOptions>),
      );

      expect(harness.mockedDiscovery.validateSource).toHaveBeenCalledWith('/custom/path');
      expect(harness.mockedAggregator.loadAndAggregate).toHaveBeenCalledWith(mockSource);
    });

    it('should exit with error if no sources found', async () => {
      harness.mockedDiscovery.discoverLogSources.mockResolvedValue([]);

      await expect(
        runCommand(makeOptions({ format: defaultFormat } as Partial<TOptions>)),
      ).rejects.toThrow('process.exit called');
      expect(harness.mockExit).toHaveBeenCalledWith(1);
    });

    it('should exit with error if specified source is invalid', async () => {
      harness.mockedDiscovery.discoverLogSources.mockResolvedValue([]);
      harness.mockedDiscovery.validateSource.mockRejectedValue(new Error('Source not found'));

      await expect(
        runCommand(
          makeOptions({ format: defaultFormat, source: '/invalid/path' } as Partial<TOptions>),
        ),
      ).rejects.toThrow('process.exit called');
      expect(harness.mockExit).toHaveBeenCalledWith(1);
    });

    it('should handle aggregation errors gracefully', async () => {
      const mockSource: LogSource = { type: 'running', containerName: 'awf-squid' };

      harness.mockedDiscovery.discoverLogSources.mockResolvedValue([mockSource]);
      harness.mockedDiscovery.selectMostRecent.mockReturnValue(mockSource);
      harness.mockedAggregator.loadAndAggregate.mockRejectedValue(new Error('Failed to load'));

      await expect(
        runCommand(makeOptions({ format: defaultFormat } as Partial<TOptions>)),
      ).rejects.toThrow('process.exit called');
      expect(harness.mockExit).toHaveBeenCalledWith(1);
    });

    it('should pass correct format to formatter', async () => {
      const mockSource: LogSource = { type: 'running', containerName: 'awf-squid' };

      harness.mockedDiscovery.discoverLogSources.mockResolvedValue([mockSource]);
      harness.mockedDiscovery.selectMostRecent.mockReturnValue(mockSource);
      harness.mockedAggregator.loadAndAggregate.mockResolvedValue({
        totalRequests: 0,
        allowedRequests: 0,
        deniedRequests: 0,
        uniqueDomains: 0,
        byDomain: new Map(),
        timeRange: null,
      });
      harness.mockedFormatter.formatStats.mockReturnValue('{}');

      await runCommand(makeOptions({ format: 'json' } as Partial<TOptions>));
      expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
        expect.anything(),
        'json',
        expect.any(Boolean),
      );

      harness.mockedFormatter.formatStats.mockClear();
      await runCommand(makeOptions({ format: 'markdown' } as Partial<TOptions>));
      expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
        expect.anything(),
        'markdown',
        expect.any(Boolean),
      );

      harness.mockedFormatter.formatStats.mockClear();
      await runCommand(makeOptions({ format: 'pretty' } as Partial<TOptions>));
      expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
        expect.anything(),
        'pretty',
        expect.any(Boolean),
      );
    });
  });
}
