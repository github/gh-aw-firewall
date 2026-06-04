import { buildConfig } from './build-config';

/** Minimal valid inputs for buildConfig */
function makeInputs(overrides: Partial<Parameters<typeof buildConfig>[0]> = {}): Parameters<typeof buildConfig>[0] {
  return {
    options: {
      keepContainers: false,
      tty: false,
      workDir: '/tmp/awf-test',
      buildLocal: false,
      skipPull: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
      envAll: false,
      enableHostAccess: false,
      sslBump: false,
      enableDind: false,
      enableDlp: false,
      enableApiProxy: false,
      anthropicAutoCache: false,
      diagnosticLogs: false,
    },
    agentCommand: 'echo hello',
    logLevel: 'info',
    allowedDomains: ['github.com'],
    blockedDomains: [],
    localhostDetected: false,
    additionalEnv: {},
    volumeMounts: undefined,
    upstreamProxy: undefined,
    dnsServers: ['8.8.8.8'],
    dnsOverHttps: undefined,
    allowedUrls: undefined,
    memoryLimit: undefined,
    agentImage: undefined,
    modelAliases: undefined,
    maxEffectiveTokens: undefined,
    effectiveTokenModelMultipliers: undefined,
    effectiveTokenDefaultModelMultiplier: undefined,
    maxRuns: undefined,
    maxPermissionDenied: undefined,
    resolvedCopilotApiTarget: undefined,
    resolvedCopilotApiBasePath: undefined,
    dockerHostPathPrefix: undefined,
    ...overrides,
  };
}

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'AWF_AUDIT_DIR',
  'AWF_SESSION_STATE_DIR',
  'OPENAI_API_TARGET',
  'OPENAI_API_BASE_PATH',
  'ANTHROPIC_API_TARGET',
  'ANTHROPIC_API_BASE_PATH',
  'GEMINI_API_TARGET',
  'GEMINI_API_BASE_PATH',
] as const;

describe('buildConfig', () => {
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Snapshot and clear env vars that affect the output
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env vars
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('basic config assembly', () => {
    it('should return a config with the expected allowedDomains', () => {
      const config = buildConfig(makeInputs({ allowedDomains: ['example.com', 'api.example.com'] }));
      expect(config.allowedDomains).toEqual(['example.com', 'api.example.com']);
    });

    it('should set agentCommand from inputs', () => {
      const config = buildConfig(makeInputs({ agentCommand: 'curl https://api.github.com' }));
      expect(config.agentCommand).toBe('curl https://api.github.com');
    });

    it('should set logLevel from inputs', () => {
      const config = buildConfig(makeInputs({ logLevel: 'debug' }));
      expect(config.logLevel).toBe('debug');
    });
  });

  describe('blockedDomains handling', () => {
    it('should set blockedDomains to undefined when empty', () => {
      const config = buildConfig(makeInputs({ blockedDomains: [] }));
      expect(config.blockedDomains).toBeUndefined();
    });

    it('should set blockedDomains when non-empty', () => {
      const config = buildConfig(makeInputs({ blockedDomains: ['evil.com'] }));
      expect(config.blockedDomains).toEqual(['evil.com']);
    });
  });

  describe('additionalEnv handling', () => {
    it('should set additionalEnv to undefined when empty', () => {
      const config = buildConfig(makeInputs({ additionalEnv: {} }));
      expect(config.additionalEnv).toBeUndefined();
    });

    it('should set additionalEnv when non-empty', () => {
      const config = buildConfig(makeInputs({ additionalEnv: { FOO: 'bar' } }));
      expect(config.additionalEnv).toEqual({ FOO: 'bar' });
    });
  });

  describe('excludeEnv handling', () => {
    it('should set excludeEnv to undefined when empty array', () => {
      const config = buildConfig(makeInputs({ options: { ...makeInputs().options, excludeEnv: [] } }));
      expect(config.excludeEnv).toBeUndefined();
    });

    it('should set excludeEnv when non-empty array', () => {
      const config = buildConfig(makeInputs({ options: { ...makeInputs().options, excludeEnv: ['SECRET'] } }));
      expect(config.excludeEnv).toEqual(['SECRET']);
    });

    it('should set excludeEnv to undefined when option not set', () => {
      const config = buildConfig(makeInputs());
      expect(config.excludeEnv).toBeUndefined();
    });
  });

  describe('tty handling', () => {
    it('should default tty to false when not set', () => {
      const config = buildConfig(makeInputs({ options: { ...makeInputs().options, tty: undefined } }));
      expect(config.tty).toBe(false);
    });

    it('should set tty to true when enabled', () => {
      const config = buildConfig(makeInputs({ options: { ...makeInputs().options, tty: true } }));
      expect(config.tty).toBe(true);
    });
  });

  describe('diagnosticLogs handling', () => {
    it('should default diagnosticLogs to false when not set', () => {
      const config = buildConfig(makeInputs({ options: { ...makeInputs().options, diagnosticLogs: undefined } }));
      expect(config.diagnosticLogs).toBe(false);
    });
  });

  describe('API key resolution from environment', () => {
    it('should read OPENAI_API_KEY from process.env', () => {
      process.env.OPENAI_API_KEY = 'sk-test-openai';
      const config = buildConfig(makeInputs());
      expect(config.openaiApiKey).toBe('sk-test-openai');
    });

    it('should read ANTHROPIC_API_KEY from process.env', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const config = buildConfig(makeInputs());
      expect(config.anthropicApiKey).toBe('sk-ant-test');
    });

    it('should read GEMINI_API_KEY from process.env', () => {
      process.env.GEMINI_API_KEY = 'gemini-key';
      const config = buildConfig(makeInputs());
      expect(config.geminiApiKey).toBe('gemini-key');
    });

    it('should read COPILOT_PROVIDER_API_KEY from process.env', () => {
      process.env.COPILOT_PROVIDER_API_KEY = 'sk-byok-provider';
      const config = buildConfig(makeInputs());
      expect(config.copilotProviderApiKey).toBe('sk-byok-provider');
    });

    it('should prefer GITHUB_TOKEN over GH_TOKEN', () => {
      process.env.GITHUB_TOKEN = 'github-token';
      process.env.GH_TOKEN = 'gh-token';
      const config = buildConfig(makeInputs());
      expect(config.githubToken).toBe('github-token');
    });

    it('should fall back to GH_TOKEN when GITHUB_TOKEN is not set', () => {
      process.env.GH_TOKEN = 'gh-token';
      const config = buildConfig(makeInputs());
      expect(config.githubToken).toBe('gh-token');
    });

    it('should set githubToken to undefined when neither env var is set', () => {
      const config = buildConfig(makeInputs());
      expect(config.githubToken).toBeUndefined();
    });
  });

  describe('auditDir and sessionStateDir env fallback', () => {
    it('should use AWF_AUDIT_DIR env var when options.auditDir is not set', () => {
      process.env.AWF_AUDIT_DIR = '/tmp/audit';
      const config = buildConfig(makeInputs());
      expect(config.auditDir).toBe('/tmp/audit');
    });

    it('should prefer options.auditDir over AWF_AUDIT_DIR', () => {
      process.env.AWF_AUDIT_DIR = '/tmp/audit';
      const config = buildConfig(makeInputs({ options: { ...makeInputs().options, auditDir: '/custom/audit' } }));
      expect(config.auditDir).toBe('/custom/audit');
    });

    it('should use AWF_SESSION_STATE_DIR env var when options.sessionStateDir is not set', () => {
      process.env.AWF_SESSION_STATE_DIR = '/tmp/state';
      const config = buildConfig(makeInputs());
      expect(config.sessionStateDir).toBe('/tmp/state');
    });
  });

  describe('API target env var fallbacks', () => {
    it('should fall back to OPENAI_API_TARGET env var', () => {
      process.env.OPENAI_API_TARGET = 'https://my-openai.example.com';
      const config = buildConfig(makeInputs());
      expect(config.openaiApiTarget).toBe('https://my-openai.example.com');
    });

    it('should prefer options.openaiApiTarget over env var', () => {
      process.env.OPENAI_API_TARGET = 'https://my-openai.example.com';
      const config = buildConfig(makeInputs({
        options: { ...makeInputs().options, openaiApiTarget: 'https://override.example.com' },
      }));
      expect(config.openaiApiTarget).toBe('https://override.example.com');
    });

    it('should fall back to ANTHROPIC_API_TARGET env var', () => {
      process.env.ANTHROPIC_API_TARGET = 'https://my-anthropic.example.com';
      const config = buildConfig(makeInputs());
      expect(config.anthropicApiTarget).toBe('https://my-anthropic.example.com');
    });

    it('should fall back to GEMINI_API_TARGET env var', () => {
      process.env.GEMINI_API_TARGET = 'https://my-gemini.example.com';
      const config = buildConfig(makeInputs());
      expect(config.geminiApiTarget).toBe('https://my-gemini.example.com');
    });
  });

  describe('pass-through fields', () => {
    it('should pass through volumeMounts', () => {
      const config = buildConfig(makeInputs({ volumeMounts: ['/host/path:/container/path'] }));
      expect(config.volumeMounts).toEqual(['/host/path:/container/path']);
    });

    it('should pass through upstreamProxy', () => {
      const proxy = { host: 'proxy.example.com', port: 3128 };
      const config = buildConfig(makeInputs({ upstreamProxy: proxy as any }));
      expect(config.upstreamProxy).toEqual(proxy);
    });

    it('should pass through dnsServers', () => {
      const config = buildConfig(makeInputs({ dnsServers: ['1.1.1.1', '1.0.0.1'] }));
      expect(config.dnsServers).toEqual(['1.1.1.1', '1.0.0.1']);
    });

    it('should pass through dockerHostPathPrefix', () => {
      const config = buildConfig(makeInputs({ dockerHostPathPrefix: '/host' }));
      expect(config.dockerHostPathPrefix).toBe('/host');
    });

    it('should pass through modelAliases', () => {
      const aliases = { 'gpt-4': ['gpt-4-turbo'] };
      const config = buildConfig(makeInputs({ modelAliases: aliases }));
      expect(config.modelAliases).toEqual(aliases);
    });

    it('should pass through resolvedCopilotApiTarget', () => {
      const config = buildConfig(makeInputs({ resolvedCopilotApiTarget: 'https://copilot.example.com' }));
      expect(config.copilotApiTarget).toBe('https://copilot.example.com');
    });

    it('should pass through copilotByokExtraHeaders', () => {
      const config = buildConfig(makeInputs({
        options: { ...makeInputs().options, copilotByokExtraHeaders: { 'x-session-id': 'run-42' } },
      }));
      expect(config.copilotByokExtraHeaders).toEqual({ 'x-session-id': 'run-42' });
    });

    it('should pass through copilotByokExtraBodyFields', () => {
      const config = buildConfig(makeInputs({
        options: { ...makeInputs().options, copilotByokExtraBodyFields: { session_id: 'run-42' } },
      }));
      expect(config.copilotByokExtraBodyFields).toEqual({ session_id: 'run-42' });
    });
  });
});
