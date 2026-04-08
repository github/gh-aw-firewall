/**
 * Tests for log-aggregator module
 */

import { aggregateLogs, loadAllLogs, loadAndAggregate } from './log-aggregator';
import { ParsedLogEntry, LogSource } from '../types';
import { execa } from 'execa';
import * as fs from 'fs';

// Mock dependencies
jest.mock('execa');
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
const mockedFs = fs as jest.Mocked<typeof fs>;

describe('log-aggregator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('aggregateLogs', () => {
    it('should return empty stats for empty array', () => {
      const stats = aggregateLogs([]);

      expect(stats.totalRequests).toBe(0);
      expect(stats.allowedRequests).toBe(0);
      expect(stats.deniedRequests).toBe(0);
      expect(stats.uniqueDomains).toBe(0);
      expect(stats.byDomain.size).toBe(0);
      expect(stats.timeRange).toBeNull();
    });

    it('should count allowed and denied requests correctly', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ domain: 'github.com', isAllowed: true }),
        createLogEntry({ domain: 'github.com', isAllowed: true }),
        createLogEntry({ domain: 'evil.com', isAllowed: false }),
      ];

      const stats = aggregateLogs(entries);

      expect(stats.totalRequests).toBe(3);
      expect(stats.allowedRequests).toBe(2);
      expect(stats.deniedRequests).toBe(1);
    });

    it('should group by domain correctly', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ domain: 'github.com', isAllowed: true }),
        createLogEntry({ domain: 'github.com', isAllowed: true }),
        createLogEntry({ domain: 'github.com', isAllowed: false }),
        createLogEntry({ domain: 'npmjs.org', isAllowed: true }),
      ];

      const stats = aggregateLogs(entries);

      expect(stats.uniqueDomains).toBe(2);
      expect(stats.byDomain.get('github.com')).toEqual({
        domain: 'github.com',
        allowed: 2,
        denied: 1,
        total: 3,
      });
      expect(stats.byDomain.get('npmjs.org')).toEqual({
        domain: 'npmjs.org',
        allowed: 1,
        denied: 0,
        total: 1,
      });
    });

    it('should calculate time range correctly', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ timestamp: 1000.5 }),
        createLogEntry({ timestamp: 2000.5 }),
        createLogEntry({ timestamp: 1500.5 }),
      ];

      const stats = aggregateLogs(entries);

      expect(stats.timeRange).toEqual({
        start: 1000.5,
        end: 2000.5,
      });
    });

    it('should handle entries with missing domain', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ domain: '-', isAllowed: true }),
        createLogEntry({ domain: 'github.com', isAllowed: true }),
      ];

      const stats = aggregateLogs(entries);

      expect(stats.uniqueDomains).toBe(2);
      expect(stats.byDomain.has('-')).toBe(true);
      expect(stats.byDomain.has('github.com')).toBe(true);
    });

    it('should filter out transaction-end-before-headers entries', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ 
          domain: 'github.com', 
          url: 'github.com:443',
          isAllowed: true 
        }),
        createLogEntry({ 
          domain: '-', 
          url: 'error:transaction-end-before-headers',
          decision: 'NONE_NONE:HIER_NONE',
          statusCode: 0,
          isAllowed: false 
        }),
        createLogEntry({ 
          domain: 'npmjs.org', 
          url: 'npmjs.org:443',
          isAllowed: true 
        }),
      ];

      const stats = aggregateLogs(entries);

      // Should only count the two valid entries
      expect(stats.totalRequests).toBe(2); // Only actual requests, not benign operational entries
      expect(stats.allowedRequests).toBe(2);
      expect(stats.deniedRequests).toBe(0);
      expect(stats.uniqueDomains).toBe(2);
      expect(stats.byDomain.has('github.com')).toBe(true);
      expect(stats.byDomain.has('npmjs.org')).toBe(true);
      expect(stats.byDomain.has('-')).toBe(false); // Filtered entry not in domain stats
    });

    it('should handle multiple transaction-end-before-headers entries', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ 
          domain: 'github.com', 
          url: 'github.com:443',
          isAllowed: true 
        }),
        createLogEntry({ 
          domain: '-', 
          url: 'error:transaction-end-before-headers',
          clientIp: '::1', // healthcheck from localhost
          decision: 'NONE_NONE:HIER_NONE',
          statusCode: 0,
          isAllowed: false 
        }),
        createLogEntry({ 
          domain: '-', 
          url: 'error:transaction-end-before-headers',
          clientIp: '172.30.0.20', // shutdown-time connection closure
          decision: 'NONE_NONE:HIER_NONE',
          statusCode: 0,
          isAllowed: false 
        }),
        createLogEntry({ 
          domain: 'npmjs.org', 
          url: 'npmjs.org:443',
          isAllowed: true 
        }),
      ];

      const stats = aggregateLogs(entries);

      expect(stats.totalRequests).toBe(2); // Only actual requests
      expect(stats.allowedRequests).toBe(2);
      expect(stats.deniedRequests).toBe(0);
      expect(stats.uniqueDomains).toBe(2);
    });

    it('should still count time range from all entries including filtered ones', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ 
          timestamp: 1000.0,
          domain: 'github.com', 
          url: 'github.com:443',
          isAllowed: true 
        }),
        createLogEntry({ 
          timestamp: 1500.0,
          domain: '-', 
          url: 'error:transaction-end-before-headers',
          decision: 'NONE_NONE:HIER_NONE',
          statusCode: 0,
          isAllowed: false 
        }),
        createLogEntry({ 
          timestamp: 2000.0,
          domain: 'npmjs.org', 
          url: 'npmjs.org:443',
          isAllowed: true 
        }),
      ];

      const stats = aggregateLogs(entries);

      // Time range should span all entries, even filtered ones
      expect(stats.timeRange).toEqual({
        start: 1000.0,
        end: 2000.0,
      });
    });
  });

  describe('loadAllLogs', () => {
    it('should load logs from a running container', async () => {
      const mockLogContent = [
        '1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"',
        '1761074375.123 172.30.0.20:39749 evil.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE evil.com:443 "curl/7.81.0"',
      ].join('\n');

      mockedExeca.mockResolvedValue({
        stdout: mockLogContent,
        stderr: '',
        exitCode: 0,
      } as never);

      const source: LogSource = {
        type: 'running',
        containerName: 'awf-squid',
      };

      const entries = await loadAllLogs(source);

      expect(entries).toHaveLength(2);
      expect(entries[0].domain).toBe('api.github.com');
      expect(entries[0].isAllowed).toBe(true);
      expect(entries[1].domain).toBe('evil.com');
      expect(entries[1].isAllowed).toBe(false);
    });

    it('should load logs from a file', async () => {
      const mockLogContent = [
        '1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"',
      ].join('\n');

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(mockLogContent);

      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs-123',
      };

      const entries = await loadAllLogs(source);

      expect(entries).toHaveLength(1);
      expect(entries[0].domain).toBe('api.github.com');
      expect(mockedFs.readFileSync).toHaveBeenCalledWith(
        '/tmp/squid-logs-123/access.log',
        'utf-8'
      );
    });

    it('should return empty array if file does not exist', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs-missing',
      };

      const entries = await loadAllLogs(source);

      expect(entries).toHaveLength(0);
    });

    it('should return empty array if container command fails', async () => {
      mockedExeca.mockRejectedValue(new Error('Container not found'));

      const source: LogSource = {
        type: 'running',
        containerName: 'awf-squid',
      };

      const entries = await loadAllLogs(source);

      expect(entries).toHaveLength(0);
    });

    it('should skip unparseable lines', async () => {
      const mockLogContent = [
        '1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"',
        'invalid line that cannot be parsed',
        '',
        '1761074375.123 172.30.0.20:39749 npmjs.org:443 104.16.0.0:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT npmjs.org:443 "-"',
      ].join('\n');

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(mockLogContent);

      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs-123',
      };

      const entries = await loadAllLogs(source);

      expect(entries).toHaveLength(2);
      expect(entries[0].domain).toBe('api.github.com');
      expect(entries[1].domain).toBe('npmjs.org');
    });
  });

  describe('blocked domain aggregation', () => {
    it('should correctly aggregate multiple blocked domains', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ domain: 'evil.com', isAllowed: false, decision: 'TCP_DENIED:HIER_NONE', statusCode: 403 }),
        createLogEntry({ domain: 'malware.io', isAllowed: false, decision: 'TCP_DENIED:HIER_NONE', statusCode: 403 }),
        createLogEntry({ domain: 'evil.com', isAllowed: false, decision: 'TCP_DENIED:HIER_NONE', statusCode: 403 }),
      ];

      const stats = aggregateLogs(entries);

      expect(stats.totalRequests).toBe(3);
      expect(stats.allowedRequests).toBe(0);
      expect(stats.deniedRequests).toBe(3);
      expect(stats.uniqueDomains).toBe(2);
      expect(stats.byDomain.get('evil.com')).toEqual({
        domain: 'evil.com',
        allowed: 0,
        denied: 2,
        total: 2,
      });
      expect(stats.byDomain.get('malware.io')).toEqual({
        domain: 'malware.io',
        allowed: 0,
        denied: 1,
        total: 1,
      });
    });

    it('should correctly aggregate mixed allowed and denied for same domain', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ domain: 'github.com', isAllowed: true }),
        createLogEntry({ domain: 'github.com', isAllowed: false, decision: 'TCP_DENIED:HIER_NONE', statusCode: 403 }),
        createLogEntry({ domain: 'github.com', isAllowed: true }),
      ];

      const stats = aggregateLogs(entries);

      expect(stats.byDomain.get('github.com')).toEqual({
        domain: 'github.com',
        allowed: 2,
        denied: 1,
        total: 3,
      });
    });

    it('should handle only denied entries with no allowed entries', () => {
      const entries: ParsedLogEntry[] = [
        createLogEntry({ domain: 'blocked1.com', isAllowed: false }),
        createLogEntry({ domain: 'blocked2.com', isAllowed: false }),
      ];

      const stats = aggregateLogs(entries);

      expect(stats.totalRequests).toBe(2);
      expect(stats.allowedRequests).toBe(0);
      expect(stats.deniedRequests).toBe(2);
      expect(stats.uniqueDomains).toBe(2);
    });
  });

  describe('loadAndAggregate', () => {
    it('should correctly detect blocked domains from real log lines', async () => {
      const mockLogContent = [
        '1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"',
        '1761074375.123 172.30.0.20:39749 evil.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE evil.com:443 "curl/7.81.0"',
        '1761074376.456 172.30.0.20:39750 malware.io:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE malware.io:443 "python-requests/2.28"',
        '1761074377.789 172.30.0.20:39751 npmjs.org:443 104.16.0.0:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT npmjs.org:443 "-"',
        '1761074378.012 172.30.0.20:39752 evil.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE evil.com:443 "curl/7.81.0"',
      ].join('\n');

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(mockLogContent);

      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs-blocked-test',
      };

      const stats = await loadAndAggregate(source);

      expect(stats.totalRequests).toBe(5);
      expect(stats.allowedRequests).toBe(2);
      expect(stats.deniedRequests).toBe(3);
      expect(stats.uniqueDomains).toBe(4);

      // Verify blocked domains are correctly identified
      const evilStats = stats.byDomain.get('evil.com');
      expect(evilStats).toBeDefined();
      expect(evilStats!.denied).toBe(2);
      expect(evilStats!.allowed).toBe(0);

      const malwareStats = stats.byDomain.get('malware.io');
      expect(malwareStats).toBeDefined();
      expect(malwareStats!.denied).toBe(1);
      expect(malwareStats!.allowed).toBe(0);

      // Verify allowed domains
      const githubStats = stats.byDomain.get('api.github.com');
      expect(githubStats).toBeDefined();
      expect(githubStats!.allowed).toBe(1);
      expect(githubStats!.denied).toBe(0);
    });

    it('should detect blocked HTTP domains from real log lines', async () => {
      const mockLogContent = [
        '1761074374.646 172.30.0.20:39748 example.com:80 93.184.216.34:80 1.1 GET 200 TCP_MISS:HIER_DIRECT http://example.com/ "-"',
        '1761074375.123 172.30.0.20:39749 blocked.com:80 -:- 1.1 GET 403 TCP_DENIED:HIER_NONE http://blocked.com/exfil "-"',
      ].join('\n');

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(mockLogContent);

      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs-http-blocked',
      };

      const stats = await loadAndAggregate(source);

      expect(stats.totalRequests).toBe(2);
      expect(stats.allowedRequests).toBe(1);
      expect(stats.deniedRequests).toBe(1);

      const blockedStats = stats.byDomain.get('blocked.com');
      expect(blockedStats).toBeDefined();
      expect(blockedStats!.denied).toBe(1);
      expect(blockedStats!.allowed).toBe(0);
    });

    it('should load and aggregate logs in one call', async () => {
      const mockLogContent = [
        '1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"',
        '1761074375.123 172.30.0.20:39749 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"',
        '1761074376.456 172.30.0.20:39750 evil.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE evil.com:443 "curl/7.81.0"',
      ].join('\n');

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(mockLogContent);

      const source: LogSource = {
        type: 'preserved',
        path: '/tmp/squid-logs-123',
      };

      const stats = await loadAndAggregate(source);

      expect(stats.totalRequests).toBe(3);
      expect(stats.allowedRequests).toBe(2);
      expect(stats.deniedRequests).toBe(1);
      expect(stats.uniqueDomains).toBe(2);
    });
  });
});

/**
 * Helper function to create a mock ParsedLogEntry with default values
 */
function createLogEntry(overrides: Partial<ParsedLogEntry> = {}): ParsedLogEntry {
  return {
    timestamp: 1761074374.646,
    clientIp: '172.30.0.20',
    clientPort: '39748',
    host: 'api.github.com:443',
    destIp: '140.82.114.22',
    destPort: '443',
    protocol: '1.1',
    method: 'CONNECT',
    statusCode: 200,
    decision: 'TCP_TUNNEL:HIER_DIRECT',
    url: 'api.github.com:443',
    userAgent: '-',
    domain: 'api.github.com',
    isAllowed: true,
    isHttps: true,
    ...overrides,
  };
}
