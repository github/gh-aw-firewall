/**
 * Unit tests for logs command handler
 */

import { logsCommand } from './logs';
import * as logDiscovery from '../logs/log-discovery';
import * as logStreamer from '../logs/log-streamer';
import { LogSource } from '../types';
import { logger } from '../logger';

// Mock the log modules
jest.mock('../logs/log-discovery');
jest.mock('../logs/log-streamer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedDiscovery = logDiscovery as jest.Mocked<typeof logDiscovery>;
const mockedStreamer = logStreamer as jest.Mocked<typeof logStreamer>;
const mockedLogger = logger as jest.Mocked<typeof logger>;

describe('logsCommand', () => {
  let consoleLogSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Default mocks
    mockedDiscovery.discoverLogSources.mockResolvedValue([]);
    mockedStreamer.streamLogs.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('--list flag', () => {
    it('should call listLogSources and output result', async () => {
      const listing = 'Available log sources:\n  [running] awf-squid';
      mockedDiscovery.listLogSources.mockResolvedValue(listing);

      await logsCommand({ list: true, format: 'pretty' });

      expect(mockedDiscovery.listLogSources).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(listing);
    });

    it('should not stream logs when --list is specified', async () => {
      mockedDiscovery.listLogSources.mockResolvedValue('test');

      await logsCommand({ list: true, format: 'pretty' });

      expect(mockedStreamer.streamLogs).not.toHaveBeenCalled();
    });
  });

  describe('source selection', () => {
    it('should exit with error when no sources found', async () => {
      mockedDiscovery.discoverLogSources.mockResolvedValue([]);

      await expect(logsCommand({ format: 'pretty' })).rejects.toThrow('process.exit called');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should use specified source when --source is provided', async () => {
      const source: LogSource = { type: 'preserved', path: '/tmp/logs' };
      mockedDiscovery.validateSource.mockResolvedValue(source);

      await logsCommand({ format: 'pretty', source: '/tmp/logs' });

      expect(mockedDiscovery.validateSource).toHaveBeenCalledWith('/tmp/logs');
      expect(mockedStreamer.streamLogs).toHaveBeenCalledWith(
        expect.objectContaining({ source })
      );
    });

    it('should exit with error when specified source is invalid', async () => {
      mockedDiscovery.validateSource.mockRejectedValue(new Error('Invalid source'));

      await expect(
        logsCommand({ format: 'pretty', source: '/invalid' })
      ).rejects.toThrow('process.exit called');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should select most recent source when no --source specified', async () => {
      const sources: LogSource[] = [
        { type: 'running', containerName: 'awf-squid' },
        { type: 'preserved', path: '/tmp/logs', timestamp: 1000 },
      ];
      const selectedSource = sources[0];

      mockedDiscovery.discoverLogSources.mockResolvedValue(sources);
      mockedDiscovery.selectMostRecent.mockReturnValue(selectedSource);

      await logsCommand({ format: 'pretty' });

      expect(mockedDiscovery.selectMostRecent).toHaveBeenCalledWith(sources);
      expect(mockedStreamer.streamLogs).toHaveBeenCalledWith(
        expect.objectContaining({ source: selectedSource })
      );
    });

    it('should exit when selectMostRecent returns null', async () => {
      mockedDiscovery.discoverLogSources.mockResolvedValue([
        { type: 'preserved', path: '/tmp/logs' },
      ]);
      mockedDiscovery.selectMostRecent.mockReturnValue(null);

      await expect(logsCommand({ format: 'pretty' })).rejects.toThrow('process.exit called');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('streaming options', () => {
    beforeEach(() => {
      const source: LogSource = { type: 'running', containerName: 'awf-squid' };
      mockedDiscovery.discoverLogSources.mockResolvedValue([source]);
      mockedDiscovery.selectMostRecent.mockReturnValue(source);
    });

    it('should pass follow option to streamLogs', async () => {
      await logsCommand({ format: 'pretty', follow: true });

      expect(mockedStreamer.streamLogs).toHaveBeenCalledWith(
        expect.objectContaining({ follow: true })
      );
    });

    it('should default follow to false', async () => {
      await logsCommand({ format: 'pretty' });

      expect(mockedStreamer.streamLogs).toHaveBeenCalledWith(
        expect.objectContaining({ follow: false })
      );
    });

    it('should set parse to false for raw format', async () => {
      await logsCommand({ format: 'raw' });

      expect(mockedStreamer.streamLogs).toHaveBeenCalledWith(
        expect.objectContaining({ parse: false })
      );
    });

    it('should set parse to true for pretty format', async () => {
      await logsCommand({ format: 'pretty' });

      expect(mockedStreamer.streamLogs).toHaveBeenCalledWith(
        expect.objectContaining({ parse: true })
      );
    });

    it('should set parse to true for json format', async () => {
      await logsCommand({ format: 'json' });

      expect(mockedStreamer.streamLogs).toHaveBeenCalledWith(
        expect.objectContaining({ parse: true })
      );
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      const source: LogSource = { type: 'running', containerName: 'awf-squid' };
      mockedDiscovery.discoverLogSources.mockResolvedValue([source]);
      mockedDiscovery.selectMostRecent.mockReturnValue(source);
    });

    it('should exit with error when streamLogs fails', async () => {
      mockedStreamer.streamLogs.mockRejectedValue(new Error('Stream error'));

      await expect(logsCommand({ format: 'pretty' })).rejects.toThrow('process.exit called');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle non-Error objects in catch', async () => {
      mockedStreamer.streamLogs.mockRejectedValue('string error');

      await expect(logsCommand({ format: 'pretty' })).rejects.toThrow('process.exit called');
    });

    it('should handle non-Error in validateSource', async () => {
      mockedDiscovery.validateSource.mockRejectedValue('string error');

      await expect(
        logsCommand({ format: 'pretty', source: '/path' })
      ).rejects.toThrow('process.exit called');
    });
  });

  describe('logging source info', () => {
    it('should log info about running container source', async () => {
      const source: LogSource = { type: 'running', containerName: 'awf-squid' };
      mockedDiscovery.discoverLogSources.mockResolvedValue([source]);
      mockedDiscovery.selectMostRecent.mockReturnValue(source);

      await logsCommand({ format: 'pretty' });

      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('awf-squid')
      );
    });

    it('should log info about preserved source with date', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/logs',
        dateStr: '2023-01-01',
      };
      mockedDiscovery.discoverLogSources.mockResolvedValue([source]);
      mockedDiscovery.selectMostRecent.mockReturnValue(source);

      await logsCommand({ format: 'pretty' });

      expect(mockedLogger.info).toHaveBeenCalledWith(expect.stringContaining('/tmp/logs'));
      expect(mockedLogger.info).toHaveBeenCalledWith(expect.stringContaining('2023-01-01'));
    });

    it('should skip date log when dateStr is not present', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/logs',
      };
      mockedDiscovery.discoverLogSources.mockResolvedValue([source]);
      mockedDiscovery.selectMostRecent.mockReturnValue(source);

      await logsCommand({ format: 'pretty' });

      // Should log path but not timestamp
      expect(mockedLogger.info).toHaveBeenCalledWith(expect.stringContaining('/tmp/logs'));
      // Check that we don't call with "Log timestamp" when dateStr is undefined
      const timestampCalls = (mockedLogger.info as jest.Mock).mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes('Log timestamp')
      );
      expect(timestampCalls).toHaveLength(0);
    });
  });
});
