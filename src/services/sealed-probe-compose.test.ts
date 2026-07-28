import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir, withEnv } from './service-test-setup.test-utils';
import type { SealedProbesConfig } from '../types';

// Mock execa module (must remain per-file — jest.mock() is hoisted before imports)
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

const sealedProbes: SealedProbesConfig = {
  enabled: true,
  privateRepos: ['octo/alpha'],
  runtime: 'docker',
  timeout: 30,
  memoryLimit: '512m',
  interpreter: 'python3',
  maxInvocations: 32,
};

/**
 * End-to-end compose assembly checks for sealed probes: the broker must appear
 * as an optional, network-less service, gate the agent, and inject exactly two
 * mounts plus three environment variables into the agent — and nothing at all
 * when the feature is off.
 */
describe('sealed-probe broker in generated Docker Compose', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig,
  );

  const enabled = (): WrapperConfig => ({ ...mockConfig, sealedProbes });

  describe('when sealed probes are disabled', () => {
    it('adds no broker service, agent dependency, mount, or environment variable', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;

      expect(result.services['sealed-probe-broker']).toBeUndefined();
      expect((agent.depends_on as Record<string, unknown>)['sealed-probe-broker']).toBeUndefined();
      expect(JSON.stringify(agent.volumes)).not.toContain('sealed-probe');
      expect(JSON.stringify(agent.environment)).not.toContain('SEALED_PROBE');
    });

    it('adds nothing when the section is present but not enabled', () => {
      const result = generateDockerCompose(
        { ...mockConfig, sealedProbes: { ...sealedProbes, enabled: false } },
        mockNetworkConfig,
      );
      expect(result.services['sealed-probe-broker']).toBeUndefined();
    });
  });

  describe('when sealed probes are enabled', () => {
    it('adds a broker service with no network', () => {
      const result = generateDockerCompose(enabled(), mockNetworkConfig);
      const broker = result.services['sealed-probe-broker'] as unknown as Record<string, unknown>;

      expect(broker).toBeDefined();
      expect(broker.container_name).toBe('awf-sealed-probe-broker');
      expect(broker.network_mode).toBe('none');
      expect(broker.networks).toBeUndefined();
    });

    it('gates the agent on broker health', () => {
      const result = generateDockerCompose(enabled(), mockNetworkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;

      expect((agent.depends_on as Record<string, { condition: string }>)['sealed-probe-broker'].condition)
        .toBe('service_healthy');
    });

    it('gives the agent the socket and skill mounts and nothing else sealed-probe related', () => {
      const result = generateDockerCompose(enabled(), mockNetworkConfig);
      const agent = result.services['agent'] as unknown as Record<string, unknown>;
      const sealedMounts = (agent.volumes as string[]).filter((v) => v.includes('sealed-probe'));

      expect(sealedMounts).toHaveLength(4);
      expect(sealedMounts.filter((v) => v.endsWith(':rw'))).toHaveLength(2);
      expect(sealedMounts.filter((v) => v.endsWith(':ro'))).toHaveLength(2);
      expect(sealedMounts.join(' ')).not.toContain('/seeds');
      expect(sealedMounts.join(' ')).not.toContain('docker.sock');
    });

    it('tells the agent where the socket and skill are, and which repos exist', () => {
      const result = generateDockerCompose(enabled(), mockNetworkConfig);
      const environment = (result.services['agent'] as unknown as Record<string, Record<string, string>>).environment;

      expect(environment.AWF_SEALED_PROBE_SOCKET).toBe('/run/awf-sealed-probe/broker.sock');
      expect(environment.AWF_SEALED_PROBE_SKILL).toBe('/run/awf-sealed-probe-skill/SKILL.md');
      expect(environment.AWF_SEALED_PROBE_REPOS).toBe('octo/alpha');
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
      const broker = result.services['sealed-probe-broker'] as unknown as Record<string, unknown>;

      expect(broker.network_mode).toBe('none');
      expect(broker.networks).toBeUndefined();
    });
  });
});
