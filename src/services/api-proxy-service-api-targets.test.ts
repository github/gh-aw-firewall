import { generateDockerCompose, WrapperConfig, baseConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';
import * as fs from 'fs';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;


describe('API proxy sidecar: API targets and auth forwarding', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

      it('should set OPENAI_API_TARGET in api-proxy when openaiApiTarget is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', openaiApiTarget: 'custom.openai-router.internal' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.OPENAI_API_TARGET).toBe('custom.openai-router.internal');
      });

      it('should not set OPENAI_API_TARGET in api-proxy when openaiApiTarget is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.OPENAI_API_TARGET).toBeUndefined();
      });

      it('should set OPENAI_API_BASE_PATH in api-proxy when openaiApiBasePath is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', openaiApiBasePath: '/serving-endpoints' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.OPENAI_API_BASE_PATH).toBe('/serving-endpoints');
      });

      it('should not set OPENAI_API_BASE_PATH in api-proxy when openaiApiBasePath is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.OPENAI_API_BASE_PATH).toBeUndefined();
      });

      it('should set ANTHROPIC_API_TARGET in api-proxy when anthropicApiTarget is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key', anthropicApiTarget: 'custom.anthropic-router.internal' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.ANTHROPIC_API_TARGET).toBe('custom.anthropic-router.internal');
      });

      it('should strip https:// scheme from API target values (gh-aw#25137)', () => {
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          anthropicApiKey: 'sk-ant-test-key',
          anthropicApiTarget: 'https://my-gateway.example.com',
          openaiApiKey: 'sk-openai-test',
          openaiApiTarget: 'https://openai-router.internal',
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.ANTHROPIC_API_TARGET).toBe('my-gateway.example.com');
        expect(env.OPENAI_API_TARGET).toBe('openai-router.internal');
      });

      it('should not set ANTHROPIC_API_TARGET in api-proxy when anthropicApiTarget is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.ANTHROPIC_API_TARGET).toBeUndefined();
      });

      it('should set ANTHROPIC_API_BASE_PATH in api-proxy when anthropicApiBasePath is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key', anthropicApiBasePath: '/anthropic' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.ANTHROPIC_API_BASE_PATH).toBe('/anthropic');
      });

      it('should not set ANTHROPIC_API_BASE_PATH in api-proxy when anthropicApiBasePath is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.ANTHROPIC_API_BASE_PATH).toBeUndefined();
      });

      it('should set COPILOT_API_TARGET in api-proxy when copilotApiTarget is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test_token', copilotApiTarget: 'api.copilot.internal' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_API_TARGET).toBe('api.copilot.internal');
      });

      it('should not set COPILOT_API_TARGET in api-proxy when copilotApiTarget is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test_token' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_API_TARGET).toBeUndefined();
      });

      it('should set COPILOT_API_BASE_PATH in api-proxy when copilotApiBasePath is provided', () => {
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          copilotGithubToken: 'ghu_test_token',
          copilotApiBasePath: '/api/v1',
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_API_BASE_PATH).toBe('/api/v1');
      });

      it('should not set COPILOT_API_BASE_PATH in api-proxy when copilotApiBasePath is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test_token' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_API_BASE_PATH).toBeUndefined();
      });

      it('should set COPILOT_OFFLINE=true in agent when copilotGithubToken is provided (offline+BYOK mode)', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test_token' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_OFFLINE).toBe('true');
      });

      it('should set COPILOT_PROVIDER_BASE_URL in agent when copilotGithubToken is provided (offline+BYOK mode)', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test_token' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_BASE_URL).toBe('http://172.30.0.30:10002');
      });

      it('should set COPILOT_PROVIDER_API_KEY placeholder in agent when copilotGithubToken is provided (offline+BYOK mode)', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test_token' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_API_KEY).toBe('ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      });

      it('should pass COPILOT_PROVIDER_TYPE/BASE_URL from additionalEnv and API_KEY from config to api-proxy', () => {
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          copilotProviderApiKey: 'azure-byok-key',
          additionalEnv: {
            COPILOT_PROVIDER_TYPE: 'azure',
            COPILOT_PROVIDER_BASE_URL: 'https://example-resource.openai.azure.com/openai/deployments/test',
          },
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_TYPE).toBe('azure');
        expect(env.COPILOT_PROVIDER_BASE_URL).toBe('https://example-resource.openai.azure.com/openai/deployments/test');
        expect(env.COPILOT_PROVIDER_API_KEY).toBe('azure-byok-key');
      });

      it('should pass COPILOT_PROVIDER_TYPE/BASE_URL from envFile and API_KEY from config to api-proxy', () => {
        const envFilePath = path.join(mockConfig.workDir, '.env.azure-byok');
        fs.writeFileSync(envFilePath, [
          'COPILOT_PROVIDER_TYPE=azure',
          'COPILOT_PROVIDER_BASE_URL=https://example-resource.openai.azure.com/openai/deployments/test',
        ].join('\n'));
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          copilotProviderApiKey: 'azure-byok-key',
          envFile: envFilePath,
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_TYPE).toBe('azure');
        expect(env.COPILOT_PROVIDER_BASE_URL).toBe('https://example-resource.openai.azure.com/openai/deployments/test');
        expect(env.COPILOT_PROVIDER_API_KEY).toBe('azure-byok-key');
      });

      it('should pass COPILOT_PROVIDER_TYPE/BASE_URL from config modelRouter fields', () => {
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          copilotProviderType: 'azure',
          copilotProviderBaseUrl: 'https://example-resource.openai.azure.com/openai/deployments/test',
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_TYPE).toBe('azure');
        expect(env.COPILOT_PROVIDER_BASE_URL).toBe('https://example-resource.openai.azure.com/openai/deployments/test');
      });


      it.each(['gpt-5', 'openai/o3-mini', 'gpt-5.4-mini', 'GPT-5', 'O3'])('should set COPILOT_PROVIDER_WIRE_API=responses in GitHub token mode when COPILOT_MODEL is %s', (copilotModel) => {
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          copilotGithubToken: 'ghu_test_token',
          additionalEnv: { COPILOT_MODEL: copilotModel },
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_WIRE_API).toBe('responses');
      });

      it.each(['gpt-4o', 'o30', 'o3x'])('should not set COPILOT_PROVIDER_WIRE_API in GitHub token mode when COPILOT_MODEL=%s does not require responses API', (copilotModel) => {
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          copilotGithubToken: 'ghu_test_token',
          additionalEnv: { COPILOT_MODEL: copilotModel },
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_WIRE_API).toBeUndefined();
      });

      it('should include COPILOT_PROVIDER_API_KEY in AWF_ONE_SHOT_TOKENS', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test_token' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.AWF_ONE_SHOT_TOKENS).toContain('COPILOT_PROVIDER_API_KEY');
      });

      it('should include api-proxy service when enableApiProxy is true with Gemini key', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-gemini-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        expect(result.services['api-proxy']).toBeDefined();
        const proxy = result.services['api-proxy'];
        expect(proxy.container_name).toBe('awf-api-proxy');
      });

      it('should pass GEMINI_API_KEY to api-proxy env when geminiApiKey is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-gemini-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.GEMINI_API_KEY).toBe('AIza-test-gemini-key');
      });

      it('should set GEMINI_API_BASE_URL in agent when geminiApiKey is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-gemini-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.GEMINI_API_BASE_URL).toBe('http://172.30.0.30:10003');
      });

      it('should set GOOGLE_GEMINI_BASE_URL in agent when geminiApiKey is provided', () => {
        // GOOGLE_GEMINI_BASE_URL is the env var read by the Gemini CLI (google-gemini/gemini-cli)
        // to override the API endpoint. Without it, the CLI bypasses the proxy sidecar.
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-gemini-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.GOOGLE_GEMINI_BASE_URL).toBe('http://172.30.0.30:10003');
      });

      it('should set GOOGLE_GEMINI_BASE_URL and GEMINI_API_BASE_URL to the same proxy URL', () => {
        // Both vars must point to the same proxy so CLI and SDK clients both route through sidecar.
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-gemini-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.GOOGLE_GEMINI_BASE_URL).toBe(env.GEMINI_API_BASE_URL);
      });

      it('should set GEMINI_API_KEY placeholder in agent when geminiApiKey is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-gemini-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.GEMINI_API_KEY).toBe('gemini-api-key-placeholder-for-credential-isolation');
      });

      it('should set AWF_GEMINI_ENABLED in agent when geminiApiKey is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-gemini-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.AWF_GEMINI_ENABLED).toBe('1');
      });

      it('should NOT set AWF_GEMINI_ENABLED in agent when geminiApiKey is absent', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.AWF_GEMINI_ENABLED).toBeUndefined();
      });

      it('should not inherit AWF_GEMINI_ENABLED from host env via envAll when geminiApiKey is absent', () => {
        const origVal = process.env.AWF_GEMINI_ENABLED;
        process.env.AWF_GEMINI_ENABLED = '1';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          // AWF_GEMINI_ENABLED is in EXCLUDED_ENV_VARS so it must not be inherited from host
          expect(env.AWF_GEMINI_ENABLED).toBeUndefined();
        } finally {
          if (origVal !== undefined) {
            process.env.AWF_GEMINI_ENABLED = origVal;
          } else {
            delete process.env.AWF_GEMINI_ENABLED;
          }
        }
      });

      it('should NOT set GEMINI_API_BASE_URL in agent when api-proxy is enabled without geminiApiKey', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        // GEMINI_API_BASE_URL must NOT be set when geminiApiKey is absent — it was previously
        // set unconditionally which caused spurious Gemini-related log entries in Copilot runs.
        expect(env.GEMINI_API_BASE_URL).toBeUndefined();
      });

      it('should NOT set GOOGLE_GEMINI_BASE_URL in agent when api-proxy is enabled without geminiApiKey', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        // Must not be set without a Gemini key to avoid polluting non-Gemini runs.
        expect(env.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
      });

      it('should not inherit GOOGLE_GEMINI_BASE_URL from host env via envAll when geminiApiKey is absent', () => {
        const origVal = process.env.GOOGLE_GEMINI_BASE_URL;
        process.env.GOOGLE_GEMINI_BASE_URL = 'http://some-other-proxy';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          // GOOGLE_GEMINI_BASE_URL is in EXCLUDED_ENV_VARS so it must not be inherited from host
          expect(env.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
        } finally {
          if (origVal !== undefined) {
            process.env.GOOGLE_GEMINI_BASE_URL = origVal;
          } else {
            delete process.env.GOOGLE_GEMINI_BASE_URL;
          }
        }
      });

      it('should not inherit GEMINI_API_BASE_URL from host env via envAll when geminiApiKey is absent', () => {
        const origVal = process.env.GEMINI_API_BASE_URL;
        process.env.GEMINI_API_BASE_URL = 'http://some-other-proxy';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          // GEMINI_API_BASE_URL is in EXCLUDED_ENV_VARS so it must not be inherited from host
          expect(env.GEMINI_API_BASE_URL).toBeUndefined();
        } finally {
          if (origVal !== undefined) {
            process.env.GEMINI_API_BASE_URL = origVal;
          } else {
            delete process.env.GEMINI_API_BASE_URL;
          }
        }
      });

      it('should NOT set GEMINI_API_KEY placeholder in agent when api-proxy is enabled without geminiApiKey', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        // Placeholder must NOT be set when Gemini is not in use to avoid polluting non-Gemini runs.
        expect(env.GEMINI_API_KEY).toBeUndefined();
      });

      function withGeminiApiKey(value: string, fn: () => void): void {
        const origKey = process.env.GEMINI_API_KEY;
        process.env.GEMINI_API_KEY = value;
        try {
          fn();
        } finally {
          if (origKey !== undefined) {
            process.env.GEMINI_API_KEY = origKey;
          } else {
            delete process.env.GEMINI_API_KEY;
          }
        }
      }

function expectGeminiCredentialIsolation(configOverrides: Omit<Partial<WrapperConfig>, 'enableApiProxy' | 'geminiApiKey'>): void {
  const configWithProxy = { ...mockConfig, ...configOverrides, enableApiProxy: true, geminiApiKey: 'AIza-secret-gemini-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.GEMINI_API_KEY).toBe('gemini-api-key-placeholder-for-credential-isolation');
        expect(env.GEMINI_API_BASE_URL).toBe('http://172.30.0.30:10003');
        expect(env.GOOGLE_GEMINI_BASE_URL).toBe('http://172.30.0.30:10003');
      }

      it('should not leak GEMINI_API_KEY to agent when api-proxy is enabled', () => {
        withGeminiApiKey('AIza-secret-gemini-key', () => {
          // Agent should NOT have the real API key — only the sidecar gets it
          // Agent should have both base URL vars to proxy through sidecar
          expectGeminiCredentialIsolation({});
        });
      });

      it('should not leak GEMINI_API_KEY to agent when api-proxy is enabled with envAll', () => {
        withGeminiApiKey('AIza-secret-gemini-key', () => {
          // Even with envAll, agent should NOT have the real GEMINI_API_KEY
          expectGeminiCredentialIsolation({ envAll: true });
        });
      });

      it('should set GEMINI_API_TARGET in api-proxy when geminiApiTarget is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-key', geminiApiTarget: 'custom.gemini-router.internal' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.GEMINI_API_TARGET).toBe('custom.gemini-router.internal');
      });

      it('should not set GEMINI_API_TARGET in api-proxy when geminiApiTarget is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.GEMINI_API_TARGET).toBeUndefined();
      });

      it('should set GEMINI_API_BASE_PATH in api-proxy when geminiApiBasePath is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-key', geminiApiBasePath: '/v1beta' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.GEMINI_API_BASE_PATH).toBe('/v1beta');
      });

      it('should not set GEMINI_API_BASE_PATH in api-proxy when geminiApiBasePath is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.GEMINI_API_BASE_PATH).toBeUndefined();
      });

      // ─── Custom auth headers ───

      it('should set AWF_OPENAI_AUTH_HEADER when openaiApiAuthHeader is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', openaiApiAuthHeader: 'api-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_OPENAI_AUTH_HEADER).toBe('api-key');
      });

      it('should not set AWF_OPENAI_AUTH_HEADER when openaiApiAuthHeader is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_OPENAI_AUTH_HEADER).toBeUndefined();
      });

      it('should set AWF_ANTHROPIC_AUTH_HEADER when anthropicApiAuthHeader is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test', anthropicApiAuthHeader: 'api-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_ANTHROPIC_AUTH_HEADER).toBe('api-key');
      });

      it('should not set AWF_ANTHROPIC_AUTH_HEADER when anthropicApiAuthHeader is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_ANTHROPIC_AUTH_HEADER).toBeUndefined();
      });

      describe('COPILOT_INTEGRATION_ID forwarding', () => {
        let savedEnv: Record<string, string | undefined>;

        beforeEach(() => {
          // Save both env vars to prevent test flakiness if host has COPILOT_INTEGRATION_ID set
          savedEnv = {
            COPILOT_INTEGRATION_ID: process.env.COPILOT_INTEGRATION_ID,
            GITHUB_COPILOT_INTEGRATION_ID: process.env.GITHUB_COPILOT_INTEGRATION_ID,
          };
        });

        afterEach(() => {
          // Restore original env state
          for (const key of Object.keys(savedEnv)) {
            if (savedEnv[key] !== undefined) {
              process.env[key] = savedEnv[key];
            } else {
              delete process.env[key];
            }
          }
        });

        it('should not forward GITHUB_COPILOT_INTEGRATION_ID as COPILOT_INTEGRATION_ID to api-proxy', () => {
          process.env.GITHUB_COPILOT_INTEGRATION_ID = 'agentic-workflows';
          delete process.env.COPILOT_INTEGRATION_ID;
          const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test' };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxy = result.services['api-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.COPILOT_INTEGRATION_ID).toBeUndefined();
        });

        it('should not set COPILOT_INTEGRATION_ID when GITHUB_COPILOT_INTEGRATION_ID is not set', () => {
          delete process.env.GITHUB_COPILOT_INTEGRATION_ID;
          delete process.env.COPILOT_INTEGRATION_ID;
          const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test' };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxy = result.services['api-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.COPILOT_INTEGRATION_ID).toBeUndefined();
        });

        it('should forward COPILOT_INTEGRATION_ID from host env when explicitly set', () => {
          process.env.COPILOT_INTEGRATION_ID = 'my-custom-integration';
          delete process.env.GITHUB_COPILOT_INTEGRATION_ID;
          const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxy = result.services['api-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.COPILOT_INTEGRATION_ID).toBe('my-custom-integration');
        });

        it('should not set COPILOT_INTEGRATION_ID when host env var is empty', () => {
          process.env.COPILOT_INTEGRATION_ID = '';
          delete process.env.GITHUB_COPILOT_INTEGRATION_ID;
          const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxy = result.services['api-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.COPILOT_INTEGRATION_ID).toBeUndefined();
        });

        it('should not set COPILOT_INTEGRATION_ID when host env var is whitespace only', () => {
          process.env.COPILOT_INTEGRATION_ID = '   ';
          delete process.env.GITHUB_COPILOT_INTEGRATION_ID;
          const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxy = result.services['api-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.COPILOT_INTEGRATION_ID).toBeUndefined();
        });

        it('should trim surrounding whitespace before forwarding', () => {
          process.env.COPILOT_INTEGRATION_ID = '  my-custom-integration  ';
          delete process.env.GITHUB_COPILOT_INTEGRATION_ID;
          const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxy = result.services['api-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.COPILOT_INTEGRATION_ID).toBe('my-custom-integration');
        });

        it('should not set COPILOT_INTEGRATION_ID when nothing is set', () => {
          delete process.env.COPILOT_INTEGRATION_ID;
          delete process.env.GITHUB_COPILOT_INTEGRATION_ID;
          const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test' };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxy = result.services['api-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.COPILOT_INTEGRATION_ID).toBeUndefined();
        });

        it('should forward COPILOT_INTEGRATION_ID from config.additionalEnv (--env flag)', () => {
          delete process.env.COPILOT_INTEGRATION_ID;
          delete process.env.GITHUB_COPILOT_INTEGRATION_ID;
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotGithubToken: 'ghu_test',
            additionalEnv: { COPILOT_INTEGRATION_ID: 'from-cli-flag' },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxy = result.services['api-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.COPILOT_INTEGRATION_ID).toBe('from-cli-flag');
        });

        it('should prefer config.additionalEnv over process.env', () => {
          process.env.COPILOT_INTEGRATION_ID = 'from-host-env';
          delete process.env.GITHUB_COPILOT_INTEGRATION_ID;
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotGithubToken: 'ghu_test',
            additionalEnv: { COPILOT_INTEGRATION_ID: 'from-cli-flag' },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxy = result.services['api-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.COPILOT_INTEGRATION_ID).toBe('from-cli-flag');
        });
      });
});
