import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir, withEnv } from './service-test-setup.test-utils';
import type { BoundedQueriesConfig } from '../types';

// Mock execa module (must remain per-file — jest.mock() is hoisted before imports)
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('./host-gateway', () => ({
  resolveDockerHostGateway: jest.fn(() => '172.17.0.1'),
}));

let mockConfig: WrapperConfig;

const boundedQueries: BoundedQueriesConfig = {
  enabled: true,
  privateRepos: [{ repo: 'octo/alpha', sensitivity: 'internal' }],
  runtime: 'docker',
  timeout: 30,
  memoryLimit: '512m',
  interpreter: 'python3',
  maxInvocations: 32,
};

/**
 * End-to-end compose assembly checks for bounded queries: Compose agents use a
 * networkless broker, while sbx HTTP ingress uses only its dedicated internal
 * network. In either case the broker exposes no private state to the agent.
 */
describe('bounded-query broker in generated Docker Compose', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig,
  );

  const enabled = (): WrapperConfig => ({ ...mockConfig, boundedQueries });

  describe('when bounded queries are disabled', () => {
    it('adds no broker service, agent dependency, mount, or environment variable', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;

      expect(result.services['bounded-query-broker']).toBeUndefined();
      expect(result.services['bounded-query-image']).toBeUndefined();
      expect((agent.depends_on as Record<string, unknown>)['bounded-query-broker']).toBeUndefined();
      expect(JSON.stringify(agent.volumes)).not.toContain('bounded-query');
      expect(JSON.stringify(agent.environment)).not.toContain('BOUNDED_QUERY');
    });

    it('adds nothing when the section is present but not enabled', () => {
      const result = generateDockerCompose(
        { ...mockConfig, boundedQueries: { ...boundedQueries, enabled: false } },
        mockNetworkConfig,
      );
      expect(result.services['bounded-query-broker']).toBeUndefined();
      expect(result.services['bounded-query-image']).toBeUndefined();
    });
  });

  describe('when bounded queries are enabled', () => {
    it('adds a broker service with no network', () => {
      const result = generateDockerCompose(enabled(), mockNetworkConfig);
      const broker = result.services['bounded-query-broker'] as unknown as Record<string, unknown>;

      expect(broker).toBeDefined();
      expect(broker.container_name).toBe('awf-bounded-query-broker');
      expect(broker.network_mode).toBe('none');
      expect(broker.networks).toBeUndefined();
    });

    it('adds a one-shot networkless query-image dependency', () => {
      const result = generateDockerCompose(enabled(), mockNetworkConfig);
      const imageService = result.services['bounded-query-image'] as unknown as Record<string, unknown>;
      const broker = result.services['bounded-query-broker'] as unknown as Record<string, unknown>;

      expect(imageService.network_mode).toBe('none');
      expect(imageService.entrypoint).toEqual(['/bin/true']);
      expect(imageService.volumes).toBeUndefined();
      expect(broker.depends_on).toEqual({
        'bounded-query-image': { condition: 'service_completed_successfully' },
      });
    });

    it('gates the agent on broker health', () => {
      const result = generateDockerCompose(enabled(), mockNetworkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;

      expect((agent.depends_on as Record<string, { condition: string }>)['bounded-query-broker'].condition)
        .toBe('service_healthy');
    });

    it('gives the agent the socket and skill mounts and nothing else bounded-query related', () => {
      const result = generateDockerCompose(enabled(), mockNetworkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;
      const boundedQueryMounts = (agent.volumes as string[]).filter((v) => v.includes('awf-bounded-query'));

      expect(boundedQueryMounts).toHaveLength(4);
      expect(boundedQueryMounts.filter((v) => v.endsWith(':rw'))).toHaveLength(2);
      expect(boundedQueryMounts.filter((v) => v.endsWith(':ro'))).toHaveLength(2);
      expect(boundedQueryMounts.join(' ')).not.toContain('/seeds');
      expect(boundedQueryMounts.join(' ')).not.toContain('docker.sock');
    });

    it('tells the agent where the socket and skill are, and which repos exist', () => {
      const result = generateDockerCompose(enabled(), mockNetworkConfig);
      const environment = (result.services['agent'] as unknown as Record<string, Record<string, string>>).environment;

      expect(environment.AWF_BOUNDED_QUERY_SOCKET).toBe('/run/awf-bounded-query/broker.sock');
      expect(environment.AWF_BOUNDED_QUERY_SKILL).toBe('/run/awf-bounded-query-skill/SKILL.md');
      expect(environment.AWF_BOUNDED_QUERY_REPOS).toBe('octo/alpha');
    });

    it('strips GitHub credentials from the agent even without the API or DIFC proxies', () => {
      withEnv(
        {
          GITHUB_TOKEN: 'ghs_leaked',
          GH_TOKEN: 'ghs_leaked_2',
          GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_leaked',
        },
        () => {
          const config = { ...enabled(), envAll: true, enableApiProxy: false, difcProxyHost: undefined };
          const result = generateDockerCompose(config, mockNetworkConfig);
          const environment = (result.services['agent'] as unknown as Record<string, Record<string, string>>).environment;

          expect(environment.GITHUB_TOKEN).toBeUndefined();
          expect(environment.GH_TOKEN).toBeUndefined();
          expect(environment.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
          expect(JSON.stringify(environment)).not.toContain('ghs_leaked');
          expect(JSON.stringify(environment)).not.toContain('ghp_leaked');
        },
      );
    });

    it('keeps the broker off the topology networks in network-isolation mode', () => {
      const result = generateDockerCompose({ ...enabled(), networkIsolation: true }, mockNetworkConfig);
      const broker = result.services['bounded-query-broker'] as unknown as Record<string, unknown>;

      expect(broker.network_mode).toBe('none');
      expect(broker.networks).toBeUndefined();
    });

    it.each(['docker', 'gvisor'] as const)(
      'pairs an sbx primary agent with the %s query runner over internal HTTP ingress',
      (runtime) => {
        const result = generateDockerCompose({
          ...enabled(),
          containerRuntime: 'sbx',
          boundedQueryIngressTransport: 'sbx-http',
          boundedQueries: { ...boundedQueries, runtime },
        }, mockNetworkConfig);
        const broker = result.services['bounded-query-broker'] as unknown as Record<string, unknown>;
        const environment = broker.environment as Record<string, string>;

        expect(result.services.agent).toBeUndefined();
        expect(broker.network_mode).toBeUndefined();
        expect(broker.networks).toEqual(['awf-bounded-query-ingress']);
        expect(broker.ports).toEqual(['172.17.0.1::18080']);
        expect(result.networks['awf-bounded-query-ingress']).toEqual({
          driver: 'bridge',
          internal: true,
        });
        expect(environment.AWF_BOUNDED_QUERY_BACKEND).toBe(runtime);
        expect(environment.AWF_BOUNDED_QUERY_TCP_PORT).toBe('18080');
        expect(JSON.stringify(broker)).not.toContain('awf-net');
        expect(JSON.stringify(broker)).not.toContain('awf-ext');
      },
    );
  });
});
