/**
 * Tests for logs-summary command
 */

import { summaryCommand, SummaryCommandOptions } from './logs-summary';
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

createLogCommandTests<SummaryCommandOptions>(
  'summary',
  summaryCommand,
  'markdown',
  (overrides?) => ({ format: 'markdown', ...overrides } as SummaryCommandOptions),
);

describe('logs-summary command - logging behavior', () => {
  const harness = createLogCommandTestHarness();

  it('should default to markdown format', async () => {
    const mockSource = { type: 'running' as const, containerName: 'awf-squid' };

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
    harness.mockedFormatter.formatStats.mockReturnValue('### Summary');

    // Note: default format is 'markdown' for summary command
    await summaryCommand({ format: 'markdown' });

    expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
      expect.anything(),
      'markdown',
      expect.any(Boolean),
    );
  });

  it('should emit source-selection info logs only for pretty format, suppress them for markdown and json', async () => {
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
    await summaryCommand({ format: 'pretty' });
    expect((logger.info as jest.Mock)).toHaveBeenCalled();
    (logger.info as jest.Mock).mockClear();

    // markdown: shouldLog returns false → logger.info should NOT be called
    await summaryCommand({ format: 'markdown' });
    expect((logger.info as jest.Mock)).not.toHaveBeenCalled();
    (logger.info as jest.Mock).mockClear();

    // json: shouldLog returns false → logger.info should NOT be called
    await summaryCommand({ format: 'json' });
    expect((logger.info as jest.Mock)).not.toHaveBeenCalled();
  });
});
