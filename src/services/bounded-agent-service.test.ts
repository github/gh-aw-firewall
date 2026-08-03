import {
  generateDockerCompose,
  WrapperConfig,
  baseConfig,
  mockNetworkConfig,
  useTempWorkDir,
} from './service-test-setup.test-utils';
import { BOUNDED_AGENT_DEFAULTS, type BoundedAgentsConfig } from '../types/bounded-agent-options';
import {
  BOUNDED_AGENT_API_PROXY_ALIAS,
  BOUNDED_AGENT_API_PROXY_IP,
  BOUNDED_AGENT_EGRESS_NETWORK,
  BOUNDED_AGENT_NETWORK,
  BOUNDED_AGENT_SUBNET,
} from '../bounded-agent/network';
import { buildBoundedAgentService, resolveBoundedAgentApiPort } from './bounded-agent-service';

// Mock execa module (must remain per-file — jest.mock() is hoisted before imports)
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('./host-gateway', () => ({
  resolveDockerHostGateway: jest.fn(() => '172.17.0.1'),
}));

let mockConfig: WrapperConfig;

/** Network config that includes the API proxy, which bounded agents require. */
const networkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };

const boundedAgents: BoundedAgentsConfig = {
  ...BOUNDED_AGENT_DEFAULTS,
  enabled: true,
  model: 'gpt-4o-mini',
  privateRepos: [{ repo: 'octo/alpha', sensitivity: 'internal' }],
};

/**
 * End-to-end compose assembly checks for bounded agents.
 *
 * The properties under test are topological: the broker is networkless, the
 * enclave network is `internal` and contains only the API proxy, and the
 * primary agent receives exactly two mounts and no privileged state.
 */
describe('bounded-agent broker in generated Docker Compose', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig,
  );

  const enabled = (overrides: Partial<BoundedAgentsConfig> = {}): WrapperConfig => ({
    ...mockConfig,
    enableApiProxy: true,
    openaiApiKey: 'sk-real',
    boundedAgents: { ...boundedAgents, ...overrides },
  });

  describe('when bounded agents are disabled', () => {
    it('adds no broker service, agent dependency, mount, environment variable, or network', () => {
      const result = generateDockerCompose(mockConfig, networkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;

      expect(result.services['bounded-agent-broker']).toBeUndefined();
      expect(result.services['bounded-agent-image']).toBeUndefined();
      expect((agent.depends_on as Record<string, unknown>)['bounded-agent-broker']).toBeUndefined();
      expect(JSON.stringify(agent.volumes)).not.toContain('bounded-agent');
      expect(JSON.stringify(agent.environment)).not.toContain('BOUNDED_AGENT');
      expect(result.networks[BOUNDED_AGENT_NETWORK]).toBeUndefined();
    });

    it('adds nothing when the section is present but not enabled', () => {
      const result = generateDockerCompose(
        { ...mockConfig, boundedAgents: { ...boundedAgents, enabled: false } },
        networkConfig,
      );
      expect(result.services['bounded-agent-broker']).toBeUndefined();
      expect(result.networks[BOUNDED_AGENT_NETWORK]).toBeUndefined();
    });
  });

  describe('when bounded agents are enabled', () => {
    it('adds a networkless broker service', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      const broker = result.services['bounded-agent-broker'] as unknown as Record<string, unknown>;

      expect(broker).toBeDefined();
      expect(broker.container_name).toBe('awf-bounded-agent-broker');
      expect(broker.network_mode).toBe('none');
      expect(broker.networks).toBeUndefined();
    });

    it('declares a dedicated internal network with an explicit name', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      expect(result.networks[BOUNDED_AGENT_NETWORK]).toEqual({
        name: BOUNDED_AGENT_NETWORK,
        driver: 'bridge',
        internal: true,
        ipam: { config: [{ subnet: BOUNDED_AGENT_SUBNET }] },
      });
    });

    it('uses a dedicated API proxy with private state on the enclave network', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      const apiProxy = result.services['bounded-agent-api-proxy'] as unknown as Record<string, unknown>;
      const networks = apiProxy.networks as Record<string, Record<string, unknown>>;

      expect(networks[BOUNDED_AGENT_NETWORK]).toEqual({
        ipv4_address: BOUNDED_AGENT_API_PROXY_IP,
        aliases: [BOUNDED_AGENT_API_PROXY_ALIAS],
      });
      expect(networks[BOUNDED_AGENT_EGRESS_NETWORK]).toEqual({});
      expect(networks['awf-net']).toBeUndefined();
      expect(JSON.stringify(apiProxy.volumes)).toContain('awf-bounded-agent-private');

      // No other service joins the enclave network.
      for (const [name, service] of Object.entries(result.services)) {
        if (name === 'bounded-agent-api-proxy') continue;
        expect(JSON.stringify((service as unknown as Record<string, unknown>).networks ?? {}))
          .not.toContain(BOUNDED_AGENT_NETWORK);
      }
    });

    it('keeps squid, the primary agent, and the broker off the enclave network', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      for (const name of ['squid-proxy', 'agent', 'bounded-agent-broker']) {
        const service = result.services[name] as unknown as Record<string, unknown>;
        expect(JSON.stringify(service.networks ?? {})).not.toContain(BOUNDED_AGENT_NETWORK);
      }
    });

    it('adds a one-shot networkless enclave-image dependency and waits for the API proxy', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      const imageService = result.services['bounded-agent-image'] as unknown as Record<string, unknown>;
      const broker = result.services['bounded-agent-broker'] as unknown as Record<string, unknown>;

      expect(imageService.network_mode).toBe('none');
      expect(imageService.entrypoint).toEqual(['/bin/true']);
      expect(imageService.volumes).toBeUndefined();
      expect(broker.depends_on).toEqual({
        'bounded-agent-image': { condition: 'service_completed_successfully' },
        'bounded-agent-api-proxy': { condition: 'service_healthy' },
      });
    });

    it('gives the agent only the socket and skill mounts', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;
      const volumes = (agent.volumes as string[]).filter((volume) => volume.includes('bounded-agent'));

      expect(volumes).toHaveLength(4);
      const targets = volumes.map((volume) => volume.split(':')[1]).sort();
      expect(targets).toEqual([
        '/host/run/awf-bounded-agent',
        '/host/run/awf-bounded-agent-skill',
        '/run/awf-bounded-agent',
        '/run/awf-bounded-agent-skill',
      ]);
    });

    it('never exposes the Docker socket, seeds, work dir, or audit dir to the agent', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;
      const serialized = JSON.stringify(agent.volumes);

      expect(serialized).not.toContain('awf-bounded-agent-private');
      expect(serialized).not.toContain('seed-map.json');
      expect(serialized).not.toContain('/srv/awf');
    });

    it('gives the agent only the socket, skill, and repository-list environment', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;
      const env = agent.environment as Record<string, string>;
      const boundedAgentKeys = Object.keys(env).filter((key) => key.startsWith('AWF_BOUNDED_AGENT')).sort();

      expect(boundedAgentKeys).toEqual([
        'AWF_BOUNDED_AGENT_REPOS',
        'AWF_BOUNDED_AGENT_SKILL',
        'AWF_BOUNDED_AGENT_SOCKET',
      ]);
      expect(env.AWF_BOUNDED_AGENT_SOCKET).toBe('/run/awf-bounded-agent/broker.sock');
      // The model identity is broker-only state.
      expect(JSON.stringify(env)).not.toContain('gpt-4o-mini');
    });

    it('passes the trusted enclave configuration to the broker only', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      const broker = result.services['bounded-agent-broker'] as unknown as Record<string, unknown>;
      const env = broker.environment as Record<string, string>;

      expect(env.AWF_BOUNDED_AGENT_BACKEND).toBe('docker');
      expect(env.AWF_BOUNDED_AGENT_NETWORK).toBe(BOUNDED_AGENT_NETWORK);
      expect(env.AWF_BOUNDED_AGENT_PROFILE).toBe('openai');
      expect(env.AWF_BOUNDED_AGENT_MODEL).toBe('gpt-4o-mini');
      expect(env.AWF_BOUNDED_AGENT_API_ENDPOINT).toBe(`http://${BOUNDED_AGENT_API_PROXY_IP}:10000`);
      expect(env.AWF_BOUNDED_AGENT_TIMEOUT).toBe('120');
      expect(env.AWF_BOUNDED_AGENT_MAX_INVOCATIONS).toBe('8');
      expect(env.AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS).toBe('8');
      expect(env.AWF_BOUNDED_AGENT_MAX_MODEL_TOKENS).toBe('1024');
      expect(env.AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES).toBe('8192');
      expect(env.AWF_BOUNDED_AGENT_MAX_TASK_BYTES).toBe('4096');
    });

    it('routes the anthropic profile to the Anthropic API-proxy port', () => {
      const result = generateDockerCompose(
        {
          ...enabled({ profile: 'anthropic', model: 'claude-sonnet-4' }),
          anthropicApiKey: 'sk-ant-real',
        },
        networkConfig,
      );
      const broker = result.services['bounded-agent-broker'] as unknown as Record<string, unknown>;
      const env = broker.environment as Record<string, string>;
      expect(env.AWF_BOUNDED_AGENT_API_ENDPOINT).toBe(`http://${BOUNDED_AGENT_API_PROXY_IP}:10001`);
    });

    it('selects the gvisor backend without changing any other wiring', () => {
      const result = generateDockerCompose(enabled({ runtime: 'gvisor' }), networkConfig);
      const broker = result.services['bounded-agent-broker'] as unknown as Record<string, unknown>;
      expect((broker.environment as Record<string, string>).AWF_BOUNDED_AGENT_BACKEND).toBe('gvisor');
      expect(broker.network_mode).toBe('none');
    });

    it('leaves bounded queries completely unaffected', () => {
      const result = generateDockerCompose(enabled(), networkConfig);
      expect(result.services['bounded-query-broker']).toBeUndefined();
      expect(result.services['bounded-query-image']).toBeUndefined();
    });
  });
});

describe('buildBoundedAgentService guards', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig,
  );

  const imageConfig = {
    useGHCR: true,
    registry: 'ghcr.io/github/gh-aw-firewall',
    parsedTag: { tag: 'latest' } as never,
    projectRoot: '/repo',
  };

  it('refuses to wire a disabled subsystem', () => {
    expect(() =>
      buildBoundedAgentService({
        config: { ...mockConfig, enableApiProxy: true, boundedAgents: { ...boundedAgents, enabled: false } },
        imageConfig,
        networkConfig,
      }),
    ).toThrow(/must be enabled/);
  });

  it('fails closed for boundedAgents.runtime "sbx" because current sbx cannot prove mandatory isolation controls', () => {
    expect(() =>
      buildBoundedAgentService({
        config: {
          ...mockConfig,
          enableApiProxy: true,
          boundedAgents: { ...boundedAgents, runtime: 'sbx' },
        },
        imageConfig,
        networkConfig,
      }),
    ).toThrow(/boundedAgents\.runtime "sbx" is capability-blocked/);
  });

  it('refuses to wire an enclave with no API proxy to talk to', () => {
    expect(() =>
      buildBoundedAgentService({
        config: { ...mockConfig, enableApiProxy: false, boundedAgents },
        imageConfig,
        networkConfig,
      }),
    ).toThrow(/require the API proxy/);
  });

  it('builds both images from the shared containers context when building locally', () => {
    const { service, enclaveImageService } = buildBoundedAgentService({
      config: { ...mockConfig, enableApiProxy: true, boundedAgents },
      imageConfig: { ...imageConfig, useGHCR: false },
      networkConfig,
    });
    expect((enclaveImageService as Record<string, unknown>).build).toEqual({
      context: '/repo/containers',
      dockerfile: 'bounded-agent/Dockerfile',
      target: 'enclave',
    });
    expect((service as Record<string, unknown>).build).toEqual({
      context: '/repo/containers',
      dockerfile: 'bounded-agent/Dockerfile',
      target: 'broker',
    });
  });
});

describe('resolveBoundedAgentApiPort', () => {
  it('maps each profile to its API-proxy port', () => {
    expect(resolveBoundedAgentApiPort('openai')).toBe(10000);
    expect(resolveBoundedAgentApiPort('anthropic')).toBe(10001);
  });
});
