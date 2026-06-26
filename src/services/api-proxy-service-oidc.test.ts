import { generateDockerCompose, WrapperConfig, baseConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;


describe('API proxy sidecar: OIDC env forwarding', () => {
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

        it('should forward ACTIONS_ID_TOKEN_REQUEST_* when config.authType is github-oidc (config-file path)', () => {
          process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.local/token';
          process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'runtime-token';
          const config = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-openai-test', authType: 'github-oidc' };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_AUTH_TYPE).toBe('github-oidc');
          expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://actions.local/token');
          expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('runtime-token');
        });

        it('should forward Azure OIDC auth fields from config', () => {
          const config = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-openai-test',
            authType: 'github-oidc',
            authProvider: 'azure',
            authAzureTenantId: 'tenant-uuid',
            authAzureClientId: 'client-uuid',
          };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_AUTH_TYPE).toBe('github-oidc');
          expect(env.AWF_AUTH_PROVIDER).toBe('azure');
          expect(env.AWF_AUTH_AZURE_TENANT_ID).toBe('tenant-uuid');
          expect(env.AWF_AUTH_AZURE_CLIENT_ID).toBe('client-uuid');
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
});
