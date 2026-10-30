import { baseConfig as baseFixture } from '../test-helpers/docker-test-fixtures.test-utils';
import { buildProviderTargetEnv, resolveApiProxyUpstreams } from './api-proxy-env-config';
import { generateSquidConfig } from '../squid-config';
import { readEnvFile } from '../github-env';
import { normalizeApiTargetScheme } from '../host-env';
import { resolveCopilotApiRouting } from '../copilot-api-resolver';

jest.mock('../github-env', () => ({ readEnvFile: jest.fn(() => ({})) }));

describe('effective API proxy upstreams', () => {
  const baseConfig = { ...baseFixture, workDir: process.cwd() };
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {};
    jest.mocked(readEnvFile).mockReturnValue({});
  });
  afterEach(() => { process.env = originalEnv; });

  it.each([
    ['http://gateway.example:11434', 'http://gateway.example:11434', 11434],
    ['https://gateway.example:8443', 'gateway.example:8443', 8443],
    ['http://gateway.example:80', 'http://gateway.example', 80],
    ['https://gateway.example:443', 'gateway.example', 443],
    ['gateway.example', 'gateway.example', 443],
  ])('preserves the effective authority for %s', (target, normalized, port) => {
    const config = { ...baseConfig, openaiApiTarget: target, openaiApiBasePath: '/v1' };
    expect(normalizeApiTargetScheme(target)).toBe(normalized);
    expect(buildProviderTargetEnv(config)).toMatchObject({
      OPENAI_API_TARGET: normalized, OPENAI_API_BASE_PATH: '/v1',
    });
    expect(resolveApiProxyUpstreams(config)).toEqual([{ hostname: 'gateway.example', port }]);
  });

  it('uses config, additionalEnv, env-file and host fallback in the same order as sidecar routing', () => {
    process.env.OPENAI_API_TARGET = 'host.example:4444';
    jest.mocked(readEnvFile).mockReturnValue({ OPENAI_API_TARGET: 'file.example:5555' });
    const config = { ...baseConfig, envFile: 'upstream.env' };
    expect(resolveApiProxyUpstreams(config)).toEqual([{ hostname: 'file.example', port: 5555 }]);
    expect(resolveApiProxyUpstreams({ ...config, additionalEnv: { OPENAI_API_TARGET: 'extra.example:6666' } }))
      .toEqual([{ hostname: 'extra.example', port: 6666 }]);
    expect(resolveApiProxyUpstreams({ ...config, openaiApiTarget: 'config.example:7777' }))
      .toEqual([{ hostname: 'config.example', port: 7777 }]);
    expect(resolveApiProxyUpstreams(baseConfig)).toEqual([{ hostname: 'host.example', port: 4444 }]);
  });

  it('gives the secret URL priority over explicit targets and endpoint overrides without losing /v1', () => {
    process.env.PRIVATE_ENDPOINT = 'http://secret.example:11434/v1/';
    process.env.OPENAI_ENDPOINT_OVERRIDE = 'ignored.example:8443';
    const config = { ...baseConfig, openaiBaseUrlEnv: 'PRIVATE_ENDPOINT', openaiApiTarget: 'also-ignored.example' };
    expect(buildProviderTargetEnv(config)).toMatchObject({
      OPENAI_API_TARGET: 'http://secret.example:11434', OPENAI_API_BASE_PATH: '/v1',
    });
    expect(resolveApiProxyUpstreams(config)).toEqual([{ hostname: 'secret.example', port: 11434 }]);
    expect(resolveApiProxyUpstreams({ ...baseConfig }))
      .toEqual([{ hostname: 'ignored.example', port: 8443 }]);
  });

  it('preserves Copilot provider scheme, custom port and base path', () => {
    const providerUrl = 'http://copilot.example:11434/v1/';
    expect(resolveCopilotApiRouting({}, { COPILOT_PROVIDER_BASE_URL: providerUrl })).toEqual({
      copilotApiTarget: 'http://copilot.example:11434', copilotApiBasePath: '/v1',
    });
    const config = { ...baseConfig, copilotProviderBaseUrl: providerUrl };
    expect(buildProviderTargetEnv(config)).toMatchObject({
      COPILOT_API_TARGET: 'http://copilot.example:11434', COPILOT_API_BASE_PATH: '/v1',
    });
    expect(resolveApiProxyUpstreams(config)).toEqual([{ hostname: 'copilot.example', port: 11434 }]);
  });

  it('extracts all provider targets and deduplicates identical endpoints', () => {
    const config = {
      ...baseConfig, openaiApiTarget: 'same.example:8443', anthropicApiTarget: 'same.example:8443',
      geminiApiTarget: 'gemini.example:8443', vertexApiTarget: 'http://vertex.example:11434',
    };
    expect(resolveApiProxyUpstreams(config)).toEqual([
      { hostname: 'same.example', port: 8443 }, { hostname: 'gemini.example', port: 8443 },
      { hostname: 'vertex.example', port: 11434 },
    ]);
  });

  it('authorizes the Azure OpenAI fallback independently of an explicit Copilot target', () => {
    const config = {
      ...baseConfig, copilotProviderType: 'Azure', copilotApiTarget: 'copilot.example',
      copilotProviderBaseUrl: 'https://azure.example:8443/v1',
    };
    expect(buildProviderTargetEnv(config)).toMatchObject({
      COPILOT_API_TARGET: 'copilot.example',
      OPENAI_API_TARGET: 'azure.example:8443',
      OPENAI_API_BASE_PATH: '/v1',
    });
    expect(resolveApiProxyUpstreams(config)).toEqual([
      { hostname: 'copilot.example', port: 443 }, { hostname: 'azure.example', port: 8443 },
    ]);
    expect(buildProviderTargetEnv({ ...config, openaiApiBasePath: '/explicit' }).OPENAI_API_BASE_PATH)
      .toBe('/explicit');
    expect(buildProviderTargetEnv({ ...config, openaiApiTarget: 'openai.example:9443' }).OPENAI_API_TARGET)
      .toBe('openai.example:9443');
  });

  it.each(['127.0.0.1:11434', '[::1]:11434'])('never creates a raw-IP exception for %s', target => {
    expect(resolveApiProxyUpstreams({ ...baseConfig, openaiApiTarget: target })).toEqual([]);
  });

  it.each(['gateway.example:22', 'ftp://gateway.example:8443'])(
    'does not permit unsafe upstream %s', target => {
      expect(() => generateSquidConfig({
        domains: [], port: 3128, apiProxyIp: '172.30.0.30',
        apiProxyUpstreams: resolveApiProxyUpstreams({ ...baseConfig, openaiApiTarget: target }),
      })).toThrow();
    }
  );
});
