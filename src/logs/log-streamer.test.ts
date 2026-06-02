/**
 * Unit tests for log-streamer.ts
 */

import * as fs from 'fs';
import { streamLogs } from './log-streamer';
import { LogFormatter } from './log-formatter';
import { LogSource } from '../types';
import { createRawLogLine } from './log-test-fixtures.test-utils';
import execa from 'execa';
import { Readable } from 'stream';
import { trackPidForPortSync, isPidTrackingAvailable } from '../pid-tracker';

// Mock external dependencies
jest.mock('execa');
jest.mock('fs');
jest.mock('../pid-tracker', () => ({
  trackPidForPortSync: jest.fn().mockReturnValue({ pid: -1, cmdline: '', comm: '', inode: 0 }),
  isPidTrackingAvailable: jest.fn().mockReturnValue(true),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedExeca = execa as jest.MockedFunction<typeof execa>;
const mockedFs = fs as jest.Mocked<typeof fs>;

function makeMockExecaProcess(): { stdout: Readable; kill: jest.Mock } {
  const stdout = new Readable({
    read() {
      this.push(null);
    },
  });
  return { stdout, kill: jest.fn() };
}

describe('log-streamer', () => {
  let stdoutWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation();
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  describe('streamLogs - from container', () => {
    it('should stream logs from running container using docker exec cat', async () => {
      const source: LogSource = {
        type: 'running',
        containerName: 'awf-squid',
      };
      const formatter = new LogFormatter({ format: 'raw' });

      // Create a mock readable stream
      const mockStdout = new Readable({
        read() {
          this.push('log line 1\n');
          this.push('log line 2\n');
          this.push(null);
        },
      });

      const mockProcess = {
        stdout: mockStdout,
        kill: jest.fn(),
      };

      mockedExeca.mockReturnValue(mockProcess as never);

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: false,
      });

      expect(mockedExeca).toHaveBeenCalledWith(
        'docker',
        ['exec', 'awf-squid', 'cat', '/var/log/squid/access.log'],
        { reject: false }
      );

      // Verify output was written
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('should use tail -f for following logs from container', async () => {
      const source: LogSource = {
        type: 'running',
        containerName: 'awf-squid',
      };
      const formatter = new LogFormatter({ format: 'raw' });

      const mockProcess = makeMockExecaProcess();
      mockedExeca.mockReturnValue(mockProcess as never);

      await streamLogs({
        follow: true,
        source,
        formatter,
        parse: false,
      });

      expect(mockedExeca).toHaveBeenCalledWith(
        'docker',
        ['exec', 'awf-squid', 'tail', '-f', '/var/log/squid/access.log'],
        { reject: false }
      );
    });

    it('should handle SIGTERM gracefully', async () => {
      const source: LogSource = {
        type: 'running',
        containerName: 'awf-squid',
      };
      const formatter = new LogFormatter({ format: 'raw' });

      const mockProcess = makeMockExecaProcess();
      mockedExeca.mockReturnValue(mockProcess as never);

      // Simulate SIGTERM by resolving with signal
      const sigtermError = new Error('SIGTERM');
      (sigtermError as unknown as { signal: string }).signal = 'SIGTERM';

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: false,
      });

      // Should complete without throwing
    });
  });

  describe('streamLogs - from file', () => {
    it('should read entire file when not following', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs-1234567890',
      };
      const formatter = new LogFormatter({ format: 'raw' });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('log line 1\nlog line 2\n');

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: false,
      });

      expect(mockedFs.readFileSync).toHaveBeenCalledWith(
        '/tmp/squid-logs-1234567890/access.log',
        'utf-8'
      );
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('should throw error if log file not found', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/nonexistent/path',
      };
      const formatter = new LogFormatter({ format: 'raw' });

      mockedFs.existsSync.mockReturnValue(false);

      await expect(
        streamLogs({
          follow: false,
          source,
          formatter,
          parse: false,
        })
      ).rejects.toThrow('Log file not found');
    });

    it('should skip empty lines when reading file', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs',
      };
      const formatter = new LogFormatter({ format: 'raw' });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('log line 1\n\n\nlog line 2\n');

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: false,
      });

      // Should only write non-empty lines
      expect(stdoutWriteSpy).toHaveBeenCalledTimes(2);
    });

    it('should use tail -f for following logs from file', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs',
      };
      const formatter = new LogFormatter({ format: 'raw' });

      mockedFs.existsSync.mockReturnValue(true);

      const mockProcess = makeMockExecaProcess();
      mockedExeca.mockReturnValue(mockProcess as never);

      await streamLogs({
        follow: true,
        source,
        formatter,
        parse: false,
      });

      expect(mockedExeca).toHaveBeenCalledWith(
        'tail',
        ['-f', '/tmp/squid-logs/access.log'],
        { reject: false }
      );
    });
  });

  describe('streamLogs - parsing', () => {
    it('should parse and format log lines when parse is true', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs',
      };
      const formatter = new LogFormatter({ format: 'json' });

      const logLine = createRawLogLine();

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(logLine);

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: true,
      });

      // Should output JSON format
      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls[0][0];
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should fallback to raw format for unparseable lines', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs',
      };
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not a valid log line');

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: true,
      });

      // Should still output the line (as raw)
      expect(stdoutWriteSpy).toHaveBeenCalled();
      expect(stdoutWriteSpy.mock.calls[0][0]).toContain('not a valid log line');
    });

    it('should use raw formatting when parse is false', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs',
      };
      const formatter = new LogFormatter({ format: 'raw' });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('raw log line');

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: false,
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith('raw log line\n');
    });
  });

  describe('streamLogs - withPid enrichment', () => {
    it('should enrich parsed entries with PID info when withPid is true', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs',
      };
      const formatter = new LogFormatter({ format: 'json' });

      const logLine = createRawLogLine();

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(logLine);

      (trackPidForPortSync as jest.Mock).mockReturnValue({
        pid: 1234,
        cmdline: 'curl https://api.github.com',
        comm: 'curl',
        inode: 56789,
      });

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: true,
        withPid: true,
      });

      expect(trackPidForPortSync).toHaveBeenCalledWith(39748);
      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
      expect(output.pid).toBe(1234);
      expect(output.comm).toBe('curl');
    });

    it('should not enrich when PID lookup returns -1', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs',
      };
      const formatter = new LogFormatter({ format: 'json' });

      const logLine = createRawLogLine();

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(logLine);

      (trackPidForPortSync as jest.Mock).mockReturnValue({
        pid: -1,
        cmdline: '',
        comm: '',
        inode: 0,
      });

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: true,
        withPid: true,
      });

      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = JSON.parse(stdoutWriteSpy.mock.calls[0][0]);
      expect(output.pid).toBeUndefined();
    });

    it('should warn when PID tracking is not available', async () => {
      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs',
      };
      const formatter = new LogFormatter({ format: 'raw' });

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('raw line');

      (isPidTrackingAvailable as jest.Mock).mockReturnValue(false);

      await streamLogs({
        follow: false,
        source,
        formatter,
        parse: false,
        withPid: true,
      });

      const { logger } = jest.requireMock('../logger') as { logger: { warn: jest.Mock } };
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('PID tracking not available')
      );
    });
  });
});
