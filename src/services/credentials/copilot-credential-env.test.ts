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
