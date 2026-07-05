jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { buildGeminiCredentialEnv } from './gemini-credential-env';
import type { WrapperConfig } from '../../types';

const baseConfig = {} as WrapperConfig;
const proxyIp = '172.30.0.30';

describe('buildGeminiCredentialEnv', () => {
  it('returns empty object when geminiApiKey is not set', () => {
    const result = buildGeminiCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it('returns env additions when geminiApiKey is set', () => {
    const config = { ...baseConfig, geminiApiKey: 'AIza-test-key' } as WrapperConfig;
    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(result.GOOGLE_GEMINI_BASE_URL).toBe(`http://${proxyIp}:10003`);
    expect(result.GEMINI_API_BASE_URL).toBe(`http://${proxyIp}:10003`);
    expect(result.GEMINI_API_KEY).toBe('gemini-api-key-placeholder-for-credential-isolation');
  });

  it('real geminiApiKey is NOT present in agent env (credential isolation)', () => {
    const realKey = 'AIza-real-secret-key';
    const config = { ...baseConfig, geminiApiKey: realKey } as WrapperConfig;
    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(Object.values(result)).not.toContain(realKey);
  });

  it('sets both GOOGLE_GEMINI_BASE_URL and GEMINI_API_BASE_URL for backward compatibility', () => {
    const config = { ...baseConfig, geminiApiKey: 'AIza-test' } as WrapperConfig;
    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(result.GOOGLE_GEMINI_BASE_URL).toBeDefined();
    expect(result.GEMINI_API_BASE_URL).toBeDefined();
    expect(result.GOOGLE_GEMINI_BASE_URL).toBe(result.GEMINI_API_BASE_URL);
  });

  it('routes to Gemini port 10003 specifically', () => {
    const config = { ...baseConfig, geminiApiKey: 'AIza-test' } as WrapperConfig;
    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(result.GOOGLE_GEMINI_BASE_URL).toMatch(/:10003$/);
  });
});
