import { generateDockerCompose } from './compose-generator';
import { mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';
import { setupComposeTestFixture } from './test-helpers/compose-test-fixture.test-utils';

// This mock must remain per-file because jest.mock() is hoisted before imports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

const fixture = setupComposeTestFixture();

describe('generateDockerCompose: gVisor runtime (non-iptables compose agent)', () => {
  it('omits iptables-init but keeps the compose agent when networkIsolation is false', () => {
    const config = fixture.withConfig({
      containerRuntime: 'gvisor',
      networkIsolation: false,
    });
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.services.agent).toBeDefined();
    expect(result.services['iptables-init']).toBeUndefined();
  });

  it('sets AWF_SKIP_IPTABLES_INIT (not AWF_NETWORK_ISOLATION) in the agent environment', () => {
    const config = fixture.withConfig({
      containerRuntime: 'gvisor',
      networkIsolation: false,
    });
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.services.agent.environment?.AWF_SKIP_IPTABLES_INIT).toBe('1');
    expect(result.services.agent.environment?.AWF_NETWORK_ISOLATION).toBeUndefined();
  });

  it('treats the raw runsc runtime name the same as gvisor', () => {
    const config = fixture.withConfig({
      containerRuntime: 'runsc',
      networkIsolation: false,
    });
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.services.agent).toBeDefined();
    expect(result.services['iptables-init']).toBeUndefined();
    expect(result.services.agent.environment?.AWF_SKIP_IPTABLES_INIT).toBe('1');
  });
});

describe('generateDockerCompose: microVM runtime (sbx)', () => {
  it('omits compose agent and agent-only helper services', () => {
    const config = fixture.withConfig({
      containerRuntime: 'sbx',
      runnerTopology: 'arc-dind' as const,
      networkIsolation: false,
    });
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.services.agent).toBeUndefined();
    expect(result.services['iptables-init']).toBeUndefined();
    expect(result.services['sysroot-stage']).toBeUndefined();
    expect(result.volumes?.sysroot).toBeUndefined();
  });

  it('publishes api-proxy ports when api-proxy is enabled', () => {
    const config = fixture.withConfig({
      containerRuntime: 'sbx',
      runnerTopology: 'arc-dind' as const,
      networkIsolation: false,
      enableApiProxy: true,
    });
    const networkWithProxy = {
      ...mockNetworkConfig,
      proxyIp: '172.30.0.30',
    };
    const result = generateDockerCompose(config, networkWithProxy);

    expect(result.services['api-proxy']).toBeDefined();
    const ports = result.services['api-proxy'].ports;
    expect(ports).toContain('10000:10000');
    expect(ports).toContain('10001:10001');
    expect(ports).toContain('10002:10002');
    expect(ports).toContain('10003:10003');
    expect(ports).toContain('10004:10004');
  });

  it('attaches api-proxy to awf-ext in network-isolation mode for port publishing', () => {
    const config = fixture.withConfig({
      containerRuntime: 'sbx',
      runnerTopology: 'arc-dind' as const,
      networkIsolation: true,
      enableApiProxy: true,
    });
    const networkWithProxy = {
      ...mockNetworkConfig,
      proxyIp: '172.30.0.30',
    };
    const result = generateDockerCompose(config, networkWithProxy);

    expect(result.services['api-proxy']).toBeDefined();
    const networks = result.services['api-proxy'].networks as Record<string, any>;
    expect(networks['awf-ext']).toBeDefined();
    expect(result.services['api-proxy'].ports).toContain('10002:10002');
  });
});
