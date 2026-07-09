/**
 * Targeted branch-coverage tests for src/logs/log-parser.ts:
 *
 * - extractDomain: non-numeric port suffix in CONNECT URL (line 115 false branch)
 * - extractDomain: non-numeric port suffix in Host header (line 127 false branch)
 * - parseAuditJsonlLine: obj.method absent (line 162 false branch)
 * - parseAuditJsonlLine: obj.decision non-string (line 167 false branch)
 * - parseAuditJsonlLine: IPv4 dest with non-numeric "port" (lines 199-210)
 * - parseAuditJsonlLine: timestamp ISO string that fails Date.parse + ts fallback (lines 218-222)
 * - parseAuditJsonlLine: timestamp as plain obj.ts number without obj.timestamp (lines 222-224)
 * - parseAuditJsonlLine: neither obj.timestamp nor obj.ts (stays 0)
 */

import { parseLogLine, parseAuditJsonlLine } from './log-parser';

describe('log-parser – extractDomain branch coverage', () => {
  describe('CONNECT URL with non-numeric port suffix (line 115 false branch)', () => {
    it('returns the full URL when the part after the last colon is not a number', () => {
      // Construct a synthetic log line where the URL field for a CONNECT request
      // ends with a non-numeric segment (e.g. "host:svcname"). The code falls
      // through the `if (/^\d+$/.test(possiblePort))` guard and returns the URL
      // unchanged.
      const line =
        '1761074374.646 172.30.0.20:39748 host.example.com:svc 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT host.example.com:svc "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      // Port suffix is "svc" (non-numeric), so the domain is the whole URL string
      expect(result!.domain).toBe('host.example.com:svc');
    });

    it('returns the full URL when there is no colon at all', () => {
      const line =
        '1761074374.646 172.30.0.20:39748 hostnameonly 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT hostnameonly "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe('hostnameonly');
    });
  });

  describe('Host header with non-numeric port suffix (line 127 false branch)', () => {
    it('returns the full host when the port segment is non-numeric', () => {
      // For non-CONNECT methods, the Host header is used. If the part after the
      // last colon is not numeric, the code returns the entire host string.
      const line =
        '1761074374.646 172.30.0.20:39748 example.com:http 93.184.216.34:80 1.1 GET 200 TCP_MISS:HIER_DIRECT http://example.com/ "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe('example.com:http');
    });
  });
});

describe('parseAuditJsonlLine – branch coverage for absent/non-string fields', () => {
  describe('obj.method absent (line 162 false branch)', () => {
    it('uses empty string for method when method is not present', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        client: '172.30.0.20',
        host: 'example.com',
        dest: '93.184.216.34:80',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.method).toBe('');
      expect(entry!.isHttps).toBe(false); // CONNECT not present
    });
  });

  describe('obj.decision non-string (line 167 false branch)', () => {
    it('treats non-string decision as empty string (neither allowed nor denied)', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        client: '172.30.0.20',
        host: 'example.com',
        dest: '93.184.216.34:80',
        method: 'GET',
        status: 200,
        decision: 42, // number, not string
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.decision).toBe('');
      expect(entry!.isAllowed).toBe(false);
    });
  });

  describe('IPv4 dest with non-numeric port (lines 199-203 else branch)', () => {
    it('uses entire dest string as destIp when port is alphabetic', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        client: '172.30.0.20',
        host: 'example.com',
        dest: '93.184.216.34:http',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.destIp).toBe('93.184.216.34:http');
      expect(entry!.destPort).toBe('-');
    });
  });

  describe('timestamp parsing branches (lines 218-235)', () => {
    it('falls back to obj.ts when obj.timestamp is a string that fails Date.parse', () => {
      // An invalid ISO string that is still of type string triggers the
      // `Number.isNaN(parsed)` guard and falls back to `obj.ts`.
      const line = JSON.stringify({
        timestamp: 'not-a-valid-date',
        ts: 1761074374.646,
        client: '172.30.0.20',
        host: 'example.com',
        dest: '-:-',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      // Falls back to the legacy `ts` epoch field
      expect(entry!.timestamp).toBe(1761074374.646);
    });

    it('uses obj.ts directly when obj.timestamp is absent', () => {
      // No `timestamp` key → falls into the `else if (typeof obj.ts === "number")` branch.
      const line = JSON.stringify({
        ts: 1761074374.646,
        client: '172.30.0.20',
        host: 'example.com',
        dest: '-:-',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.timestamp).toBe(1761074374.646);
    });

    it('leaves timestamp as 0 when neither obj.timestamp nor obj.ts are present', () => {
      const line = JSON.stringify({
        client: '172.30.0.20',
        host: 'example.com',
        dest: '-:-',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.timestamp).toBe(0);
    });
  });
});
