/**
 * Additional tests for log-parser.ts covering IPv6 dest parsing branches
 * (lines 180-189, 195, 202 in parseAuditJsonlLine).
 */

import { parseAuditJsonlLine } from './log-parser';

describe('log-parser — parseAuditJsonlLine IPv6 and edge-case dest parsing', () => {
  describe('bracketed IPv6 dest (lines 180-189)', () => {
    it('parses bracketed IPv6 address with port correctly', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'http_access',
        client: '172.30.0.20',
        host: 'api.github.com:443',
        dest: '[2001:db8::1]:443',
        method: 'CONNECT',
        status: 200,
        decision: 'TCP_TUNNEL',
        url: 'api.github.com:443',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.destIp).toBe('2001:db8::1');
      expect(entry!.destPort).toBe('443');
      expect(entry!.isAllowed).toBe(true);
    });

    it('parses bracketed IPv6 address without port', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'http_access',
        client: '172.30.0.20',
        host: 'api.github.com:443',
        dest: '[2001:db8::1]',
        method: 'CONNECT',
        status: 200,
        decision: 'TCP_TUNNEL',
        url: 'api.github.com:443',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      // No port found, destPort stays '-'
      expect(entry!.destIp).toBe('2001:db8::1');
      expect(entry!.destPort).toBe('-');
    });

    it('parses bracketed IPv6 with non-numeric suffix (no port extracted)', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'http_access',
        client: '172.30.0.20',
        host: 'api.github.com:443',
        dest: '[2001:db8::1]:notaport',
        method: 'CONNECT',
        status: 200,
        decision: 'TCP_TUNNEL',
        url: 'api.github.com:443',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.destIp).toBe('2001:db8::1');
      expect(entry!.destPort).toBe('-');
    });

    it('handles malformed bracketed IPv6 missing close bracket (line 188-191)', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'http_access',
        client: '172.30.0.20',
        host: 'api.github.com:443',
        dest: '[2001:db8::1',
        method: 'CONNECT',
        status: 200,
        decision: 'TCP_TUNNEL',
        url: 'api.github.com:443',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      // Falls through to destIp = rawDest
      expect(entry!.destIp).toBe('[2001:db8::1');
      expect(entry!.destPort).toBe('-');
    });
  });

  describe('IPv4 dest without port (line 195)', () => {
    it('handles IPv4 address with no colon (no port)', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'http_access',
        client: '172.30.0.20',
        host: 'example.com',
        dest: '93.184.216.34',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.destIp).toBe('93.184.216.34');
      expect(entry!.destPort).toBe('-');
    });

    it('handles bare hostname with no port', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'http_access',
        client: '172.30.0.20',
        host: 'example.com',
        dest: 'upstream-server',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.destIp).toBe('upstream-server');
      expect(entry!.destPort).toBe('-');
    });
  });

  describe('dest with non-numeric port candidate (line 202)', () => {
    it('treats entire dest as destIp when port is non-numeric', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'http_access',
        client: '172.30.0.20',
        host: 'example.com',
        dest: '93.184.216.34:notaport',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.destIp).toBe('93.184.216.34:notaport');
      expect(entry!.destPort).toBe('-');
    });
  });

  describe('dest field is absent or dash-colon', () => {
    it('keeps default destIp=-/destPort=- when dest is undefined', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'http_access',
        client: '172.30.0.20',
        host: 'example.com',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.destIp).toBe('-');
      expect(entry!.destPort).toBe('-');
    });

    it('keeps defaults when dest is "-:-"', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'http_access',
        client: '172.30.0.20',
        host: 'github.com:8443',
        dest: '-:-',
        method: 'CONNECT',
        status: 403,
        decision: 'TCP_DENIED',
        url: 'github.com:8443',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.destIp).toBe('-');
      expect(entry!.destPort).toBe('-');
      expect(entry!.isAllowed).toBe(false);
    });
  });
});
