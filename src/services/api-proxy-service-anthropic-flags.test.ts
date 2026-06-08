import { generateDockerCompose, WrapperConfig, baseConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;


describe('API proxy sidecar: Anthropic env forwarding', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

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
});
