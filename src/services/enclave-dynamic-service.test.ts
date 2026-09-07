import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { parseImageTag } from '../image-tag';
import type { WrapperConfig } from '../types';
import { buildEnclaveMcpService } from './enclave-mcp-service';
import { buildExclusionSet } from './agent-environment/excluded-vars';
import { typedDynamicEnclavePolicyFixture } from '../enclave/dynamic-policy.test-utils';
import {
  ENCLAVE_SERVER_DELEGATION_CHANNEL_DIR,
  resolveEnclavePaths,
} from '../enclave/paths';

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

const WORK_DIR = '/tmp/awf-dynamic-compose';

function dynamicConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir: WORK_DIR,
    agentCommand: 'echo enclave',
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    enclaves: normalizeEnclavesConfig([
      {
        agent: { model: 'trusted-model' },
        dynamic: typedDynamicEnclavePolicyFixture() as never,
      },
    ]),
    enableApiProxy: true,
    copilotGithubToken: 'copilot-token',
    ...overrides,
  } as WrapperConfig;
}

function staticConfig(): WrapperConfig {
  return {
    workDir: WORK_DIR,
    agentCommand: 'echo enclave',
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    enclaves: normalizeEnclavesConfig([
      { agent: { model: 'trusted-model' }, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]),
    enableApiProxy: true,
    copilotGithubToken: 'copilot-token',
  } as WrapperConfig;
}

function build(config: WrapperConfig) {
  const env = { ...process.env };
  process.env.AWF_ENCLAVE_MCP_GATEWAY_CONTAINER = 'awmg-mcpg';
  process.env.AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT = 'http://127.0.0.1:8080/mcp/awf-enclave';
  process.env.AWF_ENCLAVE_MCP_GATEWAY_IDENTITY = 'gh-aw-42-1-build';
  try {
    return buildEnclaveMcpService({ config, imageConfig: ghcr, networkConfig });
  } finally {
    process.env = env;
  }
}

describe('dynamic enclave compose topology', () => {
  const paths = resolveEnclavePaths(WORK_DIR);

  it('mounts no repository seed and no seed catalog for a dynamic-only entry', () => {
    const service = build(dynamicConfig()).service;
    const volumes = service.volumes as string[];
    expect(volumes.join('\n')).not.toContain(paths.seedsDir);
    expect(volumes.join('\n')).not.toContain(paths.seedMapPath);
    expect(volumes.join('\n')).not.toContain('/srv/awf/seeds');
    expect(volumes.join('\n')).not.toContain('/srv/awf/seed-map.json');
  });

  it('mounts only the private admission channel for the broker', () => {
    const volumes = build(dynamicConfig()).service.volumes as string[];
    expect(volumes).toContain(
      `${paths.delegationChannelDir}:${ENCLAVE_SERVER_DELEGATION_CHANNEL_DIR}:rw`,
    );
  });

  it('never mounts the AWF-private control endpoint or capability into the broker', () => {
    const service = build(dynamicConfig()).service;
    const rendered = JSON.stringify(service);
    expect(rendered).not.toContain(paths.delegationEndpointPath);
    expect(rendered).not.toContain(paths.delegationCapabilityPath);
    expect(rendered).not.toContain(paths.delegationAuditPath);
    expect(rendered).not.toContain('DELEGATION_CONTROL_ENDPOINT');
    expect(rendered).not.toContain('DELEGATION_CONTROL_CAPABILITY');
  });

  it('tells the broker to admit dynamically without a seed catalog', () => {
    const environment = build(dynamicConfig()).service.environment as Record<string, string>;
    expect(environment).toMatchObject({
      AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_DYNAMIC_CHANNEL_DIR: ENCLAVE_SERVER_DELEGATION_CHANNEL_DIR,
      AWF_ENCLAVE_AGENT_DYNAMIC_SENSITIVITY: 'confidential',
      AWF_ENCLAVE_AGENT_DYNAMIC_GITHUB_MCP_URL: 'http://172.31.0.40:8080/mcp/github',
      AWF_ENCLAVE_SEED_MAP_ENABLED: 'false',
      AWF_ENCLAVE_AGENT_GITHUB_ENABLED: 'false',
    });
    expect(environment.AWF_ENCLAVE_AGENT_HOST_SEEDS_DIR).toBeUndefined();
  });

  it('attaches the shared gateway so delegated identities have a data plane', () => {
    const environment = build(dynamicConfig()).service.environment as Record<string, string>;
    expect(environment.AWF_ENCLAVE_AGENT_GITHUB_GATEWAY_CONTAINER).toBe('awmg-mcpg');
  });

  it('keeps the static seed catalog and mounts unchanged', () => {
    const service = build(staticConfig()).service;
    const volumes = service.volumes as string[];
    expect(volumes).toContain(`${paths.seedsDir}:/srv/awf/seeds:ro`);
    expect(volumes).toContain(`${paths.seedMapPath}:/srv/awf/seed-map.json:ro`);
    expect(volumes.join('\n')).not.toContain(ENCLAVE_SERVER_DELEGATION_CHANNEL_DIR);
    const environment = service.environment as Record<string, string>;
    expect(environment.AWF_ENCLAVE_SEED_MAP_ENABLED).toBe('true');
    expect(environment.AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED).toBeUndefined();
  });
});

describe('primary agent environment exclusion', () => {
  it('excludes both halves of the delegation handoff from the primary agent', () => {
    const exclusions = buildExclusionSet(dynamicConfig());
    expect(exclusions.has('AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT')).toBe(true);
    expect(exclusions.has('AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY')).toBe(true);
  });
});
