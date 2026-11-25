import { resolveApiCredentials } from './resolve-credentials';

const ENV_KEYS = [
  'AWF_AGENT_API_KEY',
  'AWF_AGENT_API_PROVIDER',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_TARGET',
  'OPENAI_API_BASE_PATH',
  'ANTHROPIC_API_TARGET',
  'ANTHROPIC_API_BASE_PATH',
  'AWF_OPENAI_AUTH_HEADER',
  'AWF_ANTHROPIC_AUTH_HEADER',
  'AWF_OPENAI_AUTH_SCHEME',
  'AWF_ANTHROPIC_AUTH_SCHEME',
  'AWF_AUTH_DATABRICKS_HOST',
  'AWF_AUTH_DATABRICKS_CLIENT_ID',
  'AWF_AUTH_ANTHROPIC_TOKEN_URL',
  'AWF_AUTH_TYPE',
  'AWF_AUTH_PROVIDER',
  'AWF_AUTH_OIDC_AUDIENCE',
  'AWF_AUTH_AZURE_TENANT_ID',
  'AWF_AUTH_GCP_SCOPE',
  'GEMINI_API_TARGET',
  'GEMINI_API_BASE_PATH',
  'VERTEX_API_TARGET',
  'VERTEX_API_BASE_PATH',
  'GITHUB_TOKEN',
  'GH_TOKEN',
] as const;

describe('resolveApiCredentials', () => {
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('reads provider API keys directly from the environment', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
    process.env.COPILOT_GITHUB_TOKEN = 'gh-copilot';
    process.env.COPILOT_PROVIDER_API_KEY = 'sk-provider';
    process.env.GEMINI_API_KEY = 'sk-gemini';
    process.env.GOOGLE_API_KEY = 'sk-google';

    const credentials = resolveApiCredentials({});

    expect(credentials.openaiApiKey).toBe('sk-openai');
    expect(credentials.anthropicApiKey).toBe('sk-anthropic');
    expect(credentials.copilotGithubToken).toBe('gh-copilot');
    expect(credentials.copilotProviderApiKey).toBe('sk-provider');
    expect(credentials.geminiApiKey).toBe('sk-gemini');
    expect(credentials.googleApiKey).toBe('sk-google');
  });

  it('resolves all credential fallbacks from an injected environment', () => {
    const credentials = resolveApiCredentials({}, {}, Object.freeze({
      AWF_AGENT_API_KEY: 'test-neutral',
      AWF_AGENT_API_PROVIDER: 'vertex',
      OPENAI_API_KEY: 'test-openai',
      ANTHROPIC_API_KEY: 'test-anthropic',
      COPILOT_GITHUB_TOKEN: 'test-copilot',
      COPILOT_PROVIDER_API_KEY: 'test-provider',
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: 'https://provider.example.com',
      GEMINI_API_KEY: 'test-gemini',
      OPENAI_API_TARGET: 'https://openai.example.com',
      OPENAI_BASE_URL_ENV: 'CUSTOM_BASE_URL',
      OPENAI_API_BASE_PATH: '/openai',
      ANTHROPIC_API_TARGET: 'https://anthropic.example.com',
      ANTHROPIC_API_BASE_PATH: '/anthropic',
      GEMINI_API_TARGET: 'https://gemini.example.com',
      GEMINI_API_BASE_PATH: '/gemini',
      VERTEX_API_TARGET: 'https://vertex.example.com',
      VERTEX_API_BASE_PATH: '/vertex',
      AWF_OPENAI_AUTH_HEADER: 'X-Openai-Auth',
      AWF_OPENAI_AUTH_SCHEME: 'Bearer',
      AWF_ANTHROPIC_AUTH_HEADER: 'X-Anthropic-Auth',
      AWF_ANTHROPIC_AUTH_SCHEME: 'Basic',
      AWF_AUTH_ANTHROPIC_TOKEN_URL: 'https://anthropic.example.com/token',
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'databricks',
      AWF_AUTH_OIDC_AUDIENCE: 'test-audience',
      AWF_AUTH_DATABRICKS_HOST: 'https://test.databricks.com',
      AWF_AUTH_DATABRICKS_CLIENT_ID: 'test-client',
      GH_TOKEN: 'test-github',
    }));

    expect(credentials).toMatchObject({
      openaiApiKey: 'test-openai',
      anthropicApiKey: 'test-anthropic',
      copilotGithubToken: 'test-copilot',
      copilotProviderApiKey: 'test-provider',
      copilotProviderType: 'openai',
      copilotProviderBaseUrl: 'https://provider.example.com',
      geminiApiKey: 'test-gemini',
      googleApiKey: 'test-neutral',
      openaiApiTarget: 'https://openai.example.com',
      openaiBaseUrlEnv: 'CUSTOM_BASE_URL',
      openaiApiBasePath: '/openai',
      anthropicApiTarget: 'https://anthropic.example.com',
      anthropicApiBasePath: '/anthropic',
      geminiApiTarget: 'https://gemini.example.com',
      geminiApiBasePath: '/gemini',
      vertexApiTarget: 'https://vertex.example.com',
      vertexApiBasePath: '/vertex',
      openaiApiAuthHeader: 'X-Openai-Auth',
      openaiApiAuthScheme: 'Bearer',
      anthropicApiAuthHeader: 'X-Anthropic-Auth',
      anthropicApiAuthScheme: 'Basic',
      anthropicTokenUrl: 'https://anthropic.example.com/token',
      authType: 'github-oidc',
      authProvider: 'databricks',
      authOidcAudience: 'test-audience',
      authDatabricksHost: 'https://test.databricks.com',
      authDatabricksClientId: 'test-client',
      githubToken: 'test-github',
    });
  });

  it('maps Databricks OIDC env values and honors explicit option precedence', () => {
    process.env.AWF_AUTH_TYPE = 'github-oidc';
    process.env.AWF_AUTH_PROVIDER = 'databricks';
    process.env.AWF_AUTH_OIDC_AUDIENCE = 'env-audience';
    process.env.AWF_AUTH_DATABRICKS_HOST = 'https://env.cloud.databricks.com';
    process.env.AWF_AUTH_DATABRICKS_CLIENT_ID = 'env-client';
    expect(resolveApiCredentials({})).toMatchObject({
      authType: 'github-oidc',
      authProvider: 'databricks',
      authOidcAudience: 'env-audience',
      authDatabricksHost: 'https://env.cloud.databricks.com',
      authDatabricksClientId: 'env-client',
    });
    expect(resolveApiCredentials({
      authDatabricksHost: 'https://config.cloud.databricks.com',
      authDatabricksClientId: 'config-client',
      authOidcAudience: 'config-audience',
    })).toMatchObject({
      authDatabricksHost: 'https://config.cloud.databricks.com',
      authDatabricksClientId: 'config-client',
      authOidcAudience: 'config-audience',
    });
  });

  it('maps auth scheme env values and honors explicit option precedence', () => {
    process.env.AWF_OPENAI_AUTH_SCHEME = 'Bearer';
    process.env.AWF_ANTHROPIC_AUTH_SCHEME = 'Basic';
    expect(resolveApiCredentials({})).toMatchObject({
      openaiApiAuthScheme: 'Bearer',
      anthropicApiAuthScheme: 'Basic',
    });
    expect(resolveApiCredentials({ openaiApiAuthScheme: 'Custom', anthropicApiAuthScheme: 'Bearer' })).toMatchObject({
      openaiApiAuthScheme: 'Custom',
      anthropicApiAuthScheme: 'Bearer',
    });
  });

  it.each(['', 'Bearer ', 'two tokens', 'Bearer\n', 'Bearer\r\nInjected:', 'bëarer'])(
    'rejects invalid auth scheme %j from options and host env',
    (scheme) => {
      expect(() => resolveApiCredentials({ openaiApiAuthScheme: scheme })).toThrow(/auth scheme/);
      expect(() => resolveApiCredentials({ anthropicApiAuthScheme: scheme })).toThrow(/auth scheme/);
      process.env.AWF_OPENAI_AUTH_SCHEME = scheme;
      expect(() => resolveApiCredentials({})).toThrow(/auth scheme/);
    },
  );

  describe('neutral API key fallback', () => {
    const providers = [
      ['openai', 'openaiApiKey', 'OPENAI_API_KEY'],
      ['anthropic', 'anthropicApiKey', 'ANTHROPIC_API_KEY'],
      ['copilot', 'copilotProviderApiKey', 'COPILOT_PROVIDER_API_KEY'],
      ['gemini', 'geminiApiKey', 'GEMINI_API_KEY'],
      ['vertex', 'googleApiKey', 'GOOGLE_API_KEY'],
    ] as const;

    it.each(providers)('routes the neutral key only to %s', (provider, configKey) => {
      process.env.AWF_AGENT_API_KEY = 'test-neutral-key';
      process.env.AWF_AGENT_API_PROVIDER = provider;

      const credentials = resolveApiCredentials({ enableApiProxy: true });

      expect(credentials[configKey]).toBe('test-neutral-key');
      for (const [, otherConfigKey] of providers) {
        if (otherConfigKey !== configKey) {
          expect(credentials[otherConfigKey]).toBeUndefined();
        }
      }
      expect(credentials.copilotGithubToken).toBeUndefined();
    });

    it.each(providers)('prefers the native key for %s', (provider, configKey, envKey) => {
      process.env.AWF_AGENT_API_KEY = 'test-neutral-key';
      process.env.AWF_AGENT_API_PROVIDER = provider;
      process.env[envKey] = 'test-native-key';

      expect(resolveApiCredentials({ enableApiProxy: true })[configKey]).toBe('test-native-key');
    });

    it.each(providers)('falls back when the native key for %s is empty', (provider, configKey, envKey) => {
      process.env.AWF_AGENT_API_KEY = 'test-neutral-key';
      process.env.AWF_AGENT_API_PROVIDER = provider;
      process.env[envKey] = '';

      expect(resolveApiCredentials({ enableApiProxy: true })[configKey]).toBe('test-neutral-key');
    });

    it('normalizes provider selection and trims the neutral key', () => {
      process.env.AWF_AGENT_API_KEY = ' test-neutral-key ';
      process.env.AWF_AGENT_API_PROVIDER = ' OpenAI ';

      expect(resolveApiCredentials({ enableApiProxy: true }).openaiApiKey).toBe('test-neutral-key');
    });

    it('accepts the neutral key when the API proxy option is omitted', () => {
      process.env.AWF_AGENT_API_KEY = 'test-neutral-key';
      process.env.AWF_AGENT_API_PROVIDER = 'openai';

      expect(resolveApiCredentials({}).openaiApiKey).toBe('test-neutral-key');
    });

    it.each([undefined, '', 'unknown', 'azure'])('rejects missing or unsupported provider %s without exposing the key', (provider) => {
      process.env.AWF_AGENT_API_KEY = 'test-neutral-key';
      if (provider !== undefined) process.env.AWF_AGENT_API_PROVIDER = provider;

      expect(() => resolveApiCredentials({ enableApiProxy: true })).toThrow(
        'AWF_AGENT_API_KEY requires AWF_AGENT_API_PROVIDER to be openai, anthropic, copilot, gemini, or vertex'
      );
    });

    it('ignores the alias when API proxy is disabled', () => {
      process.env.AWF_AGENT_API_KEY = 'test-neutral-key';

      expect(resolveApiCredentials({ enableApiProxy: false }).openaiApiKey).toBeUndefined();
    });

    it('ignores an empty alias without requiring a provider', () => {
      process.env.AWF_AGENT_API_KEY = ' ';

      expect(resolveApiCredentials({ enableApiProxy: true }).openaiApiKey).toBeUndefined();
    });
  });

  it('prefers explicit options over environment fallbacks', () => {
    process.env.COPILOT_PROVIDER_TYPE = 'env-type';
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://env-router.example.com/v1';
    process.env.OPENAI_API_TARGET = 'https://env-openai.example.com';
    process.env.AWF_AUTH_TYPE = 'env-auth';
    process.env.AWF_AUTH_AZURE_TENANT_ID = 'env-tenant';

    const credentials = resolveApiCredentials({
      copilotProviderType: 'azure',
      copilotProviderBaseUrl: 'https://config-router.example.com/v1',
      openaiApiTarget: 'https://config-openai.example.com',
      authType: 'github-oidc',
      authAzureTenantId: 'config-tenant',
    });

    expect(credentials.copilotProviderType).toBe('azure');
    expect(credentials.copilotProviderBaseUrl).toBe('https://config-router.example.com/v1');
    expect(credentials.openaiApiTarget).toBe('https://config-openai.example.com');
    expect(credentials.authType).toBe('github-oidc');
    expect(credentials.authAzureTenantId).toBe('config-tenant');
  });

  it('resolves oidc-related environment mappings', () => {
    process.env.AWF_AUTH_PROVIDER = 'gcp';
    process.env.AWF_AUTH_OIDC_AUDIENCE = 'https://github.com/github';
    process.env.AWF_AUTH_GCP_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

    const credentials = resolveApiCredentials({});

    expect(credentials.authProvider).toBe('gcp');
    expect(credentials.authOidcAudience).toBe('https://github.com/github');
    expect(credentials.authGcpScope).toBe('https://www.googleapis.com/auth/cloud-platform');
  });

  it('treats explicitly provided empty string as authoritative over env var', () => {
    process.env.OPENAI_API_BASE_PATH = '/env-base-path';
    process.env.ANTHROPIC_API_BASE_PATH = '/env-anthropic-base';
    process.env.GEMINI_API_BASE_PATH = '/env-gemini-base';
    process.env.VERTEX_API_BASE_PATH = '/env-vertex-base';

    const credentials = resolveApiCredentials({
      openaiApiBasePath: '',
      anthropicApiBasePath: '',
      geminiApiBasePath: '',
      vertexApiBasePath: '',
    });

    expect(credentials.openaiApiBasePath).toBe('');
    expect(credentials.anthropicApiBasePath).toBe('');
    expect(credentials.geminiApiBasePath).toBe('');
    expect(credentials.vertexApiBasePath).toBe('');
  });

  it('passes through resolved copilot endpoints and github token precedence', () => {
    process.env.GITHUB_TOKEN = 'github-token';
    process.env.GH_TOKEN = 'gh-token';

    const credentials = resolveApiCredentials({}, {
      resolvedCopilotApiTarget: 'https://copilot.example.com',
      resolvedCopilotApiBasePath: '/v1/chat/completions',
    });

    expect(credentials.copilotApiTarget).toBe('https://copilot.example.com');
    expect(credentials.copilotApiBasePath).toBe('/v1/chat/completions');
    expect(credentials.githubToken).toBe('github-token');
  });
});
