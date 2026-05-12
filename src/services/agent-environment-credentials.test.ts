import { generateDockerCompose } from '../compose-generator';
import { WrapperConfig } from '../types';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('agent environment: credentials', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

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

  it('should forward COPILOT_API_KEY when api-proxy is disabled', () => {
    const original = process.env.COPILOT_API_KEY;
    process.env.COPILOT_API_KEY = 'cpat_test_byok_key';
    try {
      const configNoProxy = { ...mockConfig, enableApiProxy: false };
      const result = generateDockerCompose(configNoProxy, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_API_KEY).toBe('cpat_test_byok_key');
    } finally {
      if (original !== undefined) process.env.COPILOT_API_KEY = original;
      else delete process.env.COPILOT_API_KEY;
    }
  });

  it('should not forward COPILOT_API_KEY to agent when api-proxy is enabled', () => {
    const original = process.env.COPILOT_API_KEY;
    process.env.COPILOT_API_KEY = 'cpat_test_byok_key';
    try {
      const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      // Placeholder is set to prevent --env-all from leaking the real key
      expect(env.COPILOT_API_KEY).toBe('placeholder-token-for-credential-isolation');
    } finally {
      if (original !== undefined) process.env.COPILOT_API_KEY = original;
      else delete process.env.COPILOT_API_KEY;
    }
  });

  it('should not forward COPILOT_PROVIDER_API_KEY to agent from --env-all when api-proxy is enabled', () => {
    const original = process.env.COPILOT_PROVIDER_API_KEY;
    process.env.COPILOT_PROVIDER_API_KEY = 'sk-real-provider-key';
    try {
      const configWithProxy = { ...mockConfig, enableApiProxy: true, envAll: true };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.COPILOT_PROVIDER_API_KEY = original;
      else delete process.env.COPILOT_PROVIDER_API_KEY;
    }
  });

  it('should keep COPILOT_PROVIDER_API_KEY placeholder when api-proxy is enabled with copilotApiKey and --env-all', () => {
    const original = process.env.COPILOT_PROVIDER_API_KEY;
    const copilotApiKey = 'cpat-config-byok-key';
    process.env.COPILOT_PROVIDER_API_KEY = 'sk-real-provider-key';
    try {
      const configWithProxy = { ...mockConfig, enableApiProxy: true, envAll: true, copilotApiKey };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_PROVIDER_API_KEY).toBe('placeholder-token-for-credential-isolation');
    } finally {
      if (original !== undefined) process.env.COPILOT_PROVIDER_API_KEY = original;
      else delete process.env.COPILOT_PROVIDER_API_KEY;
    }
  });

  it('should keep COPILOT_API_KEY placeholder when api-proxy is enabled with copilotApiKey and --env-all', () => {
    const original = process.env.COPILOT_API_KEY;
    process.env.COPILOT_API_KEY = 'cpat-host-value';
    try {
      const configWithProxy = { ...mockConfig, enableApiProxy: true, envAll: true, copilotApiKey: 'cpat-config-byok-key' };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_API_KEY).toBe('placeholder-token-for-credential-isolation');
    } finally {
      if (original !== undefined) process.env.COPILOT_API_KEY = original;
      else delete process.env.COPILOT_API_KEY;
    }
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
});
