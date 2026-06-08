import { generateDockerCompose, WrapperConfig, baseConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';
import * as fs from 'fs';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;


describe('API proxy sidecar: BYOK env forwarding', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

      describe('config-driven modelRouter.baseUrl triggers agent-side BYOK routing', () => {
        // When apiProxy.modelRouter.baseUrl is set in AWF config (stored as
        // config.copilotProviderBaseUrl), the agent must be routed through the sidecar
        // the same way it would be when COPILOT_PROVIDER_BASE_URL is supplied via
        // --env / --env-file / --env-all. Without this wiring, the sidecar env is
        // configured but COPILOT_OFFLINE / agent COPILOT_PROVIDER_BASE_URL are never
        // set, so Copilot CLI would bypass the proxy entirely.

        it('should set agent COPILOT_PROVIDER_BASE_URL to sidecar URL', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderBaseUrl: 'https://example-resource.openai.azure.com/openai/deployments/my-router',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          expect(env.COPILOT_PROVIDER_BASE_URL).toBe('http://172.30.0.30:10002');
        });

        it('should set agent COPILOT_OFFLINE=true', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderBaseUrl: 'https://example-resource.openai.azure.com/openai/deployments/my-router',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          expect(env.COPILOT_OFFLINE).toBe('true');
        });

        it('should forward the real baseUrl to the sidecar', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderBaseUrl: 'https://example-resource.openai.azure.com/openai/deployments/my-router',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxyEnv = result.services['api-proxy'].environment as Record<string, string>;
          expect(proxyEnv.COPILOT_PROVIDER_BASE_URL).toBe('https://example-resource.openai.azure.com/openai/deployments/my-router');
        });

        it('should NOT inject a COPILOT_PROVIDER_API_KEY placeholder when no key was supplied', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderBaseUrl: 'https://example-resource.openai.azure.com/openai/deployments/my-router',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          expect(env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
        });
      });

      describe('direct-BYOK mode (user-supplied COPILOT_PROVIDER_API_KEY without COPILOT_GITHUB_TOKEN)', () => {
        // When the user points Copilot CLI at an arbitrary upstream (Azure Foundry,
        // OpenRouter, etc.) via COPILOT_PROVIDER_BASE_URL + COPILOT_PROVIDER_API_KEY,
        // AWF must still:
        //   1. Route the agent's Copilot CLI through the sidecar (set agent
        //      COPILOT_PROVIDER_BASE_URL=http://sidecar, COPILOT_OFFLINE=true).
        //   2. Forward the user's real COPILOT_PROVIDER_BASE_URL to the sidecar and the
        //      real COPILOT_PROVIDER_API_KEY from config (so it knows the real upstream
        //      and credential).
        //   3. Replace COPILOT_PROVIDER_API_KEY in the agent env with a placeholder so
        //      the real key never reaches the agent.

        it('should set agent COPILOT_PROVIDER_BASE_URL to sidecar URL', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderApiKey: 'azure-byok-key',
            additionalEnv: {
              COPILOT_PROVIDER_BASE_URL: 'https://example-resource.openai.azure.com/openai/deployments/test',
            },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          expect(env.COPILOT_PROVIDER_BASE_URL).toBe('http://172.30.0.30:10002');
        });

        it('should set agent COPILOT_OFFLINE=true', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderApiKey: 'azure-byok-key',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          expect(env.COPILOT_OFFLINE).toBe('true');
        });

        it('should mask real COPILOT_PROVIDER_API_KEY in agent env with placeholder', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderApiKey: 'azure-byok-key',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          expect(env.COPILOT_PROVIDER_API_KEY).toBe('ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
          expect(env.COPILOT_PROVIDER_API_KEY).not.toBe('azure-byok-key');
        });

        it('should still forward the real COPILOT_PROVIDER_API_KEY to the sidecar', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderApiKey: 'azure-byok-key',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxyEnv = result.services['api-proxy'].environment as Record<string, string>;
          expect(proxyEnv.COPILOT_PROVIDER_API_KEY).toBe('azure-byok-key');
        });

        it('should NOT set agent COPILOT_GITHUB_TOKEN placeholder when no GitHub token was provided', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            copilotProviderApiKey: 'azure-byok-key',
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          // GitHub token placeholder is only set when the user actually supplied a token
          // to mask. In direct-BYOK mode there is nothing to mask.
          expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
        });
      });

      describe('COPILOT_PROVIDER_BASE_URL-only trigger (defense-in-depth)', () => {
        // When the user supplies only COPILOT_PROVIDER_BASE_URL (no key, no GitHub
        // token), AWF still routes the agent's Copilot CLI through the sidecar so
        // the real BASE_URL never leaks into the agent env. The sidecar itself does
        // not yet support unauthenticated upstreams, but routing here preserves the
        // credential-isolation invariant and produces a clear 503 from the sidecar
        // rather than a silent direct connection.

        it('should set agent COPILOT_PROVIDER_BASE_URL to sidecar URL', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            additionalEnv: {
              COPILOT_PROVIDER_BASE_URL: 'http://intranet-llm.example/v1',
            },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          expect(env.COPILOT_PROVIDER_BASE_URL).toBe('http://172.30.0.30:10002');
        });

        it('should set agent COPILOT_OFFLINE=true', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            additionalEnv: {
              COPILOT_PROVIDER_BASE_URL: 'http://intranet-llm.example/v1',
            },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          expect(env.COPILOT_OFFLINE).toBe('true');
        });

        it('should NOT inject a COPILOT_PROVIDER_API_KEY placeholder when no key was supplied', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            additionalEnv: {
              COPILOT_PROVIDER_BASE_URL: 'http://intranet-llm.example/v1',
            },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          // Nothing to mask → no placeholder. Injecting one would falsely tell
          // Copilot CLI a key is configured.
          expect(env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
        });

        it('should forward the real COPILOT_PROVIDER_BASE_URL to the sidecar', () => {
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            additionalEnv: {
              COPILOT_PROVIDER_BASE_URL: 'http://intranet-llm.example/v1',
            },
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const proxyEnv = result.services['api-proxy'].environment as Record<string, string>;
          expect(proxyEnv.COPILOT_PROVIDER_BASE_URL).toBe('http://intranet-llm.example/v1');
        });

        it('should fire from envFile (not just additionalEnv)', () => {
          const envFilePath = path.join(mockConfig.workDir, '.env.copilot-base-url-only');
          fs.writeFileSync(envFilePath, 'COPILOT_PROVIDER_BASE_URL=http://intranet-llm.example/v1\n');
          const configWithProxy = {
            ...mockConfig,
            enableApiProxy: true,
            envFile: envFilePath,
          };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const env = result.services.agent.environment as Record<string, string>;
          expect(env.COPILOT_PROVIDER_BASE_URL).toBe('http://172.30.0.30:10002');
          expect(env.COPILOT_OFFLINE).toBe('true');
        });
      });
});
