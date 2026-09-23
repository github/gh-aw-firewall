jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildGeminiCredentialEnv } from './gemini-credential-env';
import type { WrapperConfig } from '../../types';

const baseConfig = {} as WrapperConfig;
const proxyIp = '172.30.0.30';

describe('buildGeminiCredentialEnv', () => {
  it('returns empty object when geminiApiKey is not set', () => {
    const result = buildGeminiCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it('returns env additions when GCP OIDC is configured without geminiApiKey', () => {
    const config = {
      ...baseConfig,
      authType: 'github-oidc',
      authProvider: 'gcp',
      authGcpWorkloadIdentityProvider: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
    } as WrapperConfig;
    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(result.GOOGLE_GEMINI_BASE_URL).toBe(`http://${proxyIp}:10003`);
    expect(result.GEMINI_API_BASE_URL).toBe(`http://${proxyIp}:10003`);
    expect(result.GEMINI_API_KEY).toBe('gemini-api-key-placeholder-for-credential-isolation');
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

// Regression: Gemini CLI >= 0.44 resolves any GOOGLE_GEMINI_BASE_URL to its "gateway"
// auth type, which its own validator rejects ("Invalid auth method selected.", exit 41).
// AWF points the CLI at a system settings file that pins the API-key auth type.
describe('buildGeminiCredentialEnv — Gemini CLI auth-type pinning', () => {
  const config = { ...baseConfig, enableApiProxy: true, geminiApiKey: 'AIza-test' } as WrapperConfig;
  const originalVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  const originalGca = process.env.GOOGLE_GENAI_USE_GCA;

  afterEach(() => {
    if (originalVertex === undefined) delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    else process.env.GOOGLE_GENAI_USE_VERTEXAI = originalVertex;
    if (originalGca === undefined) delete process.env.GOOGLE_GENAI_USE_GCA;
    else process.env.GOOGLE_GENAI_USE_GCA = originalGca;
  });

  it('points GEMINI_CLI_SYSTEM_SETTINGS_PATH at the AWF-owned settings file', () => {
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    delete process.env.GOOGLE_GENAI_USE_GCA;

    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(result.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toMatch(/\.awf\/gemini-cli-system-settings\.json$/);
  });

  it('does not pin the auth type when Vertex AI auth is selected in the agent environment', () => {
    const result = buildGeminiCredentialEnv({
      config: { ...config, additionalEnv: { GOOGLE_GENAI_USE_VERTEXAI: 'true' } },
      proxyIp,
    });
    expect(result.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
  });

  it('does not pin the auth type when Google-account auth is selected in an env file', () => {
    const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-auth-env-')), '.env');
    fs.writeFileSync(envFile, 'GOOGLE_GENAI_USE_GCA=true\n');
    const result = buildGeminiCredentialEnv({
      config: { ...config, envFile },
      proxyIp,
    });
    expect(result.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
    fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
  });

  it('does not use host-only auth flags unless --env-all passes them to the agent', () => {
    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';

    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(result.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeDefined();
  });

  it.each(['sbx', 'cloud-hypervisor'])('does not set the settings path for the %s backend', (containerRuntime) => {
    const result = buildGeminiCredentialEnv({
      config: { ...config, containerRuntime },
      proxyIp,
    });
    expect(result.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
  });

  // The settings file is only written for api-proxy runs, so the env var must use the
  // same gate — otherwise the CLI would be pointed at a path that does not exist.
  it('does not set the settings path when the api-proxy is disabled', () => {
    delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    delete process.env.GOOGLE_GENAI_USE_GCA;

    const result = buildGeminiCredentialEnv({
      config: { ...baseConfig, geminiApiKey: 'AIza-test' } as WrapperConfig,
      proxyIp,
    });
    expect(result.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
  });
});
