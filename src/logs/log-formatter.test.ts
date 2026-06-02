/**
 * Unit tests for log-formatter.ts
 */

import { LogFormatter } from './log-formatter';
import { ParsedLogEntry } from '../types';
import { createLogEntry } from './log-test-fixtures.test-utils';

// Mock chalk to avoid terminal output issues in tests
jest.mock('chalk', () => ({
  green: jest.fn((text) => `<green>${text}</green>`),
  red: jest.fn((text) => `<red>${text}</red>`),
}));

describe('LogFormatter', () => {
  // Sample parsed log entries for testing
  const allowedEntry: ParsedLogEntry = createLogEntry();

  const deniedEntry: ParsedLogEntry = createLogEntry({
    timestamp: 1760994429.358,
    clientPort: '36274',
    host: 'github.com:8443',
    destIp: '-',
    destPort: '-',
    statusCode: 403,
    decision: 'TCP_DENIED:HIER_NONE',
    url: 'github.com:8443',
    userAgent: 'curl/7.81.0',
    domain: 'github.com',
    isAllowed: false,
  });

  describe('formatEntry - pretty format', () => {
    it('should format allowed entry without color', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(allowedEntry);

      expect(result).toContain('CONNECT');
      expect(result).toContain('api.github.com');
      expect(result).toContain('200');
      expect(result).toContain('ALLOWED');
      expect(result.endsWith('\n')).toBe(true);
    });

    it('should format denied entry without color', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(deniedEntry);

      expect(result).toContain('CONNECT');
      expect(result).toContain('github.com:8443');
      expect(result).toContain('403');
      expect(result).toContain('DENIED');
      expect(result).toContain('curl/7.81.0');
      expect(result.endsWith('\n')).toBe(true);
    });

    it('should colorize allowed entries in green when colorize is true', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: true });
      const result = formatter.formatEntry(allowedEntry);

      expect(result).toContain('<green>');
    });

    it('should colorize denied entries in red when colorize is true', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: true });
      const result = formatter.formatEntry(deniedEntry);

      expect(result).toContain('<red>');
    });

    it('should hide standard HTTPS port (443) in output', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(allowedEntry);

      // Should show domain without :443
      expect(result).toContain('api.github.com');
      expect(result).not.toContain('api.github.com:443');
    });

    it('should show non-standard ports in output', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(deniedEntry);

      // Should show domain with :8443
      expect(result).toContain('github.com:8443');
    });

    it('should not show user agent if it is dash', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(allowedEntry);

      expect(result).not.toContain('[-]');
    });

    it('should show user agent if present', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(deniedEntry);

      expect(result).toContain('[curl/7.81.0]');
    });
  });

  describe('formatEntry - json format', () => {
    it('should format entry as valid JSON', () => {
      const formatter = new LogFormatter({ format: 'json' });
      const result = formatter.formatEntry(allowedEntry);

      const parsed = JSON.parse(result);
      expect(parsed.timestamp).toBe(1761074374.646);
      expect(parsed.domain).toBe('api.github.com');
      expect(parsed.isAllowed).toBe(true);
    });

    it('should end with newline for line-delimited output', () => {
      const formatter = new LogFormatter({ format: 'json' });
      const result = formatter.formatEntry(allowedEntry);

      expect(result.endsWith('\n')).toBe(true);
    });

    it('should include all fields in JSON output', () => {
      const formatter = new LogFormatter({ format: 'json' });
      const result = formatter.formatEntry(allowedEntry);

      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('clientIp');
      expect(parsed).toHaveProperty('clientPort');
      expect(parsed).toHaveProperty('host');
      expect(parsed).toHaveProperty('destIp');
      expect(parsed).toHaveProperty('destPort');
      expect(parsed).toHaveProperty('protocol');
      expect(parsed).toHaveProperty('method');
      expect(parsed).toHaveProperty('statusCode');
      expect(parsed).toHaveProperty('decision');
      expect(parsed).toHaveProperty('url');
      expect(parsed).toHaveProperty('userAgent');
      expect(parsed).toHaveProperty('domain');
      expect(parsed).toHaveProperty('isAllowed');
      expect(parsed).toHaveProperty('isHttps');
    });
  });

  describe('formatEntry - raw format', () => {
    it('should throw error for raw format', () => {
      const formatter = new LogFormatter({ format: 'raw' });

      expect(() => formatter.formatEntry(allowedEntry)).toThrow(
        'Cannot format parsed entry as raw - use formatRaw for raw lines'
      );
    });
  });

  describe('formatRaw', () => {
    it('should pass through raw line with newline', () => {
      const formatter = new LogFormatter({ format: 'raw' });
      const result = formatter.formatRaw('raw log line');

      expect(result).toBe('raw log line\n');
    });

    it('should not add double newline if already present', () => {
      const formatter = new LogFormatter({ format: 'raw' });
      const result = formatter.formatRaw('raw log line\n');

      expect(result).toBe('raw log line\n');
    });
  });

  describe('formatBatch', () => {
    it('should format multiple entries in json format', () => {
      const formatter = new LogFormatter({ format: 'json' });
      const result = formatter.formatBatch([allowedEntry, deniedEntry]);

      const lines = result.trim().split('\n');
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]);
      const second = JSON.parse(lines[1]);

      expect(first.isAllowed).toBe(true);
      expect(second.isAllowed).toBe(false);
    });

    it('should format multiple entries in pretty format', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatBatch([allowedEntry, deniedEntry]);

      expect(result).toContain('ALLOWED');
      expect(result).toContain('DENIED');
    });
  });

  describe('constructor defaults', () => {
    it('should default colorize based on stdout TTY', () => {
      // When process.stdout.isTTY is undefined, colorize should default to false
      const originalIsTTY = process.stdout.isTTY;

      // Test with undefined - create formatter and verify behavior
      Object.defineProperty(process.stdout, 'isTTY', {
        value: undefined,
        configurable: true,
      });
      const formatter = new LogFormatter({ format: 'pretty' });
      
      // Test that output is not colorized (no green/red tags)
      const result = formatter.formatEntry(allowedEntry);
      expect(result).not.toContain('<green>');
      expect(result).not.toContain('<red>');

      // Restore
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    });
  });

  describe('getDisplayPort (via formatPretty)', () => {
    it('should hide standard HTTP port 80', () => {
      const entry: ParsedLogEntry = {
        ...allowedEntry,
        method: 'GET',
        destPort: '80',
        url: 'http://example.com/',
      };
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(entry);

      expect(result).not.toContain(':80');
    });

    it('should show non-standard port from destPort', () => {
      const entry: ParsedLogEntry = {
        ...allowedEntry,
        method: 'GET',
        destPort: '8080',
        url: 'http://example.com:8080/',
      };
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(entry);

      // We should see port from domain display
      expect(result).toContain('8080');
    });
  });

  describe('PID enrichment', () => {
    it('should display PID info in pretty format when available', () => {
      const enhancedEntry = {
        ...allowedEntry,
        pid: 12345,
        cmdline: 'curl https://api.github.com',
        comm: 'curl',
        inode: '123456',
      };
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(enhancedEntry);

      expect(result).toContain('<PID:12345 curl>');
    });

    it('should not display PID info when pid is -1', () => {
      const enhancedEntry = {
        ...allowedEntry,
        pid: -1,
        cmdline: 'unknown',
        comm: 'unknown',
      };
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(enhancedEntry);

      expect(result).not.toContain('<PID:');
    });

    it('should not display PID info when pid is undefined', () => {
      const formatter = new LogFormatter({ format: 'pretty', colorize: false });
      const result = formatter.formatEntry(allowedEntry);

      expect(result).not.toContain('<PID:');
    });

    it('should include PID fields in JSON output when available', () => {
      const enhancedEntry = {
        ...allowedEntry,
        pid: 12345,
        cmdline: 'curl https://api.github.com',
        comm: 'curl',
        inode: '123456',
      };
      const formatter = new LogFormatter({ format: 'json' });
      const result = formatter.formatEntry(enhancedEntry);

      const parsed = JSON.parse(result);
      expect(parsed.pid).toBe(12345);
      expect(parsed.cmdline).toBe('curl https://api.github.com');
      expect(parsed.comm).toBe('curl');
      expect(parsed.inode).toBe('123456');
    });
  });
});
