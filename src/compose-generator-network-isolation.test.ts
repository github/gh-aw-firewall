import { generateDockerCompose } from './compose-generator';
import { WrapperConfig } from './types';
import { baseConfig, mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mocks must remain per-file because jest.mock() is hoisted before imports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Mock host-gateway resolution (runs execa.sync against Docker, which we don't want in unit tests)
jest.mock('./services/host-gateway', () => ({
  resolveDockerHostGateway: jest.fn(),
}));

let mockConfig: WrapperConfig;

beforeEach(() => {
  mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
});

afterEach(() => {
  fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
});

describe('generateDockerCompose: network-isolation (topology) mode', () => {
  it('should emit an internal awf-net with a subnet and an external awf-ext bridge', () => {
    const result = generateDockerCompose({ ...mockConfig, networkIsolation: true }, mockNetworkConfig);

    expect(result.networks['awf-net'].internal).toBe(true);
    expect(result.networks['awf-net'].external).toBeUndefined();
    expect(result.networks['awf-net'].name).toBe('awf-net');
    expect(result.networks['awf-net'].ipam?.config?.[0]?.subnet).toBe(mockNetworkConfig.subnet);
    expect(result.networks['awf-ext'].driver).toBe('bridge');
  });

  it('should dual-home squid on awf-net and awf-ext', () => {
    const result = generateDockerCompose({ ...mockConfig, networkIsolation: true }, mockNetworkConfig);

    const squidNetworks = result.services['squid-proxy'].networks as { [key: string]: { ipv4_address?: string } };
    expect(squidNetworks['awf-net'].ipv4_address).toBe('172.30.0.10');
    expect(squidNetworks['awf-ext']).toBeDefined();
  });

  it('keeps cli-proxy on awf-net only when it targets an attached DIFC proxy', () => {
    const config = {
      ...mockConfig,
      networkIsolation: true,
      difcProxyHost: 'awmg-cli-proxy:18443',
    };
    const networkWithCliProxy = {
      ...mockNetworkConfig,
      cliProxyIp: '172.30.0.50',
    };
    const result = generateDockerCompose(config, networkWithCliProxy);

    const cliProxyNetworks = result.services['cli-proxy'].networks as { [key: string]: { ipv4_address?: string } };
    expect(cliProxyNetworks['awf-net'].ipv4_address).toBe('172.30.0.50');
    expect(cliProxyNetworks['awf-ext']).toBeUndefined();
  });

  it('keeps cli-proxy on awf-net only when the DIFC proxy is a sibling addressed by its awf-net IP', () => {
    const config = {
      ...mockConfig,
      networkIsolation: true,
      difcProxyHost: '172.30.0.60:18443',
    };
    const networkWithCliProxy = {
      ...mockNetworkConfig,
      cliProxyIp: '172.30.0.50',
    };
    const result = generateDockerCompose(config, networkWithCliProxy);

    const cliProxyNetworks = result.services['cli-proxy'].networks as { [key: string]: { ipv4_address?: string } };
    expect(cliProxyNetworks['awf-net'].ipv4_address).toBe('172.30.0.50');
    expect(cliProxyNetworks['awf-ext']).toBeUndefined();
  });

  it('dual-homes only a credential-free relay when cli-proxy targets an external DIFC proxy', () => {
    const config = {
      ...mockConfig,
      networkIsolation: true,
      difcProxyHost: 'host.docker.internal:18443',
    };
    const networkWithCliProxy = {
      ...mockNetworkConfig,
      cliProxyIp: '172.30.0.50',
    };
    const result = generateDockerCompose(config, networkWithCliProxy);

    const cliProxyNetworks = result.services['cli-proxy'].networks as { [key: string]: { ipv4_address?: string } };
    expect(cliProxyNetworks['awf-net'].ipv4_address).toBe('172.30.0.50');
    expect(cliProxyNetworks['awf-ext']).toBeUndefined();

    const relay = result.services['cli-proxy-egress'];
    const relayNetworks = relay.networks as Record<string, unknown>;
    const relayEnvironment = relay.environment as Record<string, string>;
    expect(relayNetworks['awf-net']).toBeDefined();
    expect(relayNetworks['awf-ext']).toBeDefined();
    expect(relayEnvironment.GH_TOKEN).toBeUndefined();
    expect(relayEnvironment.AWF_DIFC_PROXY_HOST).toBe('host.docker.internal');
    expect(relayEnvironment.AWF_DIFC_PROXY_PORT).toBe('18443');
  });

  it('keeps cli-proxy off awf-ext outside network-isolation mode', () => {
    const config = {
      ...mockConfig,
      networkIsolation: false,
      difcProxyHost: 'host.docker.internal:18443',
    };
    const networkWithCliProxy = {
      ...mockNetworkConfig,
      cliProxyIp: '172.30.0.50',
    };
    const result = generateDockerCompose(config, networkWithCliProxy);

    const cliProxyNetworks = result.services['cli-proxy'].networks as { [key: string]: { ipv4_address?: string } };
    expect(cliProxyNetworks['awf-ext']).toBeUndefined();
    expect(result.services['cli-proxy-egress']).toBeUndefined();
  });

  it('should keep the agent on awf-net only (no external network)', () => {
    const result = generateDockerCompose({ ...mockConfig, networkIsolation: true }, mockNetworkConfig);

    const agentNetworks = result.services.agent.networks as { [key: string]: unknown };
    expect(agentNetworks['awf-net']).toBeDefined();
    expect(agentNetworks['awf-ext']).toBeUndefined();
  });

  it('should not create the iptables-init service', () => {
    const result = generateDockerCompose({ ...mockConfig, networkIsolation: true }, mockNetworkConfig);

    expect(result.services['iptables-init']).toBeUndefined();
  });

  it('should set AWF_NETWORK_ISOLATION=1 in the agent environment', () => {
    const result = generateDockerCompose({ ...mockConfig, networkIsolation: true }, mockNetworkConfig);

    expect(result.services.agent.environment?.AWF_NETWORK_ISOLATION).toBe('1');
  });

  it('should point agent DNS at the Docker embedded resolver', () => {
    const result = generateDockerCompose({ ...mockConfig, networkIsolation: true }, mockNetworkConfig);

    expect(result.services.agent.dns).toEqual(['127.0.0.11']);
  });

  it('keeps host gateway off the agent proxy bypass list in topology mode', () => {
    const result = generateDockerCompose(
      { ...mockConfig, networkIsolation: true, enableHostAccess: true },
      mockNetworkConfig,
    );

    const noProxy = String(result.services.agent.environment?.NO_PROXY ?? '').split(',');
    expect(noProxy).not.toContain('host.docker.internal');
    expect(noProxy).not.toContain('172.30.0.1');
    expect(result.services.agent.extra_hosts?.['host.docker.internal']).toBeUndefined();
  });

  it('should still build the iptables-init service in default (iptables) mode', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);

    expect(result.services['iptables-init']).toBeDefined();
    expect(result.networks['awf-net'].external).toBe(true);
    expect(result.networks['awf-ext']).toBeUndefined();
    expect(result.services.agent.environment?.AWF_NETWORK_ISOLATION).toBeUndefined();
  });
});
