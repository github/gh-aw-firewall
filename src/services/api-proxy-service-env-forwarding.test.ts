import { generateDockerCompose, WrapperConfig, baseConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';
import * as fs from 'fs';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('API proxy sidecar: env var forwarding', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

      describe('OIDC runtime env forwarding', () => {
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
            if (savedEnv[key] !== undefined) {
              process.env[key] = savedEnv[key];
            } else {
              delete process.env[key];
            }
          }
        });

        it('should forward ACTIONS_ID_TOKEN_REQUEST_* when AWF_AUTH_TYPE normalizes to github-oidc', () => {
          process.env.AWF_AUTH_TYPE = '  GitHub-OIDC ';
          process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.local/token';
          process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'runtime-token';
          const config = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-openai-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://actions.local/token');
          expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('runtime-token');
        });

        it('should not forward ACTIONS_ID_TOKEN_REQUEST_* when AWF_AUTH_TYPE is not github-oidc', () => {
          process.env.AWF_AUTH_TYPE = 'api-key';
          process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.local/token';
          process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'runtime-token';
          const config = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-openai-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
          expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
        });
      });

      describe('AWF_ANTHROPIC_* env var forwarding', () => {
        let savedEnv: Record<string, string | undefined>;
        const anthropicVars = [
          'AWF_ANTHROPIC_AUTO_CACHE',
          'AWF_ANTHROPIC_CACHE_TAIL_TTL',
          'AWF_ANTHROPIC_DROP_TOOLS',
          'AWF_ANTHROPIC_STRIP_ANSI',
        ];

        beforeEach(() => {
          savedEnv = {};
          for (const key of anthropicVars) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
          }
        });

        afterEach(() => {
          for (const key of anthropicVars) {
            if (savedEnv[key] !== undefined) {
              process.env[key] = savedEnv[key];
            } else {
              delete process.env[key];
            }
          }
        });

        it('should forward AWF_ANTHROPIC_AUTO_CACHE to api-proxy when set', () => {
          process.env.AWF_ANTHROPIC_AUTO_CACHE = '1';
          const config = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_ANTHROPIC_AUTO_CACHE).toBe('1');
        });

        it('should not set AWF_ANTHROPIC_AUTO_CACHE when env var is not set', () => {
          const config = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_ANTHROPIC_AUTO_CACHE).toBeUndefined();
        });

        it('should forward AWF_ANTHROPIC_CACHE_TAIL_TTL to api-proxy when set', () => {
          process.env.AWF_ANTHROPIC_CACHE_TAIL_TTL = '1h';
          const config = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_ANTHROPIC_CACHE_TAIL_TTL).toBe('1h');
        });

        it('should forward AWF_ANTHROPIC_DROP_TOOLS to api-proxy when set', () => {
          process.env.AWF_ANTHROPIC_DROP_TOOLS = 'NotebookEdit,CronCreate';
          const config = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_ANTHROPIC_DROP_TOOLS).toBe('NotebookEdit,CronCreate');
        });

        it('should forward AWF_ANTHROPIC_STRIP_ANSI to api-proxy when set', () => {
          process.env.AWF_ANTHROPIC_STRIP_ANSI = '1';
          const config = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_ANTHROPIC_STRIP_ANSI).toBe('1');
        });

        it('should not set any AWF_ANTHROPIC_* vars when none are set in host env', () => {
          const config = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          for (const key of anthropicVars) {
            expect(env[key]).toBeUndefined();
          }
        });
      });

      describe('AWF_AUTH_ANTHROPIC_* WIF env var forwarding', () => {
        let savedEnv: Record<string, string | undefined>;
        const wifVars = [
          'AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID',
          'AWF_AUTH_ANTHROPIC_ORGANIZATION_ID',
          'AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID',
          'AWF_AUTH_ANTHROPIC_WORKSPACE_ID',
          'AWF_AUTH_ANTHROPIC_TOKEN_URL',
        ];

        beforeEach(() => {
          savedEnv = {};
          for (const key of wifVars) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
          }
        });

        afterEach(() => {
          for (const key of wifVars) {
            if (savedEnv[key] !== undefined) {
              process.env[key] = savedEnv[key];
            } else {
              delete process.env[key];
            }
          }
        });

        it('should forward all Anthropic WIF vars to api-proxy when set', () => {
          process.env.AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID = 'fdrl_test';
          process.env.AWF_AUTH_ANTHROPIC_ORGANIZATION_ID = 'org-uuid-test';
          process.env.AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID = 'svac_test';
          process.env.AWF_AUTH_ANTHROPIC_WORKSPACE_ID = 'wrkspc_test';
          process.env.AWF_AUTH_ANTHROPIC_TOKEN_URL = 'https://anthropic.internal.example/v1/oauth/token';
          const config = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-openai-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID).toBe('fdrl_test');
          expect(env.AWF_AUTH_ANTHROPIC_ORGANIZATION_ID).toBe('org-uuid-test');
          expect(env.AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID).toBe('svac_test');
          expect(env.AWF_AUTH_ANTHROPIC_WORKSPACE_ID).toBe('wrkspc_test');
          expect(env.AWF_AUTH_ANTHROPIC_TOKEN_URL).toBe('https://anthropic.internal.example/v1/oauth/token');
        });

        it('should forward AWF_AUTH_ANTHROPIC_WORKSPACE_ID independently when only it is set', () => {
          process.env.AWF_AUTH_ANTHROPIC_WORKSPACE_ID = 'wrkspc_solo';
          const config = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-openai-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_AUTH_ANTHROPIC_WORKSPACE_ID).toBe('wrkspc_solo');
        });

        it('should not forward Anthropic WIF vars when none are set', () => {
          const config = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-openai-test' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          for (const key of wifVars) {
            expect(env[key]).toBeUndefined();
          }
        });
      });

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
          copilotApiKey: 'cpat_test_byok_key',
          copilotApiBasePath: '/api/v1',
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_API_BASE_PATH).toBe('/api/v1');
      });

      it('should not set COPILOT_API_BASE_PATH in api-proxy when copilotApiBasePath is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_API_BASE_PATH).toBeUndefined();
      });

      it('should pass COPILOT_API_KEY to api-proxy env when copilotApiKey is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_API_KEY).toBe('cpat_test_byok_key');
      });

      it('should set COPILOT_API_URL in agent when only copilotApiKey is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_API_URL).toBe('http://172.30.0.30:10002');
      });

      it('should set COPILOT_TOKEN placeholder when copilotApiKey is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_TOKEN).toBe('ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      });

      it('should set COPILOT_OFFLINE=true in agent when copilotApiKey is provided (offline+BYOK mode)', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_OFFLINE).toBe('true');
      });

      it('should set COPILOT_PROVIDER_BASE_URL in agent when copilotApiKey is provided (offline+BYOK mode)', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_BASE_URL).toBe('http://172.30.0.30:10002');
      });

      it('should set COPILOT_PROVIDER_API_KEY placeholder in agent when copilotApiKey is provided (offline+BYOK mode)', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_API_KEY).toBe('ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      });

      it.each(['gpt-5', 'openai/o3-mini', 'gpt-5.4-mini', 'provider:gpt-5_preview', 'GPT-5', 'O3'])('should set COPILOT_PROVIDER_WIRE_API=responses in BYOK mode when COPILOT_MODEL is %s', (copilotModel) => {
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          copilotApiKey: 'cpat_test_byok_key',
          additionalEnv: { COPILOT_MODEL: copilotModel },
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_WIRE_API).toBe('responses');
      });

      it.each(['gpt-4o', 'o30', 'o3x'])('should not set COPILOT_PROVIDER_WIRE_API in BYOK mode when COPILOT_MODEL=%s does not require responses API', (copilotModel) => {
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          copilotApiKey: 'cpat_test_byok_key',
          additionalEnv: { COPILOT_MODEL: copilotModel },
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_WIRE_API).toBeUndefined();
      });

      it('should set COPILOT_PROVIDER_WIRE_API=responses in BYOK mode when COPILOT_MODEL is provided via host env and envAll is enabled', () => {
        const previousCopilotModel = process.env.COPILOT_MODEL;
        process.env.COPILOT_MODEL = 'gpt-5';

        try {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotApiKey: 'cpat_test_byok_key',
            envAll: true,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          expect(env.COPILOT_PROVIDER_WIRE_API).toBe('responses');
        } finally {
          if (previousCopilotModel === undefined) {
            delete process.env.COPILOT_MODEL;
          } else {
            process.env.COPILOT_MODEL = previousCopilotModel;
          }
        }
      });

      it('should set COPILOT_PROVIDER_WIRE_API=responses in BYOK mode when COPILOT_MODEL is provided via envFile', () => {
        const envFilePath = path.join(mockConfig.workDir, '.env.copilot-model');
        fs.writeFileSync(envFilePath, 'COPILOT_MODEL=openai/o3-mini\n');
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          copilotApiKey: 'cpat_test_byok_key',
          envFile: envFilePath,
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_WIRE_API).toBe('responses');
      });

      it('should not set COPILOT_OFFLINE when only copilotGithubToken is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test_token' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_OFFLINE).toBeUndefined();
      });

      it('should not set COPILOT_PROVIDER_BASE_URL when only copilotGithubToken is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghu_test_token' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_BASE_URL).toBeUndefined();
      });

      it('should pass COPILOT_PROVIDER_TYPE/BASE_URL/API_KEY from additionalEnv to api-proxy', () => {
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          additionalEnv: {
            COPILOT_PROVIDER_TYPE: 'azure',
            COPILOT_PROVIDER_BASE_URL: 'https://example-resource.openai.azure.com/openai/deployments/test',
            COPILOT_PROVIDER_API_KEY: 'azure-byok-key',
          },
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_TYPE).toBe('azure');
        expect(env.COPILOT_PROVIDER_BASE_URL).toBe('https://example-resource.openai.azure.com/openai/deployments/test');
        expect(env.COPILOT_PROVIDER_API_KEY).toBe('azure-byok-key');
      });

      it('should pass COPILOT_PROVIDER_TYPE/BASE_URL/API_KEY from envFile to api-proxy', () => {
        const envFilePath = path.join(mockConfig.workDir, '.env.azure-byok');
        fs.writeFileSync(envFilePath, [
          'COPILOT_PROVIDER_TYPE=azure',
          'COPILOT_PROVIDER_BASE_URL=https://example-resource.openai.azure.com/openai/deployments/test',
          'COPILOT_PROVIDER_API_KEY=azure-byok-key',
        ].join('\n'));
        const configWithProxy = {
          ...mockConfig,
          enableApiProxy: true,
          envFile: envFilePath,
        };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.COPILOT_PROVIDER_TYPE).toBe('azure');
        expect(env.COPILOT_PROVIDER_BASE_URL).toBe('https://example-resource.openai.azure.com/openai/deployments/test');
        expect(env.COPILOT_PROVIDER_API_KEY).toBe('azure-byok-key');
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
        const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
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

      it('should not leak GEMINI_API_KEY to agent when api-proxy is enabled', () => {
        const origKey = process.env.GEMINI_API_KEY;
        process.env.GEMINI_API_KEY = 'AIza-secret-gemini-key';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-secret-gemini-key' };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // Agent should NOT have the real API key — only the sidecar gets it
          expect(env.GEMINI_API_KEY).toBe('gemini-api-key-placeholder-for-credential-isolation');
          // Agent should have both base URL vars to proxy through sidecar
          expect(env.GEMINI_API_BASE_URL).toBe('http://172.30.0.30:10003');
          expect(env.GOOGLE_GEMINI_BASE_URL).toBe('http://172.30.0.30:10003');
        } finally {
          if (origKey !== undefined) {
            process.env.GEMINI_API_KEY = origKey;
          } else {
            delete process.env.GEMINI_API_KEY;
          }
        }
      });

      it('should not leak GEMINI_API_KEY to agent when api-proxy is enabled with envAll', () => {
        const origKey = process.env.GEMINI_API_KEY;
        process.env.GEMINI_API_KEY = 'AIza-secret-gemini-key';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, geminiApiKey: 'AIza-secret-gemini-key', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // Even with envAll, agent should NOT have the real GEMINI_API_KEY
          expect(env.GEMINI_API_KEY).toBe('gemini-api-key-placeholder-for-credential-isolation');
          expect(env.GEMINI_API_BASE_URL).toBe('http://172.30.0.30:10003');
          expect(env.GOOGLE_GEMINI_BASE_URL).toBe('http://172.30.0.30:10003');
        } finally {
          if (origKey !== undefined) {
            process.env.GEMINI_API_KEY = origKey;
          } else {
            delete process.env.GEMINI_API_KEY;
          }
        }
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
});
