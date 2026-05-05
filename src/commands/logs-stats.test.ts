/**
 * Tests for logs-stats command
 */

import { statsCommand, StatsCommandOptions } from './logs-stats';
import { logger } from '../logger';
import { createLogCommandTests, createLogCommandTestHarness } from './test-helpers.test-utils';

// Mock dependencies
jest.mock('../logs/log-discovery');
jest.mock('../logs/log-aggregator');
jest.mock('../logs/stats-formatter');
jest.mock('../logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

createLogCommandTests<StatsCommandOptions>(
  'stats',
  statsCommand,
  'pretty',
  (overrides?) => ({ format: 'pretty', ...overrides } as StatsCommandOptions),
);

describe('logs-stats command - logging behavior', () => {
  const harness = createLogCommandTestHarness();

  it('should emit source-selection info logs for non-JSON formats but suppress them for JSON', async () => {
    const mockSource = {
      type: 'preserved' as const,
      path: '/tmp/squid-logs-123',
      dateStr: 'Mon Jan 01 2024',
    };
    const emptyStats = {
      totalRequests: 0,
      allowedRequests: 0,
      deniedRequests: 0,
      uniqueDomains: 0,
      byDomain: new Map(),
      timeRange: null,
    };

    harness.mockedDiscovery.discoverLogSources.mockResolvedValue([mockSource]);
    harness.mockedDiscovery.selectMostRecent.mockReturnValue(mockSource);
    harness.mockedAggregator.loadAndAggregate.mockResolvedValue(emptyStats);
    harness.mockedFormatter.formatStats.mockReturnValue('');

    // pretty: shouldLog returns true → logger.info should be called
    await statsCommand({ format: 'pretty' });
    expect((logger.info as jest.Mock)).toHaveBeenCalled();
    (logger.info as jest.Mock).mockClear();

    // markdown: shouldLog returns true → logger.info should be called
    await statsCommand({ format: 'markdown' });
    expect((logger.info as jest.Mock)).toHaveBeenCalled();
    (logger.info as jest.Mock).mockClear();

    // json: shouldLog returns false → logger.info should NOT be called
    await statsCommand({ format: 'json' });
    expect((logger.info as jest.Mock)).not.toHaveBeenCalled();
  });
});
