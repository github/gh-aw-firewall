import { generateDockerCompose, redactDockerComposeSecrets } from './compose-generator';
import { ACT_PRESET_BASE_IMAGE } from './host-identity';
import { WrapperConfig } from './types';
import { baseConfig, mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('generateDockerCompose', () => {
  function routedConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
    const digest = 'a'.repeat(64);
    return {
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
      ...overrides,
    };
  }

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
      const result = generateDockerCompose(routedConfig(), {
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
        '/usr/local/bin/gh-aw-router',
        'healthcheck',
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

    it('builds the router from the checkout with the contract digest under --build-local', () => {
      const routingConfig: WrapperConfig = {
        ...mockConfig,
        buildLocal: true,
        enableApiProxy: true,
        experimentalModelRouting: true,
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
      const routerDir = path.join(__dirname, '..', 'containers', 'router');
      const contractDigest = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(routerDir, 'openapi.yaml')))
        .digest('hex');

      const router = generateDockerCompose(routingConfig, {
        ...mockNetworkConfig,
        proxyIp: '172.30.0.30',
      }).services.router;

      expect(router.image).toBeUndefined();
      expect(router.build).toEqual({
        context: routerDir,
        dockerfile: 'Dockerfile',
        args: { OPENAPI_SHA256: contractDigest },
      });
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

    describe('router OpenTelemetry export settings', () => {
      const savedEnv = { ...process.env };

      function generateRouted(overrides: Partial<WrapperConfig> = {}) {
        return generateDockerCompose(routedConfig(overrides), { ...mockNetworkConfig, proxyIp: '172.30.0.30' });
      }

      // A gh-aw-style run: the shared OTLP settings point at an external collector for the api-proxy.
      function setSharedHostTelemetry(): void {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://external-collector.example';
        process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer%20shared-canary';
        process.env.OTEL_SERVICE_NAME = 'shared-service';
        process.env.GH_AW_OTLP_ENDPOINTS = '[{"url":"https://external-collector.example"}]';
        process.env.GH_AW_OTLP_WORKLOAD_IDENTITY = 'true';
        process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.example/canary';
        process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'id-token-canary';
        process.env.GITHUB_AW_OTEL_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
        process.env.GITHUB_AW_OTEL_PARENT_SPAN_ID = 'b7ad6b7169203331';
        process.env.GITHUB_TOKEN = 'ghp_canary';
        process.env.COPILOT_GITHUB_TOKEN = 'copilot-canary';
        process.env.HTTPS_PROXY = 'http://proxy.example:3128';
      }

      afterEach(() => {
        for (const key of Object.keys(process.env)) {
          if (!(key in savedEnv)) delete process.env[key];
        }
        Object.assign(process.env, savedEnv);
      });

      it('passes AWF_ROUTER_OTEL_* settings to the router as OTEL_* without other changes', () => {
        const baseline = generateRouted().services.router;
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector:4318';
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://metrics-collector:4318/v1/metrics';
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'authorization=Bearer%20router-canary';
        process.env.AWF_ROUTER_OTEL_TRACES_SAMPLER = 'parentbased_traceidratio';
        process.env.AWF_ROUTER_OTEL_TRACES_SAMPLER_ARG = '0.5';
        process.env.AWF_ROUTER_OTEL_RESOURCE_ATTRIBUTES = 'service.namespace=awf,deployment.environment.name=ci';
        process.env.AWF_ROUTER_OTEL_METRICS_EXPORTER = 'none';
        process.env.AWF_ROUTER_OTEL_SDK_DISABLED = 'false';
        process.env.AWF_ROUTER_OTEL_SERVICE_NAME = '';

        const router = generateRouted().services.router;

        expect(router.environment).toEqual({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://metrics-collector:4318/v1/metrics',
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=Bearer%20router-canary',
          OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
          OTEL_TRACES_SAMPLER_ARG: '0.5',
          OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=awf,deployment.environment.name=ci',
          OTEL_METRICS_EXPORTER: 'none',
          OTEL_SDK_DISABLED: 'false',
        });
        expect({ ...router, environment: undefined }).toEqual(baseline);
        expect(router.networks).toEqual({ 'awf-routing': { aliases: ['gh-aw-router'] } });
        expect(router.ports).toBeUndefined();
        expect(router.volumes).toBeUndefined();
      });

      it('never forwards shared host telemetry, credentials or proxy settings to the router', () => {
        const baseline = generateRouted().services.router;
        setSharedHostTelemetry();

        const compose = generateRouted();

        expect(compose.services.router).toEqual(baseline);
        expect(compose.services.router.environment).toBeUndefined();
        // The shared settings still configure the api-proxy.
        expect(compose.services['api-proxy'].environment?.OTEL_EXPORTER_OTLP_ENDPOINT)
          .toBe('https://external-collector.example');
      });

      it('adds only the router settings when shared host telemetry is also configured', () => {
        setSharedHostTelemetry();
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector:4318';

        const environment = generateRouted().services.router.environment as Record<string, string>;

        expect(environment).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318' });
        for (const value of Object.values(environment)) {
          expect(value).not.toMatch(/canary|external-collector|proxy\.example/);
        }
      });

      it('keeps the whole AWF_ROUTER_OTEL_* namespace out of the agent, whatever supplies it', () => {
        // Supported and unsupported names, from the host with --env-all, an --env-file and --env.
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer%20host-canary';
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'authorization=logs-canary';
        const envFile = path.join(mockConfig.workDir, 'agent.env');
        fs.writeFileSync(envFile, 'AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADER=file-canary\nKEEP_FROM_FILE=kept\n');

        const compose = generateRouted({
          envAll: true,
          envFile,
          additionalEnv: {
            AWF_ROUTER_OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-traces=flag-canary',
            AWF_ROUTER_OTEL_ANYTHING: 'flag-canary',
            KEEP_FROM_FLAG: 'kept',
          },
        });
        const agentEnvironment = compose.services.agent.environment as Record<string, string>;

        expect(Object.keys(agentEnvironment).filter(key => key.startsWith('AWF_ROUTER_OTEL_'))).toEqual([]);
        expect(Object.values(agentEnvironment).join('\n')).not.toMatch(/canary/);
        expect(agentEnvironment).toMatchObject({ KEEP_FROM_FILE: 'kept', KEEP_FROM_FLAG: 'kept' });
        // Only AWF's own environment configures the router.
        expect(compose.services.router.environment).toEqual({
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20host-canary',
        });
      });

      it('escapes $ so that Compose passes router settings literally', () => {
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADERS = 'x-api-key=abc$part${HOME}$$';
        process.env.AWF_ROUTER_OTEL_SERVICE_NAME = 'router$1';

        expect(generateRouted().services.router.environment).toEqual({
          OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc$$part$${HOME}$$$$',
          OTEL_SERVICE_NAME: 'router$$1',
        });
      });

      it('puts router settings in the router service only', () => {
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT = 'http://endpoint-canary:4318';
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer%20header-canary';
        process.env.AWF_ROUTER_OTEL_SERVICE_NAME = 'name-canary';

        const { router, ...otherServices } = generateRouted({ envAll: true }).services;

        expect(router.environment).toEqual({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://endpoint-canary:4318',
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20header-canary',
          OTEL_SERVICE_NAME: 'name-canary',
        });
        expect(JSON.stringify(otherServices)).not.toMatch(/canary/);
      });

      it('redacts an escaped endpoint and header in the audit snapshot', () => {
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT = ' http://user:pa$$word-canary@otel-collector:4318';
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer%20$token-canary';

        const compose = generateRouted();
        expect(compose.services.router.environment).toEqual({
          OTEL_EXPORTER_OTLP_ENDPOINT: ' http://user:pa$$$$word-canary@otel-collector:4318',
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20$$token-canary',
        });

        expect(redactDockerComposeSecrets(compose).services.router.environment).toEqual({
          OTEL_EXPORTER_OTLP_ENDPOINT: ' http://[REDACTED]@otel-collector:4318',
          OTEL_EXPORTER_OTLP_HEADERS: '[REDACTED]',
        });
      });

      it('redacts the user info of endpoints with leading whitespace in the audit snapshot', () => {
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = ' \u00a0http://user:pw-canary@traces:4318/v1/traces';
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = '\u0085\thttps://id-canary@metrics:4318/v1/metrics';

        const redacted = redactDockerComposeSecrets(generateRouted());

        expect(redacted.services.router.environment).toEqual({
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ' \u00a0http://[REDACTED]@traces:4318/v1/traces',
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '\u0085\thttps://[REDACTED]@metrics:4318/v1/metrics',
        });
      });

      it('redacts router collector headers and endpoint user info in the audit snapshot', () => {
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT = 'http://user:pw-canary@otel-collector:4318';
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer%20router-canary';
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-traces=traces-canary';
        process.env.AWF_ROUTER_OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'x-metrics=metrics-canary';
        process.env.AWF_ROUTER_OTEL_SERVICE_NAME = 'gh-aw-router-ci';

        const compose = generateRouted();
        const redacted = redactDockerComposeSecrets(compose);

        expect(redacted.services.router.environment).toEqual({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://[REDACTED]@otel-collector:4318',
          OTEL_EXPORTER_OTLP_HEADERS: '[REDACTED]',
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: '[REDACTED]',
          OTEL_EXPORTER_OTLP_METRICS_HEADERS: '[REDACTED]',
          OTEL_SERVICE_NAME: 'gh-aw-router-ci',
        });
        expect(JSON.stringify(redacted)).not.toMatch(/canary/);
        // The compose file that runs the router keeps the real values.
        expect(compose.services.router.environment?.OTEL_EXPORTER_OTLP_HEADERS)
          .toBe('authorization=Bearer%20router-canary');
      });
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
