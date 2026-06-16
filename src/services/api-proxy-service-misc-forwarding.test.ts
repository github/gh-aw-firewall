import { generateDockerCompose, WrapperConfig, baseConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;


describe('API proxy sidecar: miscellaneous env forwarding', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

      describe('Optional WrapperConfig fields propagate to api-proxy env', () => {
        // These cover branches in api-proxy-service-config.ts that were previously
        // untested. Each conditional spread (e.g. `...(config.X && { ... })`) becomes
        // an istanbul branch; setting the field exercises the truthy arm. Without
        // these tests, only the falsy arm is covered and overall branch coverage
        // erodes whenever unrelated covered statements are removed elsewhere in the
        // file (a math-by-construction percentage drop).
        it('should forward requestedModel as AWF_REQUESTED_MODEL', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            requestedModel: 'gpt-4o-2024-08-06',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_REQUESTED_MODEL).toBe('gpt-4o-2024-08-06');
        });

        it('should default AWF_REQUESTED_MODEL from COPILOT_MODEL when requestedModel is unset', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotGithubToken: 'gho_test_token',
            additionalEnv: { COPILOT_MODEL: 'gpt-5-codex' },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_REQUESTED_MODEL).toBe('gpt-5-codex');
        });

        it('should prefer requestedModel over COPILOT_MODEL for AWF_REQUESTED_MODEL', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotGithubToken: 'gho_test_token',
            requestedModel: 'gpt-5.3-codex',
            additionalEnv: { COPILOT_MODEL: 'gpt-5-codex' },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_REQUESTED_MODEL).toBe('gpt-5.3-codex');
        });

        it('should forward copilotByokExtraHeaders as AWF_BYOK_EXTRA_HEADERS', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderApiKey: 'sk-test-key',
            copilotByokExtraHeaders: { 'x-session-id': 'run-42', 'HTTP-Referer': 'https://example.com' },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_BYOK_EXTRA_HEADERS).toBe(
            JSON.stringify({ 'x-session-id': 'run-42', 'HTTP-Referer': 'https://example.com' }),
          );
        });

        it('should forward copilotByokExtraBodyFields as AWF_BYOK_EXTRA_BODY_FIELDS', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderApiKey: 'sk-test-key',
            copilotByokExtraBodyFields: { session_id: 'run-42', user_id: 'octocat' },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_BYOK_EXTRA_BODY_FIELDS).toBe(
            JSON.stringify({ session_id: 'run-42', user_id: 'octocat' }),
          );
        });

        describe('AWF_PROVIDER_SESSION_ID forwarding', () => {
          const sessionIdVars = ['AWF_PROVIDER_SESSION_ID', 'GH_AW_GITHUB_RUN_ID', 'GITHUB_RUN_ID'];
          let savedSessionEnv: Record<string, string | undefined>;

          beforeEach(() => {
            savedSessionEnv = {};
            for (const key of sessionIdVars) {
              savedSessionEnv[key] = process.env[key];
              delete process.env[key];
            }
          });

          afterEach(() => {
            for (const key of sessionIdVars) {
              if (savedSessionEnv[key] !== undefined) process.env[key] = savedSessionEnv[key];
              else delete process.env[key];
            }
          });

          it('should not forward AWF_PROVIDER_SESSION_ID when only GITHUB_RUN_ID is set (auto-derivation removed)', () => {
            process.env.GITHUB_RUN_ID = '123456789';
            const result = generateDockerCompose({ ...mockConfig, enableApiProxy: true }, mockNetworkConfigWithProxy);
            const env = result.services['api-proxy'].environment as Record<string, string>;
            expect(env.AWF_PROVIDER_SESSION_ID).toBeUndefined();
          });

          it('should forward AWF_PROVIDER_SESSION_ID from explicit copilotByokSessionId config', () => {
            const result = generateDockerCompose(
              { ...mockConfig, enableApiProxy: true, copilotByokSessionId: 'explicit-run-42' },
              mockNetworkConfigWithProxy,
            );
            const env = result.services['api-proxy'].environment as Record<string, string>;
            expect(env.AWF_PROVIDER_SESSION_ID).toBe('explicit-run-42');
          });

          it('should forward AWF_PROVIDER_SESSION_ID from explicit process.env when no config value is set', () => {
            process.env.AWF_PROVIDER_SESSION_ID = 'explicit-from-env';
            const result = generateDockerCompose({ ...mockConfig, enableApiProxy: true }, mockNetworkConfigWithProxy);
            const env = result.services['api-proxy'].environment as Record<string, string>;
            expect(env.AWF_PROVIDER_SESSION_ID).toBe('explicit-from-env');
          });
        });

        it('should forward modelAliases as AWF_MODEL_ALIASES (JSON-wrapped)', () => {
          const aliases: Record<string, string[]> = { 'gpt-4o': ['azure/gpt-4o-prod'] };
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            modelAliases: aliases,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_MODEL_ALIASES).toBe(JSON.stringify({ models: aliases }));
        });

        it('should forward modelFallback as AWF_MODEL_FALLBACK (JSON-stringified)', () => {
          const fallback = { enabled: true, strategy: 'middle_power' as const };
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            modelFallback: fallback,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_MODEL_FALLBACK).toBe(JSON.stringify(fallback));
        });

        it('should forward allowedModels as AWF_ALLOWED_MODELS (JSON array)', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            allowedModels: ['*sonnet*', '*haiku*'],
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_ALLOWED_MODELS).toBe(JSON.stringify(['*sonnet*', '*haiku*']));
        });

        it('should not set AWF_ALLOWED_MODELS when allowedModels is empty array', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            allowedModels: [] as string[],
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_ALLOWED_MODELS).toBeUndefined();
        });

        it('should forward disallowedModels as AWF_DISALLOWED_MODELS (JSON array)', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            disallowedModels: ['*opus*', 'gpt-5*'],
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_DISALLOWED_MODELS).toBe(JSON.stringify(['*opus*', 'gpt-5*']));
        });

        it('should not set AWF_DISALLOWED_MODELS when disallowedModels is empty array', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            disallowedModels: [] as string[],
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_DISALLOWED_MODELS).toBeUndefined();
        });

        it('should forward enableTokenSteering as AWF_ENABLE_TOKEN_STEERING=true', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            enableTokenSteering: true,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_ENABLE_TOKEN_STEERING).toBe('true');
        });

        it('should forward debugTokens and tokenLogDir as AWF_DEBUG_TOKENS / AWF_TOKEN_LOG_DIR', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            debugTokens: true,
            tokenLogDir: '/var/log/awf/tokens',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_DEBUG_TOKENS).toBe('1');
          expect(env.AWF_TOKEN_LOG_DIR).toBe('/var/log/awf/tokens');
        });

        it('should forward anthropicAutoCache with cache-tail-ttl as AWF_ANTHROPIC_AUTO_CACHE / TTL', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            anthropicApiKey: 'sk-ant-test',
            anthropicAutoCache: true,
            anthropicCacheTailTtl: '5m' as const,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_ANTHROPIC_AUTO_CACHE).toBe('1');
          expect(env.AWF_ANTHROPIC_CACHE_TAIL_TTL).toBe('5m');
        });

        it('should forward anthropicTokenUrl as AWF_AUTH_ANTHROPIC_TOKEN_URL', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            anthropicApiKey: 'sk-ant-test',
            anthropicTokenUrl: 'https://auth.anthropic.example/oauth/token',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_AUTH_ANTHROPIC_TOKEN_URL).toBe('https://auth.anthropic.example/oauth/token');
        });

        it('should forward captureBlockedRequests as AWF_CAPTURE_BLOCKED_LLM_REQUESTS', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            captureBlockedRequests: 'redacted' as const,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS).toBe('redacted');
        });

        it('should forward captureBlockedRequests=true as AWF_CAPTURE_BLOCKED_LLM_REQUESTS=true', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            captureBlockedRequests: true,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS).toBe('true');
        });

        it('should not set AWF_CAPTURE_BLOCKED_LLM_REQUESTS when captureBlockedRequests is false', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            captureBlockedRequests: false,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS).toBeUndefined();
        });

        it('should forward maxCapturedBytes as AWF_MAX_BLOCKED_CAPTURE_BYTES', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            openaiApiKey: 'sk-test-key',
            captureBlockedRequests: 'full' as const,
            maxCapturedBytes: 500000,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services['api-proxy'].environment as Record<string, string>;
          expect(env.AWF_MAX_BLOCKED_CAPTURE_BYTES).toBe('500000');
        });
      });
});
