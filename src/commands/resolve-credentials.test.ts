import { resolveApiCredentials } from './resolve-credentials';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_BASE_URL',
  'GEMINI_API_KEY',
  'OPENAI_API_TARGET',
  'OPENAI_API_BASE_PATH',
  'ANTHROPIC_API_TARGET',
  'ANTHROPIC_API_BASE_PATH',
  'AWF_OPENAI_AUTH_HEADER',
  'AWF_ANTHROPIC_AUTH_HEADER',
  'AWF_AUTH_ANTHROPIC_TOKEN_URL',
  'AWF_AUTH_TYPE',
  'AWF_AUTH_PROVIDER',
  'AWF_AUTH_OIDC_AUDIENCE',
  'AWF_AUTH_AZURE_TENANT_ID',
  'AWF_AUTH_GCP_SCOPE',
  'GEMINI_API_TARGET',
  'GEMINI_API_BASE_PATH',
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

    const credentials = resolveApiCredentials({});

    expect(credentials.openaiApiKey).toBe('sk-openai');
    expect(credentials.anthropicApiKey).toBe('sk-anthropic');
    expect(credentials.copilotGithubToken).toBe('gh-copilot');
    expect(credentials.copilotProviderApiKey).toBe('sk-provider');
    expect(credentials.geminiApiKey).toBe('sk-gemini');
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
