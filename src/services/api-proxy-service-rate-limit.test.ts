import { generateDockerCompose, WrapperConfig, baseConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('API proxy sidecar: rate limiting and token guard', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

      it('should set AWF_RATE_LIMIT env vars when rateLimitConfig is provided', () => {
        const configWithRateLimit = {
          ...mockConfig,
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
          rateLimitConfig: { enabled: true, rpm: 30, rph: 500, bytesPm: 10485760 },
        };
        const result = generateDockerCompose(configWithRateLimit, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_RATE_LIMIT_ENABLED).toBe('true');
        expect(env.AWF_RATE_LIMIT_RPM).toBe('30');
        expect(env.AWF_RATE_LIMIT_RPH).toBe('500');
        expect(env.AWF_RATE_LIMIT_BYTES_PM).toBe('10485760');
      });

      it('should set AWF_RATE_LIMIT_ENABLED=false when rate limiting is disabled', () => {
        const configWithRateLimit = {
          ...mockConfig,
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
          rateLimitConfig: { enabled: false, rpm: 60, rph: 1000, bytesPm: 52428800 },
        };
        const result = generateDockerCompose(configWithRateLimit, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_RATE_LIMIT_ENABLED).toBe('false');
      });

      it('should not set rate limit env vars when rateLimitConfig is not provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_RATE_LIMIT_ENABLED).toBeUndefined();
        expect(env.AWF_RATE_LIMIT_RPM).toBeUndefined();
        expect(env.AWF_RATE_LIMIT_RPH).toBeUndefined();
        expect(env.AWF_RATE_LIMIT_BYTES_PM).toBeUndefined();
      });

      it('should set effective token guard env vars when configured', () => {
        const configWithEtGuard = {
          ...mockConfig,
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
          maxEffectiveTokens: 5000,
          effectiveTokenModelMultipliers: {
            'gpt-4o': 2,
            'claude-sonnet-4': 1.5,
          },
          effectiveTokenDefaultModelMultiplier: 27,
          maxModelMultiplierCap: 4,
        };
        const result = generateDockerCompose(configWithEtGuard, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_MAX_EFFECTIVE_TOKENS).toBe('5000');
        expect(env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS).toBe('{"gpt-4o":2,"claude-sonnet-4":1.5}');
        expect(env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER).toBe('27');
        expect(env.AWF_MAX_MODEL_MULTIPLIER).toBe('4');
      });

      it('should set AWF_MAX_MODEL_MULTIPLIER when maxModelMultiplierCap is configured', () => {
        const configWithCap = {
          ...mockConfig,
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
          maxModelMultiplierCap: 5,
        };
        const result = generateDockerCompose(configWithCap, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_MAX_MODEL_MULTIPLIER).toBe('5');
      });

      it('should not set AWF_MAX_MODEL_MULTIPLIER when maxModelMultiplierCap is not configured', () => {
        const result = generateDockerCompose({ ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' }, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_MAX_MODEL_MULTIPLIER).toBeUndefined();
      });

      it('should set AWF_MAX_RUNS in api-proxy when maxRuns is configured', () => {
        const configWithMaxRuns = {
          ...mockConfig,
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
          maxRuns: 25,
        };
        const result = generateDockerCompose(configWithMaxRuns, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_MAX_RUNS).toBe('25');
      });

      it('should not set AWF_MAX_RUNS in api-proxy when maxRuns is not configured', () => {
        const result = generateDockerCompose({ ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' }, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_MAX_RUNS).toBeUndefined();
      });

      it('should set AWF_AGENT_TIMEOUT_MINUTES in api-proxy when agentTimeout is configured', () => {
        const configWithAgentTimeout = {
          ...mockConfig,
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
          agentTimeout: 30,
        };
        const result = generateDockerCompose(configWithAgentTimeout, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_AGENT_TIMEOUT_MINUTES).toBe('30');
      });

      it('should set AWF_MODEL_FALLBACK when modelFallback is configured', () => {
        const configWithModelFallback = {
          ...mockConfig,
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
          modelFallback: { enabled: false, strategy: 'middle_power' as const },
        };
        const result = generateDockerCompose(configWithModelFallback, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_MODEL_FALLBACK).toBe('{"enabled":false,"strategy":"middle_power"}');
      });

      it('should not set AWF_AGENT_TIMEOUT_MINUTES in api-proxy when agentTimeout is not configured', () => {
        const result = generateDockerCompose({ ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' }, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_AGENT_TIMEOUT_MINUTES).toBeUndefined();
      });

});
