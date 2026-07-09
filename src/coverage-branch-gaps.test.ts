/**
 * Branch-coverage tests targeting specific uncovered paths found in the coverage report.
 *
 * This file covers log-aggregator.ts branches only. Other targets are in
 * separate files to avoid fs mock conflicts.
 *
 * Targets (log-aggregator.ts):
 *   - line 111: domain falsy → falls back to '-' key
 *   - line 156: running source with no containerName → throws
 *   - line 174: preserved source with no path → throws
 *   - line 185: JSONL file exists but has 0 parseable entries → fallback to access.log
 */

import { loadAllLogs, logAggregatorTestHelpers } from './logs/log-aggregator';
import { LogSource, ParsedLogEntry } from './types';
import { createLogEntry } from './logs/log-test-fixtures.test-utils';
import * as fs from 'fs';

jest.mock('execa');
jest.mock('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedFs = fs as jest.Mocked<typeof fs>;

const { aggregateLogs } = logAggregatorTestHelpers;

afterEach(() => jest.clearAllMocks());

describe('log-aggregator – uncovered branches', () => {
  describe('aggregateLogs – domain falsy fallback to "-"', () => {
    it('uses "-" key when domain is empty string', () => {
      const entry: ParsedLogEntry = createLogEntry({ domain: '', isAllowed: true });
      const stats = aggregateLogs([entry]);
      // domain || '-' evaluates to '-' for ''
      expect(stats.byDomain.has('-')).toBe(true);
      expect(stats.byDomain.get('-')!.total).toBe(1);
    });
  });

  describe('loadAllLogs – running source, missing containerName', () => {
    it('throws when containerName is absent', async () => {
      const source: LogSource = { type: 'running' };
      await expect(loadAllLogs(source)).rejects.toThrow('Container name is required');
    });
  });

  describe('loadAllLogs – preserved source, missing path', () => {
    it('throws when path is absent', async () => {
      const source: LogSource = { type: 'preserved' };
      await expect(loadAllLogs(source)).rejects.toThrow('Path is required');
    });
  });

  describe('loadAllLogs – JSONL exists but has no parseable entries → falls back to access.log', () => {
    it('falls back to access.log when audit.jsonl has no parseable entries', async () => {
      const validAccessLogLine =
        '1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"';

      mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const ps = String(p);
        if (ps.endsWith('audit.jsonl')) return true;
        if (ps.endsWith('access.log')) return true;
        return false;
      });

      // First readFileSync call → audit.jsonl (garbage); second → access.log (valid)
      mockedFs.readFileSync
        .mockImplementationOnce(() => 'not-valid-jsonl\n')
        .mockImplementationOnce(() => validAccessLogLine);

      const source: LogSource = { type: 'preserved', path: '/tmp/squid-logs' };
      const entries = await loadAllLogs(source);

      expect(entries).toHaveLength(1);
      expect(entries[0].domain).toBe('api.github.com');
    });
  });
});
