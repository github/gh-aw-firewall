import { generateDockerCompose } from './compose-generator';
import { getRealUserHome } from './host-identity';
import { ACT_PRESET_BASE_IMAGE } from './host-identity';
import { logger } from './logger';
import { WrapperConfig } from './types';
import { baseConfig, mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Mock host-gateway resolution (runs execa.sync against Docker, which we don't want in unit tests)
const mockResolveDockerHostGateway = jest.fn();
jest.mock('./services/host-gateway', () => ({
  resolveDockerHostGateway: (...args: any[]) => mockResolveDockerHostGateway(...args),
}));

let mockConfig: WrapperConfig;

describe('generateDockerCompose', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

    it('should generate docker-compose config with GHCR images by default', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);

      expect(result.services['squid-proxy'].image).toBe('ghcr.io/github/gh-aw-firewall/squid:latest');
      expect(result.services.agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent:latest');
      expect(result.services['squid-proxy'].build).toBeUndefined();
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should use local build when buildLocal is true', () => {
      const localConfig = { ...mockConfig, buildLocal: true };
      const result = generateDockerCompose(localConfig, mockNetworkConfig);

      expect(result.services['squid-proxy'].build).toBeDefined();
      expect(result.services.agent.build).toBeDefined();
      expect(result.services['squid-proxy'].image).toBeUndefined();
      expect(result.services.agent.image).toBeUndefined();
    });

    it('should pass BASE_IMAGE build arg when custom agentImage is specified with --build-local', () => {
      const customImageConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ghcr.io/catthehacker/ubuntu:runner-22.04',
      };
      const result = generateDockerCompose(customImageConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe('ghcr.io/catthehacker/ubuntu:runner-22.04');
    });

    it('should not include BASE_IMAGE build arg when using default agentImage with --build-local', () => {
      const localConfig = { ...mockConfig, buildLocal: true, agentImage: 'default' };
      const result = generateDockerCompose(localConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      // BASE_IMAGE should not be set when using the default preset
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBeUndefined();
    });

    it('should not include BASE_IMAGE build arg when agentImage is undefined with --build-local', () => {
      const localConfig = { ...mockConfig, buildLocal: true };
      // agentImage is not set, should default to 'default' preset
      const result = generateDockerCompose(localConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      // BASE_IMAGE should not be set when using the default (undefined means 'default')
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBeUndefined();
    });

    it('should pass BASE_IMAGE build arg when agentImage with SHA256 digest is specified', () => {
      const customImageConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ghcr.io/catthehacker/ubuntu:full-22.04@sha256:a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1',
      };
      const result = generateDockerCompose(customImageConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe('ghcr.io/catthehacker/ubuntu:full-22.04@sha256:a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1');
    });

    it('should use act base image when agentImage is "act" preset with --build-local', () => {
      const actPresetConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'act',
      };
      const result = generateDockerCompose(actPresetConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      // When using 'act' preset with --build-local, should use the catthehacker act image
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe(ACT_PRESET_BASE_IMAGE);
    });

    it('should use agent-act GHCR image when agentImage is "act" preset without --build-local', () => {
      const actPresetConfig = {
        ...mockConfig,
        agentImage: 'act',
      };
      const result = generateDockerCompose(actPresetConfig, mockNetworkConfig);

      expect(result.services.agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent-act:latest');
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should use agent GHCR image when agentImage is "default" preset', () => {
      const defaultPresetConfig = {
        ...mockConfig,
        agentImage: 'default',
      };
      const result = generateDockerCompose(defaultPresetConfig, mockNetworkConfig);

      expect(result.services.agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent:latest');
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should use agent GHCR image when agentImage is undefined', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);

      expect(result.services.agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent:latest');
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should use custom registry and tag with act preset', () => {
      const customConfig = {
        ...mockConfig,
        agentImage: 'act',
        imageRegistry: 'docker.io/myrepo',
        imageTag: 'v1.0.0',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services['squid-proxy'].image).toBe('docker.io/myrepo/squid:v1.0.0');
      expect(result.services.agent.image).toBe('docker.io/myrepo/agent-act:v1.0.0');
    });

    it('should use custom registry and tag', () => {
      const customConfig = {
        ...mockConfig,
        imageRegistry: 'docker.io/myrepo',
        imageTag: 'v1.0.0',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services['squid-proxy'].image).toBe('docker.io/myrepo/squid:v1.0.0');
      expect(result.services.agent.image).toBe('docker.io/myrepo/agent:v1.0.0');
    });

    it('should use custom registry and tag with default preset explicitly set', () => {
      const customConfig = {
        ...mockConfig,
        agentImage: 'default',
        imageRegistry: 'docker.io/myrepo',
        imageTag: 'v2.0.0',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.image).toBe('docker.io/myrepo/agent:v2.0.0');
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should append per-image digests from image-tag metadata', () => {
      const customConfig = {
        ...mockConfig,
        enableApiProxy: true,
        imageTag: [
          'v1.0.0',
          'squid=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'agent=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'api-proxy=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        ].join(','),
      };
      const networkWithProxy = {
        ...mockNetworkConfig,
        proxyIp: '172.30.0.30',
      };
      const result = generateDockerCompose(customConfig, networkWithProxy);

      expect(result.services['squid-proxy'].image).toBe(
        'ghcr.io/github/gh-aw-firewall/squid:v1.0.0@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      );
      expect(result.services.agent.image).toBe(
        'ghcr.io/github/gh-aw-firewall/agent:v1.0.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      );
      expect(result.services['iptables-init'].image).toBe(
        'ghcr.io/github/gh-aw-firewall/agent:v1.0.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      );
      expect(result.services['api-proxy'].image).toBe(
        'ghcr.io/github/gh-aw-firewall/api-proxy:v1.0.0@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      );
    });

    it('should build locally with custom catthehacker full image', () => {
      const customConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ghcr.io/catthehacker/ubuntu:full-24.04',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe('ghcr.io/catthehacker/ubuntu:full-24.04');
      expect(result.services.agent.image).toBeUndefined();
    });

    it('should build locally with custom ubuntu image', () => {
      const customConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ubuntu:24.04',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe('ubuntu:24.04');
    });

    it('should include USER_UID and USER_GID in build args with custom image', () => {
      const customConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ghcr.io/catthehacker/ubuntu:runner-22.04',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.build?.args?.USER_UID).toBeDefined();
      expect(result.services.agent.build?.args?.USER_GID).toBeDefined();
    });

    it('should include USER_UID and USER_GID in build args with act preset', () => {
      const customConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'act',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.build?.args?.USER_UID).toBeDefined();
      expect(result.services.agent.build?.args?.USER_GID).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe(ACT_PRESET_BASE_IMAGE);
    });

    it('should configure network with correct IPs', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);

      expect(result.networks['awf-net'].external).toBe(true);

      const squidNetworks = result.services['squid-proxy'].networks as { [key: string]: { ipv4_address?: string } };
      expect(squidNetworks['awf-net'].ipv4_address).toBe('172.30.0.10');

      const agentNetworks = result.services.agent.networks as { [key: string]: { ipv4_address?: string } };
      expect(agentNetworks['awf-net'].ipv4_address).toBe('172.30.0.20');
    });

    describe('network-isolation (topology) mode', () => {
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

      it('should still build the iptables-init service in default (iptables) mode', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);

        expect(result.services['iptables-init']).toBeDefined();
        expect(result.networks['awf-net'].external).toBe(true);
        expect(result.networks['awf-ext']).toBeUndefined();
        expect(result.services.agent.environment?.AWF_NETWORK_ISOLATION).toBeUndefined();
      });
    });

    describe('host-gateway IP passthrough (AWF_HOST_GATEWAY_IP)', () => {
      afterEach(() => {
        mockResolveDockerHostGateway.mockReset();
      });

      it('should pass AWF_HOST_GATEWAY_IP to iptables-init when enableHostAccess is true', () => {
        mockResolveDockerHostGateway.mockReturnValue('192.168.1.100');
        const config = { ...mockConfig, enableHostAccess: true };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const initEnv = result.services['iptables-init']?.environment as Record<string, string>;

        expect(mockResolveDockerHostGateway).toHaveBeenCalled();
        expect(initEnv.AWF_HOST_GATEWAY_IP).toBe('192.168.1.100');
      });

      it('should set AWF_HOST_GATEWAY_IP to empty when enableHostAccess is false', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const initEnv = result.services['iptables-init']?.environment as Record<string, string>;

        expect(mockResolveDockerHostGateway).not.toHaveBeenCalled();
        expect(initEnv.AWF_HOST_GATEWAY_IP).toBe('');
      });

      it('should set AWF_HOST_GATEWAY_IP to empty when detection fails', () => {
        mockResolveDockerHostGateway.mockReturnValue(undefined);
        const config = { ...mockConfig, enableHostAccess: true };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const initEnv = result.services['iptables-init']?.environment as Record<string, string>;

        expect(initEnv.AWF_HOST_GATEWAY_IP).toBe('');
      });
    });

    describe('sysroot-stage service (runner.topology = arc-dind)', () => {
      it('adds sysroot-stage service when runnerTopology is arc-dind', () => {
        const config = { ...mockConfig, runnerTopology: 'arc-dind' as const };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.services['sysroot-stage']).toBeDefined();
        expect(result.services['sysroot-stage'].container_name).toBe('awf-sysroot-stage');
        expect(result.services['sysroot-stage'].image).toBe(
          'ghcr.io/github/gh-aw-firewall/build-tools:latest',
        );
      });

      it('does not add sysroot-stage when runnerTopology is not set', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        expect(result.services['sysroot-stage']).toBeUndefined();
      });

      it('does not add sysroot-stage when runnerTopology is standard', () => {
        const config = { ...mockConfig, runnerTopology: 'standard' as const };
        const result = generateDockerCompose(config, mockNetworkConfig);
        expect(result.services['sysroot-stage']).toBeUndefined();
      });

      it('agent depends_on sysroot-stage with service_completed_successfully', () => {
        const config = { ...mockConfig, runnerTopology: 'arc-dind' as const };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.services.agent.depends_on).toMatchObject({
          'sysroot-stage': { condition: 'service_completed_successfully' },
        });
      });

      it('declares sysroot named volume', () => {
        const config = { ...mockConfig, runnerTopology: 'arc-dind' as const };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.volumes).toBeDefined();
        expect(result.volumes!.sysroot).toEqual({});
      });

      it('adds sysroot:/host:rw to agent volumes', () => {
        const config = { ...mockConfig, runnerTopology: 'arc-dind' as const };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.services.agent.volumes).toContain('sysroot:/host:rw');
      });

      it('does not retain base-system bind mounts that shadow sysroot', () => {
        const config = {
          ...mockConfig,
          runnerTopology: 'arc-dind' as const,
          dockerHostPathPrefix: '/daemon-root',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).not.toContain('/usr:/host/usr:ro');
        expect(volumes).not.toContain('/bin:/host/bin:ro');
        expect(volumes).not.toContain('/lib:/host/lib:ro');
        expect(volumes).not.toContain('/lib64:/host/lib64:ro');
        expect(volumes).not.toContain('/opt:/host/opt:ro');
        expect(volumes).toContain('/sys:/host/sys:ro');
        expect(volumes).toContain('/dev:/host/dev:ro');
        expect(volumes.some(v => v.includes(':/host/usr:ro'))).toBe(false);
        expect(volumes.some(v => v.includes(':/host/bin:ro'))).toBe(false);
        expect(volumes.some(v => v.includes(':/host/sbin:ro'))).toBe(false);
        expect(volumes.some(v => v.includes(':/host/lib:ro'))).toBe(false);
        expect(volumes.some(v => v.includes(':/host/lib64:ro'))).toBe(false);
        expect(volumes.some(v => v.includes(':/host/opt:ro'))).toBe(false);
        expect(volumes.filter(v => v.endsWith(':/host/sys:ro'))).toEqual(['/sys:/host/sys:ro']);
        expect(volumes.filter(v => v.endsWith(':/host/dev:ro'))).toEqual(['/dev:/host/dev:ro']);
      });

      it('does not declare sysroot volume when topology is standard', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        expect(result.volumes).toBeUndefined();
      });

      it('uses custom sysrootImage when configured', () => {
        const config = {
          ...mockConfig,
          runnerTopology: 'arc-dind' as const,
          sysrootImage: 'ghcr.io/my-org/custom:v1',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.services['sysroot-stage'].image).toBe('ghcr.io/my-org/custom:v1');
      });

      it('uses imageTag in default sysroot image', () => {
        const config = {
          ...mockConfig,
          runnerTopology: 'arc-dind' as const,
          imageTag: '0.28.0',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.services['sysroot-stage'].image).toBe(
          'ghcr.io/github/gh-aw-firewall/build-tools:0.28.0',
        );
      });

      it('warns when runnerToolCachePath is under /opt', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        const config = {
          ...mockConfig,
          runnerTopology: 'arc-dind' as const,
          runnerToolCachePath: '/opt/hostedtoolcache',
        };

        generateDockerCompose(config, mockNetworkConfig);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('under /opt (/opt/hostedtoolcache)')
        );
        warnSpy.mockRestore();
      });

      it('does not warn when runnerToolCachePath is on a shared path', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        const config = {
          ...mockConfig,
          runnerTopology: 'arc-dind' as const,
          runnerToolCachePath: '/var/lib/awf/tool-cache',
        };

        generateDockerCompose(config, mockNetworkConfig);

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('declares sysroot volume in network-isolation mode', () => {
        const config = {
          ...mockConfig,
          networkIsolation: true,
          runnerTopology: 'arc-dind' as const,
        };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.volumes).toEqual({ sysroot: {} });
      });

      it('filters out workDir and home dot-directory bind mounts on split-fs', () => {
        const config = {
          ...mockConfig,
          runnerTopology: 'arc-dind' as const,
          workDir: '/tmp/awf-12345',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];
        const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();

        // workDir-based mounts should be dropped
        expect(volumes.some(v => v.startsWith('/tmp/awf-12345'))).toBe(false);

        // Home dot-directory mounts should be dropped, but workspace mounts under home should remain.
        const effectiveHomeForFilter = getRealUserHome();
        const homeTargets = volumes
          .filter(v => {
            const target = v.split(':')[1];
            return target.startsWith(`/host${effectiveHomeForFilter}`) && !v.startsWith('/dev/null');
          })
          .map(v => v.split(':')[1]);

        expect(homeTargets).toContain(`/host${workspaceDir}`);
        expect(homeTargets.some(target => target.startsWith(`/host${effectiveHomeForFilter}/.`))).toBe(false);

        // Home root mounts (including trailing slash source) should be dropped.
        const effectiveHome = getRealUserHome();
        const configWithHomeRootMount = {
          ...config,
          volumeMounts: [`${effectiveHome}/:/host${effectiveHome}:rw`],
        };
        const resultWithHomeRootMount = generateDockerCompose(configWithHomeRootMount, mockNetworkConfig);
        const homeRootMounts = (resultWithHomeRootMount.services.agent.volumes as string[]).filter(v => {
          const target = v.split(':')[1];
          return target === `/host${effectiveHome}` || target === `/host${effectiveHome}/`;
        });
        expect(homeRootMounts).toHaveLength(0);

        // Should still have /tmp:/tmp, /sys, /dev, sysroot volume
        expect(volumes).toContain('/tmp:/tmp:rw');
        expect(volumes).toContain('/sys:/host/sys:ro');
        expect(volumes).toContain('/dev:/host/dev:ro');
        expect(volumes).toContain('sysroot:/host:rw');
      });
    });
});
