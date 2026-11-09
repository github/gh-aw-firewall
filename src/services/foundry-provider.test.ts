import { readEnvFile } from '../github-env';
import { resolveAllowedDomains } from '../commands/preflight';
import { resolveApiTargetsToAllowedDomains } from '../api-proxy-config-domains';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import { WrapperConfig, API_PROXY_PORTS } from '../types';
import { buildAgentEnvironment } from './agent-environment/environment-builder';
import { buildAgentCredentialEnv } from './api-proxy-credential-env';
import { buildProviderTargetEnv, resolveApiProxyUpstreams, testHelpers } from './api-proxy-env-config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('../github-env', () => ({
  ...jest.requireActual('../github-env'),
  readEnvFile: jest.fn(),
}));

const config: WrapperConfig = { ...baseConfig, workDir: process.cwd(), enableApiProxy: true };
const networkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
const foundryEnv = {
  FOUNDRY_API_TARGET: 'https://resource.services.ai.azure.com/openai/v1',
  FOUNDRY_API_BASE_PATH: '/custom/v1',
  FOUNDRY_API_KEY: 'test-foundry-key',
  FOUNDRY_ENTRA_TOKEN: 'test-foundry-token',
};

describe('Foundry host integration', () => {
  const originalEnv = process.env;
  const envFile = 'foundry-provider-test.env';

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of Object.keys(foundryEnv)) delete process.env[name];
    jest.mocked(readEnvFile).mockReturnValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each(['host', 'env-all', 'additional-env', 'env-file'])('isolates %s credentials in the trusted sidecar', (source) => {
    const effectiveConfig = { ...config };
    if (source === 'host' || source === 'env-all') {
      Object.assign(process.env, foundryEnv);
      effectiveConfig.envAll = source === 'env-all';
    } else if (source === 'additional-env') {
      effectiveConfig.additionalEnv = foundryEnv;
    } else {
      jest.mocked(readEnvFile).mockReturnValue(foundryEnv);
      effectiveConfig.envFile = envFile;
    }

    const sidecar = testHelpers.buildCredentialEnv(effectiveConfig);
    const agent = {
      ...buildAgentEnvironment({ config: effectiveConfig, networkConfig, dnsServers: ['8.8.8.8'] }),
      ...buildAgentCredentialEnv({ config: effectiveConfig, networkConfig }),
    };
    expect(sidecar.FOUNDRY_API_KEY).toBe(foundryEnv.FOUNDRY_API_KEY);
    expect(sidecar.FOUNDRY_ENTRA_TOKEN).toBe(foundryEnv.FOUNDRY_ENTRA_TOKEN);
    expect(agent.FOUNDRY_API_KEY).toBeUndefined();
    expect(agent.FOUNDRY_ENTRA_TOKEN).toBeUndefined();
    expect(Object.values(agent)).not.toContain(foundryEnv.FOUNDRY_API_KEY);
    expect(Object.values(agent)).not.toContain(foundryEnv.FOUNDRY_ENTRA_TOKEN);
    expect(agent.FOUNDRY_BASE_URL).toBe('http://172.30.0.30:10005');
    expect(agent.AWF_API_PROXY_FOUNDRY_URL).toBe(agent.FOUNDRY_BASE_URL);
  });

  it('prefers explicit config environment over host values', () => {
    Object.assign(process.env, foundryEnv);
    const effectiveConfig = {
      ...config,
      additionalEnv: {
        FOUNDRY_API_TARGET: 'http://custom.example:8443/path',
        FOUNDRY_API_BASE_PATH: '/override',
        FOUNDRY_API_KEY: 'test-explicit-key',
        FOUNDRY_ENTRA_TOKEN: 'test-explicit-token',
      },
    };
    expect(buildProviderTargetEnv(effectiveConfig)).toMatchObject({
      FOUNDRY_API_TARGET: 'http://custom.example:8443',
      FOUNDRY_API_BASE_PATH: '/override',
    });
    expect(testHelpers.buildCredentialEnv(effectiveConfig)).toMatchObject({
      FOUNDRY_API_KEY: 'test-explicit-key',
      FOUNDRY_ENTRA_TOKEN: 'test-explicit-token',
    });
    expect(resolveApiProxyUpstreams(effectiveConfig)).toContainEqual({ hostname: 'custom.example', port: 8443 });
  });

  it('leaves target and base path unset when not configured and creates no agent routing', () => {
    const routing = buildProviderTargetEnv(config);
    expect(routing.FOUNDRY_API_TARGET).toBeUndefined();
    expect(routing.FOUNDRY_API_BASE_PATH).toBeUndefined();
    expect(buildAgentCredentialEnv({ config, networkConfig }).FOUNDRY_BASE_URL).toBeUndefined();
    expect(API_PROXY_PORTS.FOUNDRY).toBe(10005);
  });

  it('keeps the configured resource at its root unless a base path is explicitly supplied', () => {
    const effectiveConfig = {
      ...config,
      additionalEnv: {
        FOUNDRY_API_TARGET: 'https://resource.services.ai.azure.com',
        FOUNDRY_API_KEY: 'test-foundry-key',
      },
    };
    const routing = buildProviderTargetEnv(effectiveConfig);
    const agent = buildAgentCredentialEnv({ config: effectiveConfig, networkConfig });
    expect(routing.FOUNDRY_API_TARGET).toBe('resource.services.ai.azure.com');
    expect(routing.FOUNDRY_API_BASE_PATH).toBeUndefined();
    expect(agent.FOUNDRY_BASE_URL).toBe('http://172.30.0.30:10005');
    expect(new URL('/providers/microsoft/v1/systemone', agent.FOUNDRY_BASE_URL).href)
      .toBe('http://172.30.0.30:10005/providers/microsoft/v1/systemone');
    expect(new URL('/openai/v1/chat/completions', agent.FOUNDRY_BASE_URL).href)
      .toBe('http://172.30.0.30:10005/openai/v1/chat/completions');
  });

  it('adds only the configured resource target, not a broad Azure domain', () => {
    expect(resolveApiTargetsToAllowedDomains({ enableApiProxy: true }, [], foundryEnv))
      .toEqual(['https://resource.services.ai.azure.com']);
    expect(resolveApiTargetsToAllowedDomains({ enableApiProxy: false }, [], foundryEnv)).toEqual([]);
    expect(resolveApiTargetsToAllowedDomains({ enableApiProxy: true }, [], {})).toEqual([]);
  });

  it.each(['host', 'additional-env', 'env-file'])('resolves %s target during preflight without a new flag', (source) => {
    const options: Record<string, unknown> = { enableApiProxy: true };
    if (source === 'host') Object.assign(process.env, foundryEnv);
    else if (source === 'additional-env') options.additionalEnv = foundryEnv;
    else {
      jest.mocked(readEnvFile).mockReturnValue({ FOUNDRY_API_TARGET: foundryEnv.FOUNDRY_API_TARGET });
      options.envFile = envFile;
    }
    expect(resolveAllowedDomains(options).allowedDomains).toContain('https://resource.services.ai.azure.com');
    expect(resolveAllowedDomains({ ...options, enableApiProxy: false }).allowedDomains)
      .not.toContain('https://resource.services.ai.azure.com');
  });
});
