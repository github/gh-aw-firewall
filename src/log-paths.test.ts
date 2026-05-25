import { resolveLogPaths } from './log-paths';
import { WrapperConfig } from './types';

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir: '/tmp/awf-test',
    allowedDomains: [],
    blockedDomains: [],
    ...overrides,
  } as WrapperConfig;
}

describe('resolveLogPaths', () => {
  it('uses workDir-relative paths when proxyLogsDir and sessionStateDir are not set', () => {
    const paths = resolveLogPaths(makeConfig());
    expect(paths.squidLogs).toBe('/tmp/awf-test/squid-logs');
    expect(paths.sessionState).toBe('/tmp/awf-test/agent-session-state');
    expect(paths.agentLogs).toBe('/tmp/awf-test/agent-logs');
    expect(paths.apiProxyLogs).toBe('/tmp/awf-test/api-proxy-logs');
    expect(paths.cliProxyLogs).toBe('/tmp/awf-test/cli-proxy-logs');
  });

  it('uses proxyLogsDir for squid/api-proxy/cli-proxy when specified', () => {
    const paths = resolveLogPaths(makeConfig({ proxyLogsDir: '/var/logs/firewall' }));
    expect(paths.squidLogs).toBe('/var/logs/firewall');
    expect(paths.apiProxyLogs).toBe('/var/logs/firewall/api-proxy-logs');
    expect(paths.cliProxyLogs).toBe('/var/logs/firewall/cli-proxy-logs');
    // agentLogs always in workDir
    expect(paths.agentLogs).toBe('/tmp/awf-test/agent-logs');
  });

  it('uses sessionStateDir when specified', () => {
    const paths = resolveLogPaths(makeConfig({ sessionStateDir: '/persist/session' }));
    expect(paths.sessionState).toBe('/persist/session');
  });
});
