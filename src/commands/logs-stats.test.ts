/**
 * Tests for logs-stats command
 */

import { statsCommand, StatsCommandOptions } from './logs-stats';
import { LogSource } from '../types';
import { createLogCommandTestHarness } from './test-helpers';

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

describe('logs-stats command', () => {
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

    const options: StatsCommandOptions = {
      format: 'pretty',
    };

    await statsCommand(options);

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

    const options: StatsCommandOptions = {
      format: 'json',
      source: '/custom/path',
    };

    await statsCommand(options);

    expect(harness.mockedDiscovery.validateSource).toHaveBeenCalledWith('/custom/path');
    expect(harness.mockedAggregator.loadAndAggregate).toHaveBeenCalledWith(mockSource);
  });

  it('should exit with error if no sources found', async () => {
    harness.mockedDiscovery.discoverLogSources.mockResolvedValue([]);

    const options: StatsCommandOptions = {
      format: 'pretty',
    };

    await expect(statsCommand(options)).rejects.toThrow('process.exit called');
    expect(harness.mockExit).toHaveBeenCalledWith(1);
  });

  it('should exit with error if specified source is invalid', async () => {
    harness.mockedDiscovery.discoverLogSources.mockResolvedValue([]);
    harness.mockedDiscovery.validateSource.mockRejectedValue(new Error('Source not found'));

    const options: StatsCommandOptions = {
      format: 'pretty',
      source: '/invalid/path',
    };

    await expect(statsCommand(options)).rejects.toThrow('process.exit called');
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

    await statsCommand({ format: 'json' });
    expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
      expect.anything(),
      'json',
      expect.any(Boolean)
    );

    harness.mockedFormatter.formatStats.mockClear();
    await statsCommand({ format: 'markdown' });
    expect(harness.mockedFormatter.formatStats).toHaveBeenCalledWith(
      expect.anything(),
      'markdown',
      expect.any(Boolean)
    );

    harness.mockedFormatter.formatStats.mockClear();
    await statsCommand({ format: 'pretty' });
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

    const options: StatsCommandOptions = {
      format: 'pretty',
    };

    await expect(statsCommand(options)).rejects.toThrow('process.exit called');
    expect(harness.mockExit).toHaveBeenCalledWith(1);
  });
});
