import * as fs from 'fs';
import * as path from 'path';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { parseImageTag } from '../image-tag';
import type { WrapperConfig } from '../types';
import { buildEnclaveMcpService, resolveEnclaveAgentApiPort } from './enclave-mcp-service';
import { generateDockerCompose } from '../compose-generator';
import {
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_EGRESS_NETWORK,
  ENCLAVE_AGENT_NETWORK,
  ENCLAVE_AGENT_SUBNET,
} from '../enclave/network';

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir: '/tmp/awf-test',
    agentCommand: 'echo enclave',
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    enclaves: normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { agent: { enabled: true, model: 'trusted-model' } },
    }),
    enableApiProxy: true,
    copilotGithubToken: 'copilot-token',
    openaiApiKey: 'openai-key',
    anthropicApiKey: 'anthropic-key',
    ...overrides,
  } as WrapperConfig;
}

const ghcr = {
  useGHCR: true,
  registry: 'ghcr.io/github/gh-aw-firewall',
  parsedTag: parseImageTag('v1'),
  projectRoot: '/repo',
};

const networkConfig = {
  subnet: '172.30.0.0/24',
  squidIp: '172.30.0.10',
  agentIp: '172.30.0.20',
  proxyIp: '172.30.0.30',
};

function build(overrides: Partial<WrapperConfig> = {}) {
  return buildEnclaveMcpService({
    config: config(overrides),
    imageConfig: ghcr,
    networkConfig,
  });
}

describe('unified enclave agent executor compose assembly', () => {
  it('pins the published enclave-agent image and its one-shot pull service', () => {
    const result = build();
    expect(result.agentImageService).toMatchObject({
      image: 'ghcr.io/github/gh-aw-firewall/enclave-agent:v1',
      network_mode: 'none',
      entrypoint: ['/bin/true'],
      restart: 'no',
    });
    expect(result.service.depends_on).toMatchObject({
      'enclave-agent-image': { condition: 'service_completed_successfully' },
      'enclave-agent-api-proxy': { condition: 'service_healthy' },
    });
    const environment = result.service.environment as Record<string, string>;
    expect(environment.AWF_ENCLAVE_AGENT_IMAGE)
      .toBe('ghcr.io/github/gh-aw-firewall/enclave-agent:v1');
  });

  it('builds the enclave-agent and server images from their audited sources locally', () => {
    const local = buildEnclaveMcpService({
      config: config(),
      imageConfig: { ...ghcr, useGHCR: false },
      networkConfig,
    });
    expect(local.agentImageService).toMatchObject({
      image: 'awf-enclave-agent:local',
      build: {
        context: '/repo/containers',
        dockerfile: 'enclave/Dockerfile',
        target: 'enclave-agent',
      },
    });
    expect(local.service).toMatchObject({
      build: {
        context: '/repo/containers',
        dockerfile: 'enclave/Dockerfile',
        target: 'enclave-mcp-server',
      },
    });
  });

  it('keeps the MCP server on only the private control network and free of provider credentials', () => {
    const result = build();
    expect(result.service).not.toHaveProperty('network_mode');
    expect(result.service.networks).toEqual({
      'awf-enclave-mcp-control': { aliases: ['awf-enclave-mcp'] },
    });
    expect(result.service).not.toHaveProperty('ports');
    const environment = result.service.environment as Record<string, string>;
    for (const key of [
      'COPILOT_GITHUB_TOKEN',
      'COPILOT_PROVIDER_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ]) {
      expect(environment[key]).toBeUndefined();
    }
    expect(JSON.stringify(environment)).not.toContain('copilot-token');
    expect(JSON.stringify(environment)).not.toContain('openai-key');
    expect(JSON.stringify(environment)).not.toContain('octo/private');
  });

  it('derives every agent enclave control from trusted configuration', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {
        agent: {
          enabled: true,
          runtime: 'gvisor',
          engine: 'copilot',
          profile: 'anthropic',
          model: 'trusted-model',
          timeout: 77,
          memoryLimit: '256m',
          cpuLimit: '0.5',
          pidsLimit: 32,
          tmpfsLimit: '24m',
          maxOutputBytes: 2048,
          maxTaskBytes: 1024,
          maxInvocations: 3,
        },
      },
    });
    const environment = build({ enclaves }).service.environment as Record<string, string>;
    expect(environment).toMatchObject({
      AWF_ENCLAVE_AGENT_ENABLED: 'true',
      AWF_ENCLAVE_SCRIPT_ENABLED: 'false',
      AWF_ENCLAVE_AGENT_BACKEND: 'gvisor',
      AWF_ENCLAVE_AGENT_ENGINE: 'copilot',
      AWF_ENCLAVE_AGENT_PROFILE: 'anthropic',
      AWF_ENCLAVE_AGENT_MODEL: 'trusted-model',
      AWF_ENCLAVE_AGENT_NETWORK: ENCLAVE_AGENT_NETWORK,
      AWF_ENCLAVE_AGENT_TIMEOUT: '77',
      AWF_ENCLAVE_AGENT_MEMORY: '256m',
      AWF_ENCLAVE_AGENT_CPU: '0.5',
      AWF_ENCLAVE_AGENT_PIDS: '32',
      AWF_ENCLAVE_AGENT_TMPFS: '24m',
      AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES: '2048',
      AWF_ENCLAVE_AGENT_MAX_PROMPT_BYTES: '1024',
      AWF_ENCLAVE_AGENT_MAX_INVOCATIONS: '3',
    });
    // Copilot always speaks the Copilot API-proxy port, regardless of profile.
    expect(environment.AWF_ENCLAVE_AGENT_API_ENDPOINT)
      .toBe(`http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`);
  });

  it('routes non-copilot profiles to their own API-proxy port', () => {
    expect(resolveEnclaveAgentApiPort('claude', 'anthropic')).toBe(10001);
    expect(resolveEnclaveAgentApiPort('codex', 'openai')).toBe(10000);
    expect(resolveEnclaveAgentApiPort('copilot', 'anthropic')).toBe(10002);
  });

  it('fails closed for the not-yet-proven sbx agent runtime', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { agent: { enabled: true, model: 'trusted-model', runtime: 'sbx' } },
    });
    expect(() => build({ enclaves }))
      .toThrow(/sbx agent enclave capability is not yet available/);
  });

  it('refuses to wire an agent executor without the API proxy', () => {
    expect(() => build({ enableApiProxy: false }))
      .toThrow(/requires the API proxy/);
  });

  it('refuses to build with no executor enabled at all', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {},
    });
    expect(() => build({ enclaves }))
      .toThrow(/at least one enclave executor must be enabled/);
  });
});

describe('dedicated enclave agent API proxy', () => {
  it('is the sole peer of the enclave network and holds the only credential', () => {
    const proxy = build().agentApiProxyService as Record<string, any>;
    expect(proxy.container_name).toBe('awf-enclave-agent-api-proxy');
    expect(Object.keys(proxy.networks)).toEqual([
      ENCLAVE_AGENT_NETWORK,
      ENCLAVE_AGENT_EGRESS_NETWORK,
    ]);
    expect(proxy.networks[ENCLAVE_AGENT_NETWORK]).toMatchObject({
      ipv4_address: ENCLAVE_AGENT_API_PROXY_IP,
      aliases: ['awf-enclave-agent-api-proxy'],
    });
  });

  it('minimizes credentials to the configured provider route', () => {
    const proxy = build().agentApiProxyService as Record<string, any>;
    const environment = proxy.environment as Record<string, string>;
    expect(environment.COPILOT_GITHUB_TOKEN).toBe('copilot-token');
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
      expect(environment[key]).toBeUndefined();
    }
  });

  it('drops the copilot credential for a non-copilot engine route', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {
        agent: { enabled: true, model: 'trusted-model', engine: 'codex', profile: 'openai' },
      },
    });
    const proxy = build({ enclaves }).agentApiProxyService as Record<string, any>;
    const environment = proxy.environment as Record<string, string>;
    expect(environment.OPENAI_API_KEY).toBe('openai-key');
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it('removes external telemetry, OIDC state, and the Squid proxy chain', () => {
    const proxy = build({
      otlpEndpoints: 'https://collector.example.com',
    } as Partial<WrapperConfig>).agentApiProxyService as Record<string, any>;
    const environment = proxy.environment as Record<string, string>;
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'https_proxy',
      'GH_AW_OTLP_ENDPOINTS',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'GH_AW_OTLP_WORKLOAD_IDENTITY',
      'GITHUB_AW_OTEL_TRACE_ID',
      'GITHUB_AW_OTEL_PARENT_SPAN_ID',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'AWF_AUTH_ANTHROPIC_TOKEN_URL',
    ]) {
      expect(environment[key]).toBeUndefined();
    }
  });

  it('writes telemetry only to the enclave-private log root', () => {
    const proxy = build().agentApiProxyService as Record<string, any>;
    expect(JSON.stringify(proxy.volumes)).toContain('awf-enclave-private-');
    expect(JSON.stringify(proxy.volumes)).toContain('api-proxy-logs');
  });
});

describe('unified enclave compose topology', () => {
  // generateDockerCompose materializes a chroot hosts stage under the work
  // directory, so this suite needs a real one.
  let composeWorkDir: string;

  beforeAll(() => {
    composeWorkDir = fs.mkdtempSync(path.join(__dirname, 'awf-enclave-compose-'));
  });

  afterAll(() => {
    fs.rmSync(composeWorkDir, { recursive: true, force: true });
  });

  function composeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
    return config({ workDir: composeWorkDir, allowedDomains: [], ...overrides } as Partial<WrapperConfig>);
  }

  it('creates an internal enclave network plus a proxy-only egress bridge', () => {
    const compose = generateDockerCompose(composeConfig(), networkConfig);
    expect(compose.networks[ENCLAVE_AGENT_NETWORK]).toMatchObject({
      name: ENCLAVE_AGENT_NETWORK,
      internal: true,
      ipam: { config: [{ subnet: ENCLAVE_AGENT_SUBNET }] },
    });
    expect(compose.networks[ENCLAVE_AGENT_EGRESS_NETWORK]).toMatchObject({
      name: ENCLAVE_AGENT_EGRESS_NETWORK,
      driver: 'bridge',
    });
    expect(compose.networks[ENCLAVE_AGENT_EGRESS_NETWORK]).not.toHaveProperty('internal');
  });

  it('puts nothing except the dedicated proxy on the enclave network', () => {
    const compose = generateDockerCompose(composeConfig(), networkConfig);
    const members = Object.entries(compose.services)
      .filter(([, service]) => {
        const networks = (service as Record<string, any>).networks;
        if (!networks) return false;
        return Array.isArray(networks)
          ? networks.includes(ENCLAVE_AGENT_NETWORK)
          : Object.keys(networks).includes(ENCLAVE_AGENT_NETWORK);
      })
      .map(([name]) => name);
    expect(members).toEqual(['enclave-agent-api-proxy']);
    expect((compose.services['enclave-mcp-server'] as Record<string, any>).networks)
      .toEqual({ 'awf-enclave-mcp-control': { aliases: ['awf-enclave-mcp'] } });
    expect((compose.services['enclave-agent-image'] as Record<string, any>).network_mode)
      .toBe('none');
  });

  it('never exposes the enclave subsystem to the primary agent in this layer', () => {
    const compose = generateDockerCompose(composeConfig(), networkConfig);
    const agent = compose.services.agent as unknown as Record<string, unknown>;
    expect((agent.depends_on as Record<string, unknown>)['enclave-mcp-server']).toBeUndefined();
    expect((agent.depends_on as Record<string, unknown>)['enclave-agent-api-proxy'])
      .toBeUndefined();
    expect(JSON.stringify(agent.volumes)).not.toContain('awf-enclave-control');
    expect(JSON.stringify(agent.volumes)).not.toContain('awf-enclave-private');
    expect(JSON.stringify(agent.environment)).not.toContain('AWF_ENCLAVE');
    expect(JSON.stringify(agent.networks ?? {})).not.toContain(ENCLAVE_AGENT_NETWORK);
  });

  it('creates no enclave network when only the script executor runs', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { script: { enabled: true } },
    });
    const compose = generateDockerCompose(composeConfig({ enclaves }), networkConfig);
    expect(compose.networks[ENCLAVE_AGENT_NETWORK]).toBeUndefined();
    expect(compose.services['enclave-agent-image']).toBeUndefined();
    expect(compose.services['enclave-agent-api-proxy']).toBeUndefined();
    expect(compose.services['enclave-script-image']).toBeDefined();
  });

  it('runs both executors from one server, one socket, and one audit root', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {
        script: { enabled: true },
        agent: { enabled: true, model: 'trusted-model' },
      },
    });
    const compose = generateDockerCompose(composeConfig({ enclaves }), networkConfig);
    const servers = Object.keys(compose.services).filter((name) => name.includes('mcp-server'));
    expect(servers).toEqual(['enclave-mcp-server']);
    const server = compose.services['enclave-mcp-server'] as Record<string, any>;
    expect(server.environment).toMatchObject({
      AWF_ENCLAVE_SCRIPT_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_ENABLED: 'true',
    });
    expect(server.depends_on).toMatchObject({
      'enclave-script-image': { condition: 'service_completed_successfully' },
      'enclave-agent-image': { condition: 'service_completed_successfully' },
      'enclave-agent-api-proxy': { condition: 'service_healthy' },
    });
  });
});
