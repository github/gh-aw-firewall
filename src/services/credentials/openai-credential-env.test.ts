jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { buildOpenAiCredentialEnv } from './openai-credential-env';
import type { WrapperConfig } from '../../types';

const baseConfig = {} as WrapperConfig;
const proxyIp = '172.30.0.30';

describe('buildOpenAiCredentialEnv', () => {
  it('returns empty object when openaiApiKey is not set', () => {
    const result = buildOpenAiCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it('returns env additions when openaiApiKey is set', () => {
    const config = { ...baseConfig, openaiApiKey: 'sk-real-key' } as WrapperConfig;
    const result = buildOpenAiCredentialEnv({ config, proxyIp });
    expect(result.OPENAI_BASE_URL).toBe(`http://${proxyIp}:10000`);
    expect(result.OPENAI_API_KEY).toBe('sk-placeholder-for-api-proxy');
    expect(result.CODEX_API_KEY).toBe('sk-placeholder-for-api-proxy');
  });

  it('real openaiApiKey is NOT present in agent env (credential isolation)', () => {
    const realKey = 'sk-real-secret-key';
    const config = { ...baseConfig, openaiApiKey: realKey } as WrapperConfig;
    const result = buildOpenAiCredentialEnv({ config, proxyIp });
    expect(Object.values(result)).not.toContain(realKey);
  });

  it('sets both OPENAI_API_KEY and CODEX_API_KEY for Codex WebSocket auth support', () => {
    const config = { ...baseConfig, openaiApiKey: 'sk-test' } as WrapperConfig;
    const result = buildOpenAiCredentialEnv({ config, proxyIp });
    expect(result.OPENAI_API_KEY).toBeDefined();
    expect(result.CODEX_API_KEY).toBeDefined();
  });

  it('routes to OpenAI port 10000 specifically', () => {
    const config = { ...baseConfig, openaiApiKey: 'sk-test' } as WrapperConfig;
    const result = buildOpenAiCredentialEnv({ config, proxyIp });
    expect(result.OPENAI_BASE_URL).toMatch(/:10000$/);
  });
});
