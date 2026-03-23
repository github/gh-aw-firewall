/**
 * Unit tests for log-parser.ts
 */

import { parseLogLine, extractDomain, extractPort, parseAuditJsonlLine } from './log-parser';

describe('log-parser', () => {
  describe('parseLogLine', () => {
    it('should parse a valid CONNECT (HTTPS) log line', () => {
      const line =
        '1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.timestamp).toBe(1761074374.646);
      expect(result!.clientIp).toBe('172.30.0.20');
      expect(result!.clientPort).toBe('39748');
      expect(result!.host).toBe('api.github.com:443');
      expect(result!.destIp).toBe('140.82.114.22');
      expect(result!.destPort).toBe('443');
      expect(result!.protocol).toBe('1.1');
      expect(result!.method).toBe('CONNECT');
      expect(result!.statusCode).toBe(200);
      expect(result!.decision).toBe('TCP_TUNNEL:HIER_DIRECT');
      expect(result!.url).toBe('api.github.com:443');
      expect(result!.userAgent).toBe('-');
      expect(result!.domain).toBe('api.github.com');
      expect(result!.isAllowed).toBe(true);
      expect(result!.isHttps).toBe(true);
    });

    it('should parse a denied CONNECT (HTTPS) log line', () => {
      const line =
        '1760994429.358 172.30.0.20:36274 github.com:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE github.com:8443 "curl/7.81.0"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.timestamp).toBe(1760994429.358);
      expect(result!.clientIp).toBe('172.30.0.20');
      expect(result!.clientPort).toBe('36274');
      expect(result!.host).toBe('github.com:8443');
      expect(result!.destIp).toBe('-');
      expect(result!.destPort).toBe('-');
      expect(result!.protocol).toBe('1.1');
      expect(result!.method).toBe('CONNECT');
      expect(result!.statusCode).toBe(403);
      expect(result!.decision).toBe('TCP_DENIED:HIER_NONE');
      expect(result!.url).toBe('github.com:8443');
      expect(result!.userAgent).toBe('curl/7.81.0');
      expect(result!.domain).toBe('github.com');
      expect(result!.isAllowed).toBe(false);
      expect(result!.isHttps).toBe(true);
    });

    it('should parse a TCP_MISS log line as allowed', () => {
      const line =
        '1760994429.358 172.30.0.20:36274 example.com:80 93.184.216.34:80 1.1 GET 200 TCP_MISS:HIER_DIRECT http://example.com/ "Mozilla/5.0"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.isAllowed).toBe(true);
      expect(result!.isHttps).toBe(false);
      expect(result!.method).toBe('GET');
    });

    it('should return null for empty line', () => {
      expect(parseLogLine('')).toBeNull();
      expect(parseLogLine('   ')).toBeNull();
      expect(parseLogLine('\n')).toBeNull();
    });

    it('should return null for invalid log line', () => {
      expect(parseLogLine('not a valid log line')).toBeNull();
      expect(parseLogLine('1234567890 incomplete line')).toBeNull();
    });

    it('should handle whitespace in log line', () => {
      const line =
        '  1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"  ';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe('api.github.com');
    });

    it('should parse a denied HTTP (GET) log line', () => {
      const line =
        '1760994429.358 172.30.0.20:36274 evil.com:80 -:- 1.1 GET 403 TCP_DENIED:HIER_NONE http://evil.com/ "curl/7.81.0"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe('evil.com');
      expect(result!.isAllowed).toBe(false);
      expect(result!.isHttps).toBe(false);
      expect(result!.method).toBe('GET');
      expect(result!.statusCode).toBe(403);
      expect(result!.decision).toBe('TCP_DENIED:HIER_NONE');
    });

    it('should mark TCP_HIT as allowed (cached response)', () => {
      const line =
        '1761074374.646 172.30.0.20:39748 example.com:80 93.184.216.34:80 1.1 GET 200 TCP_HIT:HIER_NONE http://example.com/ "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      // TCP_HIT is a successful cache hit — should be treated as allowed
      expect(result!.isAllowed).toBe(true);
    });

    it('should mark TCP_REFRESH_MODIFIED as allowed (refreshed cache)', () => {
      const line =
        '1761074374.646 172.30.0.20:39748 example.com:80 93.184.216.34:80 1.1 GET 200 TCP_REFRESH_MODIFIED:HIER_DIRECT http://example.com/ "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      // TCP_REFRESH_MODIFIED is a successful refreshed response — should be allowed
      expect(result!.isAllowed).toBe(true);
    });

    it('should mark NONE_NONE as denied (connection failure entries)', () => {
      const line =
        '1761074374.646 172.30.0.20:39748 -:0 -:- 1.1 NONE 0 NONE_NONE:HIER_NONE error:transaction-end-before-headers "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.isAllowed).toBe(false);
      expect(result!.decision).toBe('NONE_NONE:HIER_NONE');
    });

    it('should correctly identify HTTPS requests via CONNECT method', () => {
      const httpsLine =
        '1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"';
      const httpLine =
        '1761074374.646 172.30.0.20:39748 example.com:80 93.184.216.34:80 1.1 GET 200 TCP_MISS:HIER_DIRECT http://example.com/ "-"';

      const httpsResult = parseLogLine(httpsLine);
      const httpResult = parseLogLine(httpLine);

      expect(httpsResult!.isHttps).toBe(true);
      expect(httpResult!.isHttps).toBe(false);
    });
  });

  describe('blocked domain detection', () => {
    it('should detect blocked HTTPS domain with correct domain extraction', () => {
      const line =
        '1760994429.358 172.30.0.20:36274 malware.example.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE malware.example.com:443 "python-requests/2.28"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe('malware.example.com');
      expect(result!.isAllowed).toBe(false);
      expect(result!.isHttps).toBe(true);
    });

    it('should detect blocked HTTP domain with correct domain extraction', () => {
      const line =
        '1760994429.358 172.30.0.20:36274 exfiltration.io:80 -:- 1.1 GET 403 TCP_DENIED:HIER_NONE http://exfiltration.io/data "wget/1.21"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe('exfiltration.io');
      expect(result!.isAllowed).toBe(false);
      expect(result!.isHttps).toBe(false);
    });

    it('should detect blocked domain on non-standard port', () => {
      const line =
        '1760994429.358 172.30.0.20:36274 api.blocked.com:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE api.blocked.com:8443 "curl/7.81.0"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe('api.blocked.com');
      expect(result!.isAllowed).toBe(false);
    });

    it('should distinguish allowed and denied requests for the same domain format', () => {
      const allowedLine =
        '1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"';
      const deniedLine =
        '1761074375.123 172.30.0.20:39749 api.github.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE api.github.com:443 "-"';

      const allowed = parseLogLine(allowedLine);
      const denied = parseLogLine(deniedLine);

      expect(allowed!.domain).toBe('api.github.com');
      expect(denied!.domain).toBe('api.github.com');
      expect(allowed!.isAllowed).toBe(true);
      expect(denied!.isAllowed).toBe(false);
    });
  });

  describe('extractDomain', () => {
    it('should extract domain from CONNECT URL with port', () => {
      expect(extractDomain('api.github.com:443', 'host', 'CONNECT')).toBe('api.github.com');
      expect(extractDomain('example.com:8443', 'host', 'CONNECT')).toBe('example.com');
    });

    it('should return URL as-is for CONNECT without port', () => {
      expect(extractDomain('api.github.com', 'host', 'CONNECT')).toBe('api.github.com');
    });

    it('should extract domain from host header for non-CONNECT', () => {
      expect(extractDomain('http://example.com/', 'example.com:80', 'GET')).toBe('example.com');
      expect(extractDomain('http://test.com/path', 'test.com', 'GET')).toBe('test.com');
    });

    it('should handle host header without port for non-CONNECT', () => {
      expect(extractDomain('http://example.com/', 'example.com', 'GET')).toBe('example.com');
    });

    it('should fallback to URL parsing when host is empty or dash', () => {
      expect(extractDomain('http://example.com/', '-', 'GET')).toBe('example.com');
      expect(extractDomain('http://example.com/path', '', 'GET')).toBe('example.com');
    });

    it('should handle URL without protocol in fallback', () => {
      expect(extractDomain('example.com/path', '-', 'GET')).toBe('example.com');
    });

    it('should return original URL if parsing fails', () => {
      // Invalid URL that can't be parsed
      expect(extractDomain(':::invalid', '-', 'GET')).toBe(':::invalid');
    });
  });

  describe('extractPort', () => {
    it('should extract port from CONNECT URL', () => {
      expect(extractPort('api.github.com:443', 'CONNECT')).toBe('443');
      expect(extractPort('example.com:8080', 'CONNECT')).toBe('8080');
    });

    it('should return undefined for CONNECT URL without port', () => {
      expect(extractPort('api.github.com', 'CONNECT')).toBeUndefined();
    });

    it('should return undefined for non-CONNECT methods', () => {
      expect(extractPort('http://example.com:80/', 'GET')).toBeUndefined();
      expect(extractPort('http://example.com/', 'POST')).toBeUndefined();
    });

    it('should not extract non-numeric port', () => {
      expect(extractPort('api.github.com:abc', 'CONNECT')).toBeUndefined();
    });
  });

  describe('parseAuditJsonlLine', () => {
    it('should parse a valid JSONL CONNECT entry', () => {
      const line = '{"ts":1761074374.646,"client":"172.30.0.20","host":"api.github.com:443","dest":"140.82.114.22:443","method":"CONNECT","status":200,"decision":"TCP_TUNNEL","url":"api.github.com:443"}';
      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.timestamp).toBeCloseTo(1761074374.646);
      expect(entry!.clientIp).toBe('172.30.0.20');
      expect(entry!.method).toBe('CONNECT');
      expect(entry!.statusCode).toBe(200);
      expect(entry!.decision).toBe('TCP_TUNNEL');
      expect(entry!.domain).toBe('api.github.com');
      expect(entry!.isAllowed).toBe(true);
      expect(entry!.isHttps).toBe(true);
    });

    it('should parse a denied JSONL entry', () => {
      const line = '{"ts":1760994429.358,"client":"172.30.0.20","host":"evil.com:443","dest":"-:-","method":"CONNECT","status":403,"decision":"TCP_DENIED","url":"evil.com:443"}';
      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.isAllowed).toBe(false);
      expect(entry!.statusCode).toBe(403);
      expect(entry!.domain).toBe('evil.com');
    });

    it('should parse a HTTP GET entry', () => {
      const line = '{"ts":1700000000.000,"client":"172.30.0.20","host":"example.com","dest":"93.184.216.34:80","method":"GET","status":200,"decision":"TCP_MISS","url":"http://example.com/"}';
      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.isHttps).toBe(false);
      expect(entry!.isAllowed).toBe(true);
      expect(entry!.domain).toBe('example.com');
    });

    it('should return null for empty lines', () => {
      expect(parseAuditJsonlLine('')).toBeNull();
      expect(parseAuditJsonlLine('   ')).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      expect(parseAuditJsonlLine('not json')).toBeNull();
      expect(parseAuditJsonlLine('{broken')).toBeNull();
    });
  });
});
