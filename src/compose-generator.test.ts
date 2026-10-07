import { generateDockerCompose } from './compose-generator';
import { ACT_PRESET_BASE_IMAGE } from './host-identity';
import { WrapperConfig } from './types';
import { baseConfig, mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

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

    it('adds routed proxy wiring without exposing routing state to the agent', () => {
      const digest = 'a'.repeat(64);
      const routingConfig: WrapperConfig = {
        ...mockConfig,
        enableApiProxy: true,
        experimentalModelRouting: true,
        images: {
          squid: `ghcr.io/example/squid:test@sha256:${digest}`,
          agent: `ghcr.io/example/agent:test@sha256:${digest}`,
          apiProxy: `ghcr.io/example/api-proxy:test@sha256:${digest}`,
          router: `ghcr.io/example/router:test@sha256:${digest}`,
        },
        modelRouting: {
          objective: { goal: 'cost', mode: 'balanced' },
          task: { conversationFile: '/run/awf-routing/input/conversation.json' },
        },
        modelRoutingBootstrap: {
          root: `${mockConfig.workDir}-routing`,
          inputDir: `${mockConfig.workDir}-routing/input`,
          outputDir: `${mockConfig.workDir}-routing/output`,
          inputFile: `${mockConfig.workDir}-routing/input/conversation.json`,
          containerInputFile: '/run/awf-routing/input/conversation.json',
          containerOutputDir: '/run/awf-routing/output',
        },
      };
      const result = generateDockerCompose(routingConfig, {
        ...mockNetworkConfig,
        proxyIp: '172.30.0.30',
      });
      const apiProxyService = result.services['api-proxy'] as any;
      const agentEnvironment = result.services.agent.environment as Record<string, string>;

      expect(result.services.router).toBeDefined();
      expect(result.services.router.environment).toBeUndefined();
      expect(result.services.router.ports).toBeUndefined();
      expect(result.services.router.volumes).toBeUndefined();
      expect(result.services.router.networks).toEqual({
        'awf-routing': { aliases: ['gh-aw-router'] },
      });
      expect(result.services.router.healthcheck?.test).toEqual([
        'CMD',
        'python',
        '-c',
        "import urllib.request; urllib.request.urlopen('http://localhost:8737/healthz', timeout=1).close()",
      ]);
      expect(apiProxyService.networks['awf-routing']).toEqual({});
      expect(apiProxyService.depends_on.router).toEqual({
        condition: 'service_healthy',
      });
      expect(apiProxyService.volumes).toEqual(
        expect.arrayContaining([
          `${mockConfig.workDir}-routing/input:/run/awf-routing/input:ro`,
          `${mockConfig.workDir}-routing/output:/run/awf-routing/output:rw`,
        ]),
      );
      expect(agentEnvironment.AWF_ROUTING_CONFIG).toBeUndefined();
      expect(result.networks['awf-routing']).toMatchObject({ internal: true });
    });

    it('fails routed compose generation when host staging has not happened', () => {
      const digest = 'a'.repeat(64);
      const routingConfig: WrapperConfig = {
        ...mockConfig,
        enableApiProxy: true,
        experimentalModelRouting: true,
        images: {
          squid: `ghcr.io/example/squid:test@sha256:${digest}`,
          agent: `ghcr.io/example/agent:test@sha256:${digest}`,
          apiProxy: `ghcr.io/example/api-proxy:test@sha256:${digest}`,
          router: `ghcr.io/example/router:test@sha256:${digest}`,
        },
        modelRouting: {
          objective: { goal: 'cost', mode: 'balanced' },
          task: { conversationFile: '/host/conversation.json' },
        },
      };

      expect(() => generateDockerCompose(routingConfig, {
        ...mockNetworkConfig,
        proxyIp: '172.30.0.30',
      })).toThrow('Model routing was configured but the routing conversation was not staged');
    });

    it('omits routing infrastructure when opt-in or routing request is absent', () => {
      const routingConfig: WrapperConfig = {
        ...mockConfig,
        enableApiProxy: true,
        modelRouting: {
          objective: { goal: 'cost', mode: 'balanced' },
          task: { conversationFile: '/host/conversation.json' },
        },
        modelRoutingBootstrap: {
          root: '/tmp/awf-routing',
          inputDir: '/tmp/awf-routing/input',
          outputDir: '/tmp/awf-routing/output',
          inputFile: '/tmp/awf-routing/input/conversation.json',
          containerInputFile: '/run/awf-routing/input/conversation.json',
          containerOutputDir: '/run/awf-routing/output',
        },
      };
      for (const optIn of [undefined, false, true]) {
        routingConfig.experimentalModelRouting = optIn;
        if (optIn === true) delete routingConfig.modelRouting;
        const compose = generateDockerCompose(routingConfig, { ...mockNetworkConfig, proxyIp: '172.30.0.30' });
        const proxy = compose.services['api-proxy'];
        expect(compose.services.router).toBeUndefined();
        expect(compose.networks['awf-routing']).toBeUndefined();
        expect(proxy.networks).not.toHaveProperty('awf-routing');
        expect(proxy.volumes?.some(volume => volume.includes('/run/awf-routing/'))).toBe(false);
        expect(proxy.environment?.AWF_ROUTING_CONFIG).toBeUndefined();
      }
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

});
