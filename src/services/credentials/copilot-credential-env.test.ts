jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../env-utils', () => ({
  getLowerCaseProcessEnvValue: jest.fn(),
  getConfigEnvValue: jest.fn(),
}));

import { buildCopilotCredentialEnv } from './copilot-credential-env';
import type { WrapperConfig } from '../../types';
import { getConfigEnvValue } from '../../env-utils';
import { COPILOT_PLACEHOLDER_TOKEN } from '../../constants/placeholders';
import { logger } from '../../logger';

const mockGetConfigEnvValue = getConfigEnvValue as jest.MockedFunction<typeof getConfigEnvValue>;

const baseConfig = {} as WrapperConfig;
const proxyIp = '172.30.0.30';

describe('buildCopilotCredentialEnv', () => {
  beforeEach(() => {
    mockGetConfigEnvValue.mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty object when no copilot credentials configured', () => {
    const result = buildCopilotCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it.each([
    { copilotGithubToken: 'ghu_token' },
    { copilotProviderApiKey: 'provider-key' },
    { copilotProviderBaseUrl: 'https://provider.example.com/v1' },
    { additionalEnv: { COPILOT_PROVIDER_API_KEY: 'provider-key' } },
    { additionalEnv: { COPILOT_PROVIDER_BASE_URL: 'https://provider.example.com/v1' } },
  ])('warns about offline web tools for a domain allowlist with %p', (copilotConfig) => {
    const config = { ...baseConfig, ...copilotConfig, allowedDomains: ['osv.dev'] } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((config, key) => {
      if (key === 'COPILOT_PROVIDER_API_KEY') return config.additionalEnv?.COPILOT_PROVIDER_API_KEY;
      if (key === 'COPILOT_PROVIDER_BASE_URL') return config.additionalEnv?.COPILOT_PROVIDER_BASE_URL;
      return undefined;
    });

    const result = buildCopilotCredentialEnv({ config, proxyIp });

    expect(result.COPILOT_OFFLINE).toBe('true');
    expect(result.COPILOT_PROVIDER_BASE_URL).toBe(`http://${proxyIp}:10002`);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('web_fetch and web_search tools are unavailable'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('--allow-url <host> (or --allow-all-urls)'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AWF still enforces the domain allowlist'));
    expect(Object.values(result)).not.toContain('provider-key');
    expect(Object.values(result)).not.toContain('ghu_token');
  });

  it('does not warn about offline web tools when Copilot is not routed through the proxy', () => {
    const config = { ...baseConfig, allowedDomains: ['osv.dev'] } as WrapperConfig;
    expect(buildCopilotCredentialEnv({ config, proxyIp })).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn about offline web tools when no domains are allowlisted', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token', allowedDomains: [] } as WrapperConfig;
    expect(buildCopilotCredentialEnv({ config, proxyIp }).COPILOT_OFFLINE).toBe('true');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns env additions when copilotGithubToken is set', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_API_URL).toBe(`http://${proxyIp}:10002`);
    expect(result.COPILOT_OFFLINE).toBe('true');
    expect(result.COPILOT_TOKEN).toBe(COPILOT_PLACEHOLDER_TOKEN);
    expect(result.COPILOT_GITHUB_TOKEN).toBe(COPILOT_PLACEHOLDER_TOKEN);
  });

  it('returns env additions when copilotProviderApiKey is set', () => {
    const config = { ...baseConfig, copilotProviderApiKey: 'provider-key' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_API_URL).toBeDefined();
    expect(result.COPILOT_PROVIDER_API_KEY).toBe(COPILOT_PLACEHOLDER_TOKEN);
  });

  it('returns env additions when copilotProviderBaseUrl is set', () => {
    const config = { ...baseConfig, copilotProviderBaseUrl: 'https://openrouter.ai/api' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_API_URL).toBeDefined();
    // Agent always sees the sidecar URL, never the real provider URL
    expect(result.COPILOT_PROVIDER_BASE_URL).toBe(`http://${proxyIp}:10002`);
  });

  it('does NOT set COPILOT_GITHUB_TOKEN placeholder when only providerApiKey is given', () => {
    const config = { ...baseConfig, copilotProviderApiKey: 'provider-key' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it('does NOT set COPILOT_PROVIDER_API_KEY placeholder when no provider key given', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_API_KEY).toBeUndefined();
  });

  it('sets COPILOT_PROVIDER_WIRE_API=responses for gpt-5 model', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((_: unknown, key: string) =>
      key === 'COPILOT_MODEL' ? 'gpt-5' : undefined
    );
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_WIRE_API).toBe('responses');
  });

  it('sets COPILOT_PROVIDER_WIRE_API=responses for o3 model', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((_: unknown, key: string) =>
      key === 'COPILOT_MODEL' ? 'o3-mini' : undefined
    );
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_WIRE_API).toBe('responses');
  });

  it('sets COPILOT_PROVIDER_WIRE_API=responses for openai/gpt-5 prefixed model', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((_: unknown, key: string) =>
      key === 'COPILOT_MODEL' ? 'openai/gpt-5' : undefined
    );
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_WIRE_API).toBe('responses');
  });

  it('preserves an explicitly configured wire API when the model defaults to responses', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((_: unknown, key: string) => {
      if (key === 'COPILOT_MODEL') return 'gpt-5.4-mini';
      if (key === 'COPILOT_PROVIDER_WIRE_API') return 'completions';
      return undefined;
    });
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_WIRE_API).toBeUndefined();
  });

  it('does not set COPILOT_PROVIDER_WIRE_API for non-gpt5/o3 models', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((_: unknown, key: string) =>
      key === 'COPILOT_MODEL' ? 'claude-3-5-sonnet' : undefined
    );
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_WIRE_API).toBeUndefined();
  });

  it('real copilotGithubToken is NOT present in agent env (credential isolation)', () => {
    const realToken = 'ghu_real_secret_token';
    const config = { ...baseConfig, copilotGithubToken: realToken } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(Object.values(result)).not.toContain(realToken);
  });

  it('routes to Copilot port 10002 specifically', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_API_URL).toMatch(/:10002$/);
  });
});
