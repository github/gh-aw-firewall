jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { buildVertexCredentialEnv } from './vertex-credential-env';
import type { WrapperConfig } from '../../types';

const baseConfig = {} as WrapperConfig;
const proxyIp = '172.30.0.30';

describe('buildVertexCredentialEnv', () => {
  it('returns empty object when googleApiKey is not set', () => {
    const result = buildVertexCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it('returns env additions when googleApiKey is set', () => {
    const config = { ...baseConfig, googleApiKey: 'AIza-test-key' } as WrapperConfig;
    const result = buildVertexCredentialEnv({ config, proxyIp });
    expect(result.GOOGLE_VERTEX_BASE_URL).toBe(`http://${proxyIp}:10004`);
    expect(result.GOOGLE_API_KEY).toBe('google-api-key-placeholder-for-credential-isolation');
  });

  it('real googleApiKey is NOT present in agent env (credential isolation)', () => {
    const realKey = 'AIza-real-vertex-secret-key';
    const config = { ...baseConfig, googleApiKey: realKey } as WrapperConfig;
    const result = buildVertexCredentialEnv({ config, proxyIp });
    expect(Object.values(result)).not.toContain(realKey);
  });

  it('routes to Vertex AI port 10004 specifically', () => {
    const config = { ...baseConfig, googleApiKey: 'AIza-test' } as WrapperConfig;
    const result = buildVertexCredentialEnv({ config, proxyIp });
    expect(result.GOOGLE_VERTEX_BASE_URL).toMatch(/:10004$/);
  });
});
