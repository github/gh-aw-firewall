import { baseConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import {
  testHelpers,
  buildApiProxyBaseEnv,
} from './api-proxy-env-config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const {
  buildCredentialEnv,
  buildProviderRoutingEnv,
  buildProxyRoutingEnv,
  buildOtelEnv,
  buildRateLimitEnv,
  buildModelPolicyEnv,
  buildOidcEnv,
} = testHelpers;

const networkConfig = {
  subnet: '172.30.0.0/24',
  squidIp: '172.30.0.10',
  agentIp: '172.30.0.20',
  proxyIp: '172.30.0.30',
};

describe('buildCredentialEnv', () => {
  it('includes OpenAI API key when set', () => {
    const env = buildCredentialEnv({ ...baseConfig, workDir: '/tmp/awf-test', openaiApiKey: 'sk-openai-test' });
    expect(env.OPENAI_API_KEY).toBe('sk-openai-test');
  });

  it('includes Anthropic API key when set', () => {
    const env = buildCredentialEnv({ ...baseConfig, workDir: '/tmp/awf-test', anthropicApiKey: 'sk-ant-test' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  });

  it('includes Copilot GitHub token when set', () => {
    const env = buildCredentialEnv({ ...baseConfig, workDir: '/tmp/awf-test', copilotGithubToken: 'ghu_test_token' });
    expect(env.COPILOT_GITHUB_TOKEN).toBe('ghu_test_token');
  });

  it('includes Gemini API key when set', () => {
    const env = buildCredentialEnv({ ...baseConfig, workDir: '/tmp/awf-test', geminiApiKey: 'gemini-test-key' });
    expect(env.GEMINI_API_KEY).toBe('gemini-test-key');
  });

  it('includes Google (Vertex) API key when set', () => {
    const env = buildCredentialEnv({ ...baseConfig, workDir: '/tmp/awf-test', googleApiKey: 'google-test-key' });
    expect(env.GOOGLE_API_KEY).toBe('google-test-key');
  });

  it('omits keys that are not set', () => {
    const env = buildCredentialEnv({ ...baseConfig, workDir: '/tmp/awf-test' });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
  });

  it('does not leak credential keys as unexpected fields', () => {
    const env = buildCredentialEnv({ ...baseConfig, workDir: '/tmp/awf-test', openaiApiKey: 'sk-only' });
    expect(Object.keys(env)).toEqual(['OPENAI_API_KEY']);
  });
});

describe('buildProviderRoutingEnv', () => {
  it('strips scheme from Copilot API target', () => {
    const env = buildProviderRoutingEnv({ ...baseConfig, workDir: '/tmp/awf-test', copilotApiTarget: 'https://api.githubcopilot.com' });
    expect(env.COPILOT_API_TARGET).toBe('api.githubcopilot.com');
  });

  it('forwards GITHUB_SERVER_URL from process.env when set', () => {
    const saved = process.env.GITHUB_SERVER_URL;
    process.env.GITHUB_SERVER_URL = 'https://github.mycompany.com';
    try {
      const env = buildProviderRoutingEnv({ ...baseConfig, workDir: '/tmp/awf-test' });
      expect(env.GITHUB_SERVER_URL).toBe('https://github.mycompany.com');
    } finally {
      if (saved !== undefined) process.env.GITHUB_SERVER_URL = saved;
      else delete process.env.GITHUB_SERVER_URL;
    }
  });

  it('omits GITHUB_SERVER_URL when not set', () => {
    const saved = process.env.GITHUB_SERVER_URL;
    delete process.env.GITHUB_SERVER_URL;
    try {
      const env = buildProviderRoutingEnv({ ...baseConfig, workDir: '/tmp/awf-test' });
      expect(env.GITHUB_SERVER_URL).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.GITHUB_SERVER_URL = saved;
    }
  });

  it('forwards AWF_PLATFORM_TYPE when set on config', () => {
    const env = buildProviderRoutingEnv({ ...baseConfig, workDir: '/tmp/awf-test', platformType: 'ghec' });
    expect(env.AWF_PLATFORM_TYPE).toBe('ghec');
  });

  it('forwards GITHUB_API_URL from process.env when set', () => {
    const saved = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = 'https://api.mycompany.ghe.com';
    try {
      const env = buildProviderRoutingEnv({ ...baseConfig, workDir: '/tmp/awf-test' });
      expect(env.GITHUB_API_URL).toBe('https://api.mycompany.ghe.com');
    } finally {
      if (saved !== undefined) process.env.GITHUB_API_URL = saved;
      else delete process.env.GITHUB_API_URL;
    }
  });

  it('forwards COPILOT_INTEGRATION_ID trimmed when set in additionalEnv', () => {
    const env = buildProviderRoutingEnv({
      ...baseConfig,
      workDir: '/tmp/awf-test',
      additionalEnv: { COPILOT_INTEGRATION_ID: '  my-integration  ' },
    });
    expect(env.COPILOT_INTEGRATION_ID).toBe('my-integration');
  });

  it('omits COPILOT_INTEGRATION_ID when whitespace-only', () => {
    const env = buildProviderRoutingEnv({
      ...baseConfig,
      workDir: '/tmp/awf-test',
      additionalEnv: { COPILOT_INTEGRATION_ID: '   ' },
    });
    expect(env.COPILOT_INTEGRATION_ID).toBeUndefined();
  });
});

describe('buildProxyRoutingEnv', () => {
  it('sets HTTP_PROXY and HTTPS_PROXY to point to Squid', () => {
    const env = buildProxyRoutingEnv(networkConfig);
    expect(env.HTTP_PROXY).toBe('http://172.30.0.10:3128');
    expect(env.HTTPS_PROXY).toBe('http://172.30.0.10:3128');
    expect(env.https_proxy).toBe('http://172.30.0.10:3128');
  });

  it('sets NO_PROXY to exclude localhost addresses', () => {
    const env = buildProxyRoutingEnv(networkConfig);
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
  });

  it('uses the configured squidIp', () => {
    const env = buildProxyRoutingEnv({ ...networkConfig, squidIp: '192.168.1.10' });
    expect(env.HTTP_PROXY).toBe('http://192.168.1.10:3128');
  });
});

describe('buildOtelEnv', () => {
  let savedEnv: Record<string, string | undefined>;
  const otelVars = [
    'GH_AW_OTLP_ENDPOINTS',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'GITHUB_AW_OTEL_TRACE_ID',
    'GITHUB_AW_OTEL_PARENT_SPAN_ID',
    'OTEL_SERVICE_NAME',
  ];

  beforeEach(() => {
    savedEnv = {};
    for (const key of otelVars) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of otelVars) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  it('defaults OTEL_SERVICE_NAME to awf-api-proxy', () => {
    const env = buildOtelEnv();
    expect(env.OTEL_SERVICE_NAME).toBe('awf-api-proxy');
  });

  it('uses OTEL_SERVICE_NAME from process.env when set', () => {
    process.env.OTEL_SERVICE_NAME = 'custom-service';
    const env = buildOtelEnv();
    expect(env.OTEL_SERVICE_NAME).toBe('custom-service');
  });

  it('forwards OTEL_EXPORTER_OTLP_ENDPOINT when set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com';
    const env = buildOtelEnv();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://otel.example.com');
  });

  it('forwards GITHUB_AW_OTEL_TRACE_ID and GITHUB_AW_OTEL_PARENT_SPAN_ID when set', () => {
    process.env.GITHUB_AW_OTEL_TRACE_ID = 'trace-abc';
    process.env.GITHUB_AW_OTEL_PARENT_SPAN_ID = 'span-xyz';
    const env = buildOtelEnv();
    expect(env.GITHUB_AW_OTEL_TRACE_ID).toBe('trace-abc');
    expect(env.GITHUB_AW_OTEL_PARENT_SPAN_ID).toBe('span-xyz');
  });

  it('omits optional OTEL vars when not set in process.env', () => {
    const env = buildOtelEnv();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.GH_AW_OTLP_ENDPOINTS).toBeUndefined();
    expect(env.GITHUB_AW_OTEL_TRACE_ID).toBeUndefined();
  });
});

describe('buildRateLimitEnv', () => {
  it('sets AWF_RATE_LIMIT_* vars when rateLimitConfig is provided', () => {
    const env = buildRateLimitEnv({
      ...baseConfig,
      workDir: '/tmp/awf-test',
      rateLimitConfig: { enabled: true, rpm: 30, rph: 500, bytesPm: 10485760 },
    });
    expect(env.AWF_RATE_LIMIT_ENABLED).toBe('true');
    expect(env.AWF_RATE_LIMIT_RPM).toBe('30');
    expect(env.AWF_RATE_LIMIT_RPH).toBe('500');
    expect(env.AWF_RATE_LIMIT_BYTES_PM).toBe('10485760');
  });

  it('omits rate limit vars when rateLimitConfig is not provided', () => {
    const env = buildRateLimitEnv({ ...baseConfig, workDir: '/tmp/awf-test' });
    expect(env.AWF_RATE_LIMIT_ENABLED).toBeUndefined();
    expect(env.AWF_RATE_LIMIT_RPM).toBeUndefined();
  });

  it('sets AWF_MAX_EFFECTIVE_TOKENS when configured', () => {
    const env = buildRateLimitEnv({ ...baseConfig, workDir: '/tmp/awf-test', maxEffectiveTokens: 5000 });
    expect(env.AWF_MAX_EFFECTIVE_TOKENS).toBe('5000');
  });

  it('sets AWF_MAX_AI_CREDITS when configured', () => {
    const env = buildRateLimitEnv({ ...baseConfig, workDir: '/tmp/awf-test', maxAiCredits: 1.25 });
    expect(env.AWF_MAX_AI_CREDITS).toBe('1.25');
  });

  it('sets AWF_MAX_RUNS when configured', () => {
    const env = buildRateLimitEnv({ ...baseConfig, workDir: '/tmp/awf-test', maxRuns: 25 });
    expect(env.AWF_MAX_RUNS).toBe('25');
  });

  it('sets AWF_MAX_PERMISSION_DENIED when configured', () => {
    const env = buildRateLimitEnv({ ...baseConfig, workDir: '/tmp/awf-test', maxPermissionDenied: 3 });
    expect(env.AWF_MAX_PERMISSION_DENIED).toBe('3');
  });

  it('sets AWF_MAX_CACHE_MISSES when configured', () => {
    const env = buildRateLimitEnv({ ...baseConfig, workDir: '/tmp/awf-test', maxCacheMisses: 3 });
    expect(env.AWF_MAX_CACHE_MISSES).toBe('3');
  });

  it('sets AWF_AGENT_TIMEOUT_MINUTES when configured', () => {
    const env = buildRateLimitEnv({ ...baseConfig, workDir: '/tmp/awf-test', agentTimeout: 30 });
    expect(env.AWF_AGENT_TIMEOUT_MINUTES).toBe('30');
  });

  it('sets AWF_MAX_MODEL_MULTIPLIER when maxModelMultiplierCap is configured', () => {
    const env = buildRateLimitEnv({ ...baseConfig, workDir: '/tmp/awf-test', maxModelMultiplierCap: 5 });
    expect(env.AWF_MAX_MODEL_MULTIPLIER).toBe('5');
  });
});

describe('buildModelPolicyEnv', () => {
  it('sets AWF_MODEL_ALIASES when modelAliases is configured', () => {
    const env = buildModelPolicyEnv({ ...baseConfig, workDir: '/tmp/awf-test', modelAliases: { 'fast': ['gpt-4o-mini'] } });
    expect(env.AWF_MODEL_ALIASES).toBe('{"models":{"fast":["gpt-4o-mini"]}}');
  });

  it('sets AWF_MODEL_FALLBACK when modelFallback is configured', () => {
    const env = buildModelPolicyEnv({
      ...baseConfig,
      workDir: '/tmp/awf-test',
      modelFallback: { enabled: false, strategy: 'middle_power' as const },
    });
    expect(env.AWF_MODEL_FALLBACK).toBe('{"enabled":false,"strategy":"middle_power"}');
  });

  it('sets AWF_ALLOWED_MODELS when allowedModels is non-empty', () => {
    const env = buildModelPolicyEnv({ ...baseConfig, workDir: '/tmp/awf-test', allowedModels: ['gpt-4o', 'claude-3-5-sonnet'] });
    expect(env.AWF_ALLOWED_MODELS).toBe('["gpt-4o","claude-3-5-sonnet"]');
  });

  it('omits AWF_ALLOWED_MODELS when allowedModels is empty', () => {
    const env = buildModelPolicyEnv({ ...baseConfig, workDir: '/tmp/awf-test', allowedModels: [] });
    expect(env.AWF_ALLOWED_MODELS).toBeUndefined();
  });

  it('sets AWF_DISALLOWED_MODELS when disallowedModels is non-empty', () => {
    const env = buildModelPolicyEnv({ ...baseConfig, workDir: '/tmp/awf-test', disallowedModels: ['gpt-3.5-turbo'] });
    expect(env.AWF_DISALLOWED_MODELS).toBe('["gpt-3.5-turbo"]');
  });

  it('sets AWF_ANTHROPIC_AUTO_CACHE when anthropicAutoCache is set', () => {
    const env = buildModelPolicyEnv({ ...baseConfig, workDir: '/tmp/awf-test', anthropicAutoCache: true });
    expect(env.AWF_ANTHROPIC_AUTO_CACHE).toBe('1');
  });

  it('sets AWF_ENABLE_TOKEN_STEERING when enableTokenSteering is true', () => {
    const env = buildModelPolicyEnv({ ...baseConfig, workDir: '/tmp/awf-test', enableTokenSteering: true });
    expect(env.AWF_ENABLE_TOKEN_STEERING).toBe('true');
  });

  it('sets AWF_DEBUG_TOKENS when debugTokens is true', () => {
    const env = buildModelPolicyEnv({ ...baseConfig, workDir: '/tmp/awf-test', debugTokens: true });
    expect(env.AWF_DEBUG_TOKENS).toBe('1');
  });

  it('sets AWF_CAPTURE_BLOCKED_LLM_REQUESTS when captureBlockedRequests is truthy', () => {
    const env = buildModelPolicyEnv({ ...baseConfig, workDir: '/tmp/awf-test', captureBlockedRequests: true });
    expect(env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS).toBe('true');
  });

  it('omits AWF_CAPTURE_BLOCKED_LLM_REQUESTS when captureBlockedRequests is false', () => {
    const env = buildModelPolicyEnv({ ...baseConfig, workDir: '/tmp/awf-test', captureBlockedRequests: false });
    expect(env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS).toBeUndefined();
  });
});

describe('buildOidcEnv', () => {
  let savedEnv: Record<string, string | undefined>;
  const oidcVars = [
    'AWF_AUTH_TYPE',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ];

  beforeEach(() => {
    savedEnv = {};
    for (const key of oidcVars) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of oidcVars) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  it('forwards ACTIONS_ID_TOKEN_REQUEST_* when auth type is github-oidc', () => {
    process.env.AWF_AUTH_TYPE = 'github-oidc';
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.local/token';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'runtime-token';
    const env = buildOidcEnv({ ...baseConfig, workDir: '/tmp/awf-test' });
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://actions.local/token');
    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('runtime-token');
  });

  it('does not forward ACTIONS_ID_TOKEN_REQUEST_* when auth type is not github-oidc', () => {
    process.env.AWF_AUTH_TYPE = 'static';
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.local/token';
    const env = buildOidcEnv({ ...baseConfig, workDir: '/tmp/awf-test' });
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
  });

  it('normalizes auth type case-insensitively (GitHub-OIDC → github-oidc)', () => {
    process.env.AWF_AUTH_TYPE = '  GitHub-OIDC  ';
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.local/token';
    const env = buildOidcEnv({ ...baseConfig, workDir: '/tmp/awf-test' });
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://actions.local/token');
  });

  it('prefers config.authType over process.env.AWF_AUTH_TYPE', () => {
    process.env.AWF_AUTH_TYPE = 'static';
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.local/token';
    const env = buildOidcEnv({ ...baseConfig, workDir: '/tmp/awf-test', authType: 'github-oidc' });
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://actions.local/token');
  });

  it('forwards ACTIONS_ID_TOKEN_REQUEST_* when AWF_AUTH_TYPE is set via additionalEnv', () => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.local/token';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'runtime-token';
    const env = buildOidcEnv({
      ...baseConfig,
      workDir: '/tmp/awf-test',
      additionalEnv: { AWF_AUTH_TYPE: 'github-oidc' },
    });
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://actions.local/token');
    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('runtime-token');
  });

  it('sets custom OpenAI auth header when openaiApiAuthHeader is configured', () => {
    const env = buildOidcEnv({ ...baseConfig, workDir: '/tmp/awf-test', openaiApiAuthHeader: 'X-Custom-OpenAI-Auth' });
    expect(env.AWF_OPENAI_AUTH_HEADER).toBe('X-Custom-OpenAI-Auth');
  });

  it('sets custom Anthropic auth header when anthropicApiAuthHeader is configured', () => {
    const env = buildOidcEnv({ ...baseConfig, workDir: '/tmp/awf-test', anthropicApiAuthHeader: 'X-Custom-Anthropic-Auth' });
    expect(env.AWF_ANTHROPIC_AUTH_HEADER).toBe('X-Custom-Anthropic-Auth');
  });

  it('sets AWF_AUTH_ANTHROPIC_TOKEN_URL when anthropicTokenUrl is configured', () => {
    const env = buildOidcEnv({ ...baseConfig, workDir: '/tmp/awf-test', anthropicTokenUrl: 'https://auth.anthropic.com/token' });
    expect(env.AWF_AUTH_ANTHROPIC_TOKEN_URL).toBe('https://auth.anthropic.com/token');
  });
});

describe('buildApiProxyBaseEnv (orchestrator)', () => {
  it('composes all sub-builders into a single env record', () => {
    const env = buildApiProxyBaseEnv({
      ...baseConfig,
      workDir: '/tmp/awf-test',
      openaiApiKey: 'sk-test-openai',
      copilotApiTarget: 'https://api.githubcopilot.com',
      rateLimitConfig: { enabled: true, rpm: 60, rph: 1000, bytesPm: 52428800 },
    }, networkConfig);

    // credential
    expect(env.OPENAI_API_KEY).toBe('sk-test-openai');
    // provider routing
    expect(env.COPILOT_API_TARGET).toBe('api.githubcopilot.com');
    // proxy routing
    expect(env.HTTP_PROXY).toBe('http://172.30.0.10:3128');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    // otel
    expect(env.OTEL_SERVICE_NAME).toBe('awf-api-proxy');
    // rate limit
    expect(env.AWF_RATE_LIMIT_ENABLED).toBe('true');
    expect(env.AWF_RATE_LIMIT_RPM).toBe('60');
  });
});
