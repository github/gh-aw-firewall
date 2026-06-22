/**
 * Additional coverage tests for squid-log-reader.ts.
 *
 * Targets uncovered lines found in the current coverage report:
 *   36  – `continue` branch: line contains "TCP_DENIED" but parseLogLine returns null
 *         (malformed / non-matching text)
 *   48-49 – catch block: fs.readFileSync throws an unexpected error
 *   64-68 – normalizeTarget with URL containing "://":
 *             · port present  → returns "hostname:port"
 *             · port absent   → returns "hostname" (also exercises parseTarget no-colon branch)
 *             · invalid URL   → returns original target string (catch path)
 *   75  – parseTarget: target has no colon → domain-only BlockedTarget
 *   81  – parseTarget: port segment is non-numeric → domain-only BlockedTarget
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkSquidLogs } from './squid-log-reader';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';

describe('squid-log-reader – additional branch coverage', () => {
  const { getDir } = useTempDir();

  // ── helper ──────────────────────────────────────────────────────────────────

/** Write lines to <workDir>/squid-logs/access.log. */
    const squidLogsDir = path.join(workDir, 'squid-logs');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper writing temp fixtures
    fs.mkdirSync(squidLogsDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper writing temp fixtures
    fs.writeFileSync(path.join(squidLogsDir, 'access.log'), lines.join('\n') + '\n');
  }

  // ── line 36 (continue): malformed TCP_DENIED line ───────────────────────────

  describe('line 36 – skip malformed TCP_DENIED lines', () => {
    it('skips a line that contains "TCP_DENIED" but does not match the log format', async () => {
      // This line contains the token "TCP_DENIED" but is missing required fields
      // so parseLogLine() returns null, triggering the `continue` guard.
      writeAccessLog(getDir(), [
        'this is TCP_DENIED but completely malformed text',
      ]);

      const result = await checkSquidLogs(getDir());

      expect(result).toEqual({ hasDenials: false, blockedTargets: [] });
    });

    it('still collects valid entries that follow a malformed TCP_DENIED line', async () => {
      writeAccessLog(getDir(), [
        'TCP_DENIED malformed garbage line',
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"',
      ]);

      const result = await checkSquidLogs(getDir());

      expect(result.hasDenials).toBe(true);
      expect(result.blockedTargets).toHaveLength(1);
      expect(result.blockedTargets[0].domain).toBe('blocked.com');
    });
  });

  // ── lines 48-49 (catch): readFileSync throws ────────────────────────────────

  describe('lines 48-49 – catch block when readFileSync throws', () => {
    it('swallows the error and returns no denials when access.log is a directory (EISDIR)', async () => {
      // fs.existsSync returns true for both files AND directories.
      // If the access.log path is itself a directory, fs.readFileSync throws EISDIR,
      // which exercises the catch block at lines 48-49.
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses temp directory fixture
      fs.mkdirSync(path.join(squidLogsDir, 'access.log'), { recursive: true });

      const result = await checkSquidLogs(getDir());

      expect(result).toEqual({ hasDenials: false, blockedTargets: [] });
    });
  });

  // ── lines 64-66 (normalizeTarget URL path, port present) ────────────────────

  describe('lines 64-66 – normalizeTarget with URL containing "://" and a port', () => {
    it('extracts hostname:port from a CONNECT entry whose URL field is an https URL with port', async () => {
      // CONNECT entry with host "-" forces extractBlockedTarget to use the URL field.
      // The URL "https://example.com:8080" exercises the URL-parsing branch and
      // the `parsed.port` truthy arm → returns "example.com:8080".
      writeAccessLog(getDir(), [
        '1760994429.358 172.30.0.20:36274 - -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE https://example.com:8080 "curl/7.81.0"',
      ]);

      const result = await checkSquidLogs(getDir());

      expect(result.hasDenials).toBe(true);
      expect(result.blockedTargets).toContainEqual(
        expect.objectContaining({ domain: 'example.com', port: '8080' })
      );
    });
  });

  // ── line 66 (parsed.port falsy) + line 75 (parseTarget no colon) ────────────

  describe('line 66 (port absent) + line 75 (parseTarget no colon)', () => {
    it('returns a domain-only BlockedTarget when the URL has no port component', async () => {
      // "https://no-port.example.com" has no port → normalizeTarget returns just the
      // hostname "no-port.example.com" → parseTarget sees no colon → line 75 path.
      writeAccessLog(getDir(), [
        '1760994429.358 172.30.0.20:36274 - -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE https://no-port.example.com "curl/7.81.0"',
      ]);

      const result = await checkSquidLogs(getDir());

      expect(result.hasDenials).toBe(true);
      expect(result.blockedTargets).toContainEqual({
        target: 'no-port.example.com',
        domain: 'no-port.example.com',
      });
      // No port property on this entry
      expect((result.blockedTargets[0] as { port?: string }).port).toBeUndefined();
    });
  });

  // ── lines 67-68 (normalizeTarget catch: invalid URL) ────────────────────────

  describe('lines 67-68 – normalizeTarget falls back when URL is malformed', () => {
    it('returns the original target string when new URL() throws for a malformed URL', async () => {
      // "ftp://[invalid" contains "://" so it enters the try block, but
      // new URL("ftp://[invalid") throws TypeError → catch returns original string.
      writeAccessLog(getDir(), [
        '1760994429.358 172.30.0.20:36274 - -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE ftp://[invalid "curl/7.81.0"',
      ]);

      const result = await checkSquidLogs(getDir());

      expect(result.hasDenials).toBe(true);
      // The raw string is kept as-is after the URL parse failure.
      expect(result.blockedTargets[0].target).toBe('ftp://[invalid');
    });
  });

  // ── line 81 (parseTarget: non-digit port) ────────────────────────────────────

  describe('line 81 – parseTarget with non-numeric port segment', () => {
    it('returns a domain-only BlockedTarget when the port segment is not numeric', async () => {
      // A CONNECT entry whose raw target has a colon but a non-numeric "port" part.
      // normalizeTarget passes it through as-is (no "://"), parseTarget's
      // /^\d+$/ test fails → line 81 branch: { target, domain: target }.
      writeAccessLog(getDir(), [
        '1760994429.358 172.30.0.20:36274 example.com:notaport -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE example.com:notaport "curl/7.81.0"',
      ]);

      const result = await checkSquidLogs(getDir());

      expect(result.hasDenials).toBe(true);
      const bt = result.blockedTargets[0];
      expect(bt.target).toBe('example.com:notaport');
      expect(bt.domain).toBe('example.com:notaport');
      expect((bt as { port?: string }).port).toBeUndefined();
    });
  });

  // ── proxyLogsDir option ──────────────────────────────────────────────────────

  describe('proxyLogsDir option', () => {
    it('reads logs from proxyLogsDir when provided', async () => {
      const customDir = path.join(getDir(), 'custom-proxy-logs');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses temp directory fixture
      fs.mkdirSync(customDir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses temp directory fixture
      fs.writeFileSync(
        path.join(customDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 custom.example.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE custom.example.com:443 "curl/7.81.0"\n'
      );

      const result = await checkSquidLogs(getDir(), customDir);

      expect(result.hasDenials).toBe(true);
      expect(result.blockedTargets[0].domain).toBe('custom.example.com');
    });
  });
});
