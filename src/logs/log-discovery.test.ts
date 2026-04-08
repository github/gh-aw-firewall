/**
 * Unit tests for log-discovery.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  discoverLogSources,
  selectMostRecent,
  isContainerRunning,
  validateSource,
  listLogSources,
} from './log-discovery';
import { execa } from 'execa';
import { glob } from 'glob';
import { LogSource } from '../types';

// Mock external dependencies
jest.mock('execa');
jest.mock('glob');
jest.mock('fs');
jest.mock('../logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockedExeca = execa as jest.MockedFunction<typeof execa>;
const mockedGlob = glob as jest.MockedFunction<typeof glob>;
const mockedFs = fs as jest.Mocked<typeof fs>;

describe('log-discovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: container not running
    mockedExeca.mockResolvedValue({ stdout: '', stderr: '' } as never);
    // Default: no preserved logs
    mockedGlob.mockResolvedValue([]);
    // Default: no env var
    delete process.env.AWF_LOGS_DIR;
  });

  describe('isContainerRunning', () => {
    it('should return true when container is running', async () => {
      mockedExeca.mockResolvedValue({ stdout: 'awf-squid', stderr: '' } as never);

      const result = await isContainerRunning('awf-squid');

      expect(result).toBe(true);
      expect(mockedExeca).toHaveBeenCalledWith('docker', [
        'ps',
        '--filter',
        'name=^awf-squid$',
        '--format',
        '{{.Names}}',
      ]);
    });

    it('should return false when container is not running', async () => {
      mockedExeca.mockResolvedValue({ stdout: '', stderr: '' } as never);

      const result = await isContainerRunning('awf-squid');

      expect(result).toBe(false);
    });

    it('should return false when container name does not match exactly', async () => {
      mockedExeca.mockResolvedValue({ stdout: 'awf-squid-old', stderr: '' } as never);

      const result = await isContainerRunning('awf-squid');

      expect(result).toBe(false);
    });

    it('should return false when docker command fails', async () => {
      mockedExeca.mockRejectedValue(new Error('Docker not available'));

      const result = await isContainerRunning('awf-squid');

      expect(result).toBe(false);
    });
  });

  describe('discoverLogSources', () => {
    it('should return empty array when no sources exist', async () => {
      const sources = await discoverLogSources();

      expect(sources).toEqual([]);
    });

    it('should include running container as a source', async () => {
      mockedExeca.mockResolvedValue({ stdout: 'awf-squid', stderr: '' } as never);

      const sources = await discoverLogSources();

      expect(sources).toHaveLength(1);
      expect(sources[0]).toEqual({
        type: 'running',
        containerName: 'awf-squid',
      });
    });

    it('should include preserved logs from /tmp', async () => {
      const timestamp = Date.now();
      const logDir = path.join(os.tmpdir(), `squid-logs-${timestamp}`);

      mockedGlob.mockResolvedValue([logDir]);
      mockedFs.existsSync.mockReturnValue(true);

      const sources = await discoverLogSources();

      expect(sources.some((s) => s.type === 'preserved' && s.path === logDir)).toBe(true);
    });

    it('should skip preserved logs without access.log', async () => {
      const logDir = path.join(os.tmpdir(), 'squid-logs-1234567890');

      mockedGlob.mockResolvedValue([logDir]);
      mockedFs.existsSync.mockReturnValue(false);

      const sources = await discoverLogSources();

      expect(sources).toEqual([]);
    });

    it('should skip directories with invalid timestamps', async () => {
      const logDir = path.join(os.tmpdir(), 'squid-logs-invalid');

      mockedGlob.mockResolvedValue([logDir]);
      mockedFs.existsSync.mockReturnValue(true);

      const sources = await discoverLogSources();

      expect(sources).toEqual([]);
    });

    it('should include logs from AWF_LOGS_DIR env var (nested layout)', async () => {
      const logsDir = '/custom/logs/dir';
      const squidLogsPath = path.join(logsDir, 'squid-logs');
      const accessLogPath = path.join(squidLogsPath, 'access.log');

      process.env.AWF_LOGS_DIR = logsDir;
      // Only nested access.log exists (not direct)
      mockedFs.existsSync.mockImplementation((p) => p === accessLogPath);
      mockedFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

      const sources = await discoverLogSources();

      expect(sources.some((s) => s.path === squidLogsPath)).toBe(true);
    });

    it('should include logs from AWF_LOGS_DIR env var (direct layout from --proxy-logs-dir)', async () => {
      const logsDir = '/custom/proxy-logs';
      const directAccessLogPath = path.join(logsDir, 'access.log');

      process.env.AWF_LOGS_DIR = logsDir;
      // Direct access.log exists in AWF_LOGS_DIR
      mockedFs.existsSync.mockImplementation((p) => p === directAccessLogPath);
      mockedFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

      const sources = await discoverLogSources();

      // Should use logsDir directly (not squid-logs subdir)
      expect(sources.some((s) => s.path === logsDir)).toBe(true);
    });

    it('should put running container first, then preserved logs sorted by timestamp', async () => {
      const oldTimestamp = 1000000000000;
      const newTimestamp = 2000000000000;

      mockedExeca.mockResolvedValue({ stdout: 'awf-squid', stderr: '' } as never);
      mockedGlob.mockResolvedValue([
        path.join(os.tmpdir(), `squid-logs-${oldTimestamp}`),
        path.join(os.tmpdir(), `squid-logs-${newTimestamp}`),
      ]);
      mockedFs.existsSync.mockReturnValue(true);

      const sources = await discoverLogSources();

      expect(sources[0].type).toBe('running');
      expect(sources[1].timestamp).toBe(newTimestamp);
      expect(sources[2].timestamp).toBe(oldTimestamp);
    });

    it('should handle glob errors gracefully', async () => {
      mockedGlob.mockRejectedValue(new Error('Glob error'));

      const sources = await discoverLogSources();

      expect(sources).toEqual([]);
    });
  });

  describe('selectMostRecent', () => {
    it('should prefer running container over preserved logs', () => {
      const sources: LogSource[] = [
        { type: 'preserved', path: '/tmp/squid-logs-old', timestamp: Date.now() },
        { type: 'running', containerName: 'awf-squid' },
      ];

      const result = selectMostRecent(sources);

      expect(result).toEqual({ type: 'running', containerName: 'awf-squid' });
    });

    it('should return most recent preserved log when no running container', () => {
      const sources: LogSource[] = [
        { type: 'preserved', path: '/tmp/squid-logs-1', timestamp: 1000 },
        { type: 'preserved', path: '/tmp/squid-logs-2', timestamp: 2000 },
      ];

      // Note: sources should already be sorted with newest first
      const result = selectMostRecent(sources);

      expect(result).toEqual(sources[0]);
    });

    it('should return null for empty sources', () => {
      const result = selectMostRecent([]);

      expect(result).toBeNull();
    });
  });

  describe('validateSource', () => {
    it('should validate "running" keyword when container is running', async () => {
      mockedExeca.mockResolvedValue({ stdout: 'awf-squid', stderr: '' } as never);

      const result = await validateSource('running');

      expect(result).toEqual({
        type: 'running',
        containerName: 'awf-squid',
      });
    });

    it('should throw error for "running" when container is not running', async () => {
      mockedExeca.mockResolvedValue({ stdout: '', stderr: '' } as never);

      await expect(validateSource('running')).rejects.toThrow(
        'Container awf-squid is not running'
      );
    });

    it('should validate directory path containing access.log', async () => {
      const logDir = '/tmp/squid-logs-1234567890';
      const accessLogPath = path.join(logDir, 'access.log');

      mockedFs.existsSync.mockImplementation((p) => {
        return p === logDir || p === accessLogPath;
      });
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      const result = await validateSource(logDir);

      expect(result).toEqual({
        type: 'preserved',
        path: logDir,
      });
    });

    it('should throw error for directory without access.log', async () => {
      const logDir = '/tmp/squid-logs-empty';

      mockedFs.existsSync.mockImplementation((p) => {
        return p === logDir;
      });
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      await expect(validateSource(logDir)).rejects.toThrow(
        `Directory does not contain access.log: ${logDir}`
      );
    });

    it('should validate file path by returning parent directory', async () => {
      const logFile = '/tmp/squid-logs/access.log';
      const logDir = '/tmp/squid-logs';

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true } as fs.Stats);

      const result = await validateSource(logFile);

      expect(result).toEqual({
        type: 'preserved',
        path: logDir,
      });
    });

    it('should throw error for non-existent path', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      await expect(validateSource('/nonexistent/path')).rejects.toThrow(
        'Log source not found: /nonexistent/path'
      );
    });
  });

  describe('listLogSources', () => {
    it('should return hint message when no sources found', async () => {
      const result = await listLogSources();

      expect(result).toContain('No log sources found');
      expect(result).toContain('AWF_LOGS_DIR');
    });

    it('should list running container', async () => {
      mockedExeca.mockResolvedValue({ stdout: 'awf-squid', stderr: '' } as never);

      const result = await listLogSources();

      expect(result).toContain('[running]');
      expect(result).toContain('awf-squid');
      expect(result).toContain('live container');
    });

    it('should list preserved logs with date', async () => {
      const timestamp = 1700000000000;
      const logDir = path.join(os.tmpdir(), `squid-logs-${timestamp}`);

      mockedGlob.mockResolvedValue([logDir]);
      mockedFs.existsSync.mockReturnValue(true);

      const result = await listLogSources();

      expect(result).toContain('[preserved]');
      expect(result).toContain(logDir);
    });

    it('should label AWF_LOGS_DIR sources correctly', async () => {
      const logsDir = '/custom/logs';
      const squidLogsPath = path.join(logsDir, 'squid-logs');
      const accessLogPath = path.join(squidLogsPath, 'access.log');

      process.env.AWF_LOGS_DIR = logsDir;
      mockedFs.existsSync.mockImplementation((p) => p === accessLogPath);
      mockedFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

      const result = await listLogSources();

      expect(result).toContain('[AWF_LOGS_DIR]');
    });
  });
});
