import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir } from './service-test-setup.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('agent environment: credentials', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

  it('should forward COPILOT_GITHUB_TOKEN when api-proxy is disabled', () => {
    const original = process.env.COPILOT_GITHUB_TOKEN;
    process.env.COPILOT_GITHUB_TOKEN = 'ghp_test_token';
    try {
      const configNoProxy = { ...mockConfig, enableApiProxy: false };
      const result = generateDockerCompose(configNoProxy, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_GITHUB_TOKEN).toBe('ghp_test_token');
    } finally {
      if (original !== undefined) process.env.COPILOT_GITHUB_TOKEN = original;
      else delete process.env.COPILOT_GITHUB_TOKEN;
    }
  });

  it('should not forward COPILOT_PROVIDER_API_KEY to agent when api-proxy is enabled and key is configured', () => {
    const configWithProxy = {
      ...mockConfig,
      enableApiProxy: true,
      copilotProviderApiKey: 'sk-real-provider-key',
    };
    const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
    const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
    const env = result.services.agent.environment as Record<string, string>;
    // Direct-BYOK mode auto-enables Copilot sidecar routing whenever a real
    // COPILOT_PROVIDER_API_KEY is configured. The agent env must contain the
    // placeholder, not the real key.
    expect(env.COPILOT_PROVIDER_API_KEY).toBe('ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(env.COPILOT_PROVIDER_API_KEY).not.toBe('sk-real-provider-key');
  });

  it('should forward AWF_ONE_SHOT_TOKEN_DEBUG when set', () => {
    const original = process.env.AWF_ONE_SHOT_TOKEN_DEBUG;
    process.env.AWF_ONE_SHOT_TOKEN_DEBUG = '1';
    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.AWF_ONE_SHOT_TOKEN_DEBUG).toBe('1');
    } finally {
      if (original !== undefined) process.env.AWF_ONE_SHOT_TOKEN_DEBUG = original;
      else delete process.env.AWF_ONE_SHOT_TOKEN_DEBUG;
    }
  });

  it('should pass through GITHUB_TOKEN when present in environment', () => {
    const originalEnv = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_testtoken123';

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.GITHUB_TOKEN).toBe('ghp_testtoken123');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });

  it('should not pass through GITHUB_TOKEN when not in environment', () => {
    const originalEnv = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      }
    }
  });

  it('should pass through ACTIONS_ID_TOKEN_REQUEST_URL when present in environment', () => {
    const originalEnv = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.actions.githubusercontent.com/abc';

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://token.actions.githubusercontent.com/abc');
    } finally {
      if (originalEnv !== undefined) {
        process.env.ACTIONS_ID_TOKEN_REQUEST_URL = originalEnv;
      } else {
        delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      }
    }
  });

  it('should pass through ACTIONS_ID_TOKEN_REQUEST_TOKEN when present in environment', () => {
    const originalEnv = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'test-oidc-token-value';

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('test-oidc-token-value');
    } finally {
      if (originalEnv !== undefined) {
        process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = originalEnv;
      } else {
        delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      }
    }
  });

  it('should not pass through OIDC variables when not in environment', () => {
    const origUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const origToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
      expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    } finally {
      if (origUrl !== undefined) {
        process.env.ACTIONS_ID_TOKEN_REQUEST_URL = origUrl;
      } else {
        delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      }
      if (origToken !== undefined) {
        process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = origToken;
      } else {
        delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      }
    }
  });

  it('should never pass ACTIONS_RUNTIME_TOKEN to agent container', () => {
    const originalToken = process.env.ACTIONS_RUNTIME_TOKEN;
    process.env.ACTIONS_RUNTIME_TOKEN = 'test-runtime-token-value';

    try {
      // Should not be passed in default mode
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
    } finally {
      if (originalToken !== undefined) {
        process.env.ACTIONS_RUNTIME_TOKEN = originalToken;
      } else {
        delete process.env.ACTIONS_RUNTIME_TOKEN;
      }
    }
  });

  it('should never pass ACTIONS_RESULTS_URL to agent container', () => {
    const originalUrl = process.env.ACTIONS_RESULTS_URL;
    process.env.ACTIONS_RESULTS_URL = 'https://results-receiver.actions.githubusercontent.com/';

    try {
      // Should not be passed in default mode
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.ACTIONS_RESULTS_URL).toBeUndefined();
    } finally {
      if (originalUrl !== undefined) {
        process.env.ACTIONS_RESULTS_URL = originalUrl;
      } else {
        delete process.env.ACTIONS_RESULTS_URL;
      }
    }
  });

  it('should exclude ACTIONS_RUNTIME_TOKEN from env-all passthrough', () => {
    const originalToken = process.env.ACTIONS_RUNTIME_TOKEN;
    process.env.ACTIONS_RUNTIME_TOKEN = 'test-runtime-token-value';

    try {
      const configWithEnvAll = { ...mockConfig, envAll: true };
      const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
    } finally {
      if (originalToken !== undefined) {
        process.env.ACTIONS_RUNTIME_TOKEN = originalToken;
      } else {
        delete process.env.ACTIONS_RUNTIME_TOKEN;
      }
    }
  });

  it('should exclude ACTIONS_RESULTS_URL from env-all passthrough', () => {
    const originalUrl = process.env.ACTIONS_RESULTS_URL;
    process.env.ACTIONS_RESULTS_URL = 'https://results-receiver.actions.githubusercontent.com/';

    try {
      const configWithEnvAll = { ...mockConfig, envAll: true };
      const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.ACTIONS_RESULTS_URL).toBeUndefined();
    } finally {
      if (originalUrl !== undefined) {
        process.env.ACTIONS_RESULTS_URL = originalUrl;
      } else {
        delete process.env.ACTIONS_RESULTS_URL;
      }
    }
  });

  it('should exclude GITHUB_TOKEN from env-all passthrough when specified in excludeEnv', () => {
    const prevToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test_token';

    try {
      const configWithExcludeEnv = { ...mockConfig, envAll: true, excludeEnv: ['GITHUB_TOKEN'] };
      const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      // GITHUB_TOKEN should be excluded from the env-all passthrough
      expect(env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      if (prevToken !== undefined) process.env.GITHUB_TOKEN = prevToken;
      else delete process.env.GITHUB_TOKEN;
    }
  });

  describe('OTEL environment variable forwarding', () => {
    const otelVars: Record<string, string> = {
      OTEL_SERVICE_NAME: 'my-service',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer secret-token',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer traces-token',
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'Authorization=Bearer metrics-token',
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'Authorization=Bearer logs-token',
      OTEL_RESOURCE_ATTRIBUTES: 'host.name=runner01',
      OTEL_SDK_DISABLED: 'false',
    };

    let origVals: Record<string, string | undefined>;

    beforeEach(() => {
      origVals = {};
      for (const key of Object.keys(otelVars)) {
        origVals[key] = process.env[key];
        process.env[key] = otelVars[key];
      }
    });

    afterEach(() => {
      for (const key of Object.keys(otelVars)) {
        if (origVals[key] !== undefined) process.env[key] = origVals[key];
        else delete process.env[key];
      }
    });

    it('should auto-forward OTEL_* variables in default (non-env-all) mode', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.OTEL_SERVICE_NAME).toBe('my-service');
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://otel.example.com:4318');
      expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer secret-token');
      expect(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS).toBe('Authorization=Bearer traces-token');
      expect(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBe('Authorization=Bearer metrics-token');
      expect(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe('Authorization=Bearer logs-token');
      expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('host.name=runner01');
      expect(env.OTEL_SDK_DISABLED).toBe('false');
    });

    it('should not forward OTEL_* variables when not set in host environment', () => {
      for (const key of Object.keys(otelVars)) {
        delete process.env[key];
      }
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      for (const key of Object.keys(otelVars)) {
        expect(env[key]).toBeUndefined();
      }
    });

    it('should include OTEL header vars in AWF_ONE_SHOT_TOKENS', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      const oneShot = env.AWF_ONE_SHOT_TOKENS ?? '';

      expect(oneShot).toContain('OTEL_EXPORTER_OTLP_HEADERS');
      expect(oneShot).toContain('OTEL_EXPORTER_OTLP_TRACES_HEADERS');
      expect(oneShot).toContain('OTEL_EXPORTER_OTLP_METRICS_HEADERS');
      expect(oneShot).toContain('OTEL_EXPORTER_OTLP_LOGS_HEADERS');
    });
  });

  describe('COPILOT_OTEL_FILE_EXPORTER_PATH forwarding', () => {
    it('should forward COPILOT_OTEL_FILE_EXPORTER_PATH when set', () => {
      const original = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
      process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = '/tmp/otel-spans.json';
      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe('/tmp/otel-spans.json');
      } finally {
        if (original !== undefined) process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = original;
        else delete process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
      }
    });

    it('should not set COPILOT_OTEL_FILE_EXPORTER_PATH when not in host environment', () => {
      const original = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
      delete process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBeUndefined();
      } finally {
        if (original !== undefined) process.env.COPILOT_OTEL_FILE_EXPORTER_PATH = original;
      }
    });
  });
});
