import { WrapperConfig } from '../../types';
import { baseConfig, mockNetworkConfig } from '../../test-helpers/docker-test-fixtures.test-utils';
import { buildProxyEnvironment } from './proxy-environment';

function run(config: Omit<WrapperConfig, 'workDir'> & { workDir?: string }): Record<string, string> {
  const environment: Record<string, string> = {};
  buildProxyEnvironment({
    config: { ...config, workDir: config.workDir ?? '/tmp/awf-work' } as WrapperConfig,
    networkConfig: mockNetworkConfig,
    environment,
  });
  return environment;
}

describe('buildProxyEnvironment', () => {
  it('does not add the network gateway to NO_PROXY for default (iptables) runtimes', () => {
    const env = run({ ...baseConfig });
    expect(env.NO_PROXY.split(',')).not.toContain('172.30.0.1');
    expect(env.NO_PROXY.split(',')).not.toContain('host.docker.internal');
    // Keeps lowercase mirror in sync
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('adds the network gateway + host.docker.internal to NO_PROXY for gVisor', () => {
    // gVisor has no iptables NAT bypass for the MCP gateway, so it must be in
    // NO_PROXY for proxy-aware clients to reach it directly.
    const env = run({ ...baseConfig, containerRuntime: 'gvisor' });
    expect(env.NO_PROXY.split(',')).toContain('172.30.0.1');
    expect(env.NO_PROXY.split(',')).toContain('host.docker.internal');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('adds the network gateway to NO_PROXY when host access is enabled (any runtime)', () => {
    const env = run({ ...baseConfig, enableHostAccess: true });
    expect(env.NO_PROXY.split(',')).toContain('172.30.0.1');
    expect(env.NO_PROXY.split(',')).toContain('host.docker.internal');
  });

  describe('topology-attached peers', () => {
    it('exempts topology peers from proxy routing for a compose agent in isolation mode', () => {
      const env = run({
        ...baseConfig,
        networkIsolation: true,
        topologyAttach: ['awmg-mcpg', 'awmg-cli-proxy'],
      });
      expect(env.NO_PROXY.split(',')).toContain('awmg-mcpg');
      expect(env.NO_PROXY.split(',')).toContain('awmg-cli-proxy');
      expect(env.no_proxy).toBe(env.NO_PROXY);
    });

    it('exempts the DIFC/cli-proxy host even when not listed in topologyAttach', () => {
      const env = run({
        ...baseConfig,
        networkIsolation: true,
        difcProxyHost: 'awmg-cli-proxy',
      });
      expect(env.NO_PROXY.split(',')).toContain('awmg-cli-proxy');
    });

    it('strips port suffix from difcProxyHost', () => {
      const env = run({
        ...baseConfig,
        networkIsolation: true,
        difcProxyHost: 'awmg-cli-proxy:8443',
      });
      expect(env.NO_PROXY.split(',')).toContain('awmg-cli-proxy');
      expect(env.NO_PROXY.split(',')).not.toContain('awmg-cli-proxy:8443');
    });

    it('strips scheme and port from a scheme-prefixed difcProxyHost', () => {
      const env = run({
        ...baseConfig,
        networkIsolation: true,
        difcProxyHost: 'https://proxy.internal:443',
      });
      expect(env.NO_PROXY.split(',')).toContain('proxy.internal');
    });

    it('strips brackets and port from a bracketed IPv6 difcProxyHost', () => {
      const env = run({
        ...baseConfig,
        networkIsolation: true,
        difcProxyHost: '[::1]:18443',
      });
      expect(env.NO_PROXY.split(',')).toContain('::1');
    });

    it('does NOT exempt topology peers outside network-isolation mode', () => {
      const env = run({
        ...baseConfig,
        networkIsolation: false,
        topologyAttach: ['awmg-mcpg'],
      });
      expect(env.NO_PROXY.split(',')).not.toContain('awmg-mcpg');
    });

    it('does NOT exempt topology peers for a microVM (sbx) agent', () => {
      // The sbx microVM runs off awf-net and cannot resolve or route to these
      // container hostnames; NO_PROXY there would break the connection rather
      // than fix it, so peers are deliberately omitted for microVM backends.
      const env = run({
        ...baseConfig,
        containerRuntime: 'sbx',
        networkIsolation: true,
        topologyAttach: ['awmg-mcpg'],
        difcProxyHost: 'awmg-cli-proxy',
      });
      expect(env.NO_PROXY.split(',')).not.toContain('awmg-mcpg');
      expect(env.NO_PROXY.split(',')).not.toContain('awmg-cli-proxy');
    });
  });
});
