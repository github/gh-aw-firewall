import * as fs from 'fs';
import * as path from 'path';
import { checkSquidLogs } from './squid-log-reader';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';

describe('squid-log-reader', () => {
  const { getDir } = useTempDir();

  /** Write lines to <workDir>/squid-logs/access.log. */
  function writeAccessLog(workDir: string, lines: string[]): void {
    const squidLogsDir = path.join(workDir, 'squid-logs');
    fs.mkdirSync(squidLogsDir, { recursive: true });
    fs.writeFileSync(path.join(squidLogsDir, 'access.log'), lines.join('\n') + '\n');
  }

  it('returns no denials when the access log is missing', async () => {
    await expect(checkSquidLogs(getDir())).resolves.toEqual({
      hasDenials: false,
      blockedTargets: [],
    });
  });

  it('parses denied targets and deduplicates repeated entries', async () => {
    const squidLogsDir = path.join(getDir(), 'squid-logs');
    fs.mkdirSync(squidLogsDir, { recursive: true });
    fs.writeFileSync(
      path.join(squidLogsDir, 'access.log'),
      '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n' +
      '1760994430.000 172.30.0.20:36275 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n' +
      '1760994430.500 172.30.0.20:36275 blocked-http.com:80 -:- 1.1 GET 403 TCP_DENIED:HIER_NONE http://blocked-http.com/exfil "curl/7.81.0"\n' +
      '1760994431.000 172.30.0.20:36276 [::1]:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE [::1]:8443 "curl/7.81.0"\n'
    );

    await expect(checkSquidLogs(getDir())).resolves.toEqual({
      hasDenials: true,
      blockedTargets: [
        { target: 'blocked.com:443', domain: 'blocked.com', port: '443' },
        { target: 'blocked-http.com:80', domain: 'blocked-http.com', port: '80' },
        { target: '[::1]:8443', domain: '[::1]', port: '8443' },
      ],
    });
  });

  it('filters out AWF-internal Docker network IPs from blocked targets', async () => {
    writeAccessLog(getDir(), [
      // External blocked domain — should appear
      '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"',
      // AWF Docker network IP — should be filtered
      '1760994430.000 172.30.0.20:36275 172.30.0.30:10001 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE 172.30.0.30:10001 "node"',
      // AWF network gateway — should be filtered
      '1760994430.500 172.30.0.20:36276 172.30.0.1:8080 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE 172.30.0.1:8080 "node"',
    ]);

    const result = await checkSquidLogs(getDir());

    expect(result.hasDenials).toBe(true);
    expect(result.blockedTargets).toHaveLength(1);
    expect(result.blockedTargets[0].domain).toBe('blocked.com');
  });

  it('filters out MCP Gateway single-label hostname (awmgmcpg) from blocked targets', async () => {
    writeAccessLog(getDir(), [
      // External blocked domain — should appear
      '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"',
      // MCP Gateway hostname (no dots) — should be filtered
      '1760994430.000 172.30.0.20:36275 awmgmcpg:8080 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE awmgmcpg:8080 "node"',
      // MCP Gateway hostname with dash — should be filtered
      '1760994430.500 172.30.0.20:36276 awmg-mcpg:8080 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE awmg-mcpg:8080 "node"',
    ]);

    const result = await checkSquidLogs(getDir());

    expect(result.hasDenials).toBe(true);
    expect(result.blockedTargets).toHaveLength(1);
    expect(result.blockedTargets[0].domain).toBe('blocked.com');
  });

  it('returns hasDenials false when all blocked targets are AWF-internal', async () => {
    writeAccessLog(getDir(), [
      // All AWF-internal — should all be filtered
      '1760994429.358 172.30.0.20:36274 awmgmcpg:8080 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE awmgmcpg:8080 "node"',
      '1760994430.000 172.30.0.20:36275 172.30.0.30:10001 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE 172.30.0.30:10001 "node"',
    ]);

    const result = await checkSquidLogs(getDir());

    expect(result.hasDenials).toBe(false);
    expect(result.blockedTargets).toHaveLength(0);
  });
});
