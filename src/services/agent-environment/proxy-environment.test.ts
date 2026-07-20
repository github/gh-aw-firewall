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
});
