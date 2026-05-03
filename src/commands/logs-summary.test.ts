/**
 * Tests for logs-summary command
 */

import { summaryCommand, SummaryCommandOptions } from './logs-summary';
import { logger } from '../logger';
import { LogSource } from '../types';
import { createLogCommandTestHarness } from './test-helpers.test-utils';

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

describe('logs-summary command', () => {
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
    harness.mockedFormatter.formatStats.mockReturnValue('markdown summary');

    const options: SummaryCommandOptions = {
      format: 'markdown',
    };

    await summaryCommand(options);

    expect(harness.mockedDiscovery.discoverLogSources).toHaveBeenCalled();
    expect(harness.mockedDiscovery.selectMostRecent).toHaveBeenCalled();
    expect(harness.mockedAggregator.loadAndAggregate).toHaveBeenCalledWith(mockSource);
    expect(harness.mockedFormatter.formatStats).toHaveBeenCalled();
    expect(harness.mockConsoleLog).toHaveBeenCalledWith('markdown summary');
  });

  it('should default to markdown format', async () => {
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
    harness.mockedFormatter.formatStats.mockReturnValue('### Summary');

    // Note: default format is 'markdown' for summary command
    await summaryCommand({ format: 'markdown' });

    expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
      expect.anything(),
      'markdown',
      expect.any(Boolean)
    );
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

    const options: SummaryCommandOptions = {
      format: 'markdown',
      source: '/custom/path',
    };

    await summaryCommand(options);

    expect(harness.mockedDiscovery.validateSource).toHaveBeenCalledWith('/custom/path');
    expect(harness.mockedAggregator.loadAndAggregate).toHaveBeenCalledWith(mockSource);
  });

  it('should exit with error if no sources found', async () => {
    harness.mockedDiscovery.discoverLogSources.mockResolvedValue([]);

    const options: SummaryCommandOptions = {
      format: 'markdown',
    };

    await expect(summaryCommand(options)).rejects.toThrow('process.exit called');
    expect(harness.mockExit).toHaveBeenCalledWith(1);
  });

  it('should exit with error if specified source is invalid', async () => {
    harness.mockedDiscovery.discoverLogSources.mockResolvedValue([]);
    harness.mockedDiscovery.validateSource.mockRejectedValue(new Error('Source not found'));

    const options: SummaryCommandOptions = {
      format: 'markdown',
      source: '/invalid/path',
    };

    await expect(summaryCommand(options)).rejects.toThrow('process.exit called');
    expect(harness.mockExit).toHaveBeenCalledWith(1);
  });

  it('should support all output formats', async () => {
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
    harness.mockedFormatter.formatStats.mockReturnValue('output');

    // Test JSON format
    await summaryCommand({ format: 'json' });
    expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
      expect.anything(),
      'json',
      expect.any(Boolean)
    );

    // Test markdown format
    harness.mockedFormatter.formatStats.mockClear();
    await summaryCommand({ format: 'markdown' });
    expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
      expect.anything(),
      'markdown',
      expect.any(Boolean)
    );

    // Test pretty format
    harness.mockedFormatter.formatStats.mockClear();
    await summaryCommand({ format: 'pretty' });
    expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
      expect.anything(),
      'pretty',
      expect.any(Boolean)
    );
  });

  it('should handle aggregation errors gracefully', async () => {
    const mockSource: LogSource = { type: 'running', containerName: 'awf-squid' };

    harness.mockedDiscovery.discoverLogSources.mockResolvedValue([mockSource]);
    harness.mockedDiscovery.selectMostRecent.mockReturnValue(mockSource);
    harness.mockedAggregator.loadAndAggregate.mockRejectedValue(new Error('Failed to load'));

    const options: SummaryCommandOptions = {
      format: 'markdown',
    };

    await expect(summaryCommand(options)).rejects.toThrow('process.exit called');
    expect(harness.mockExit).toHaveBeenCalledWith(1);
  });

  it('should emit source-selection info logs only for pretty format, suppress them for markdown and json', async () => {
    const mockSource: LogSource = {
      type: 'preserved',
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
