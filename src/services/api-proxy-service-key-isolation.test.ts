import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';
import { NetworkConfig } from './squid-service';
import { resolveApiCredentials } from '../commands/resolve-credentials';
import * as fs from 'fs';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('API proxy sidecar: API key isolation', () => {
  const withEnvVar = (name: keyof NodeJS.ProcessEnv, value: string, assertion: () => void): void => {
    const original = process.env[name];
    process.env[name] = value;
    try {
      assertion();
    } finally {
      if (original !== undefined) {
        process.env[name] = original;
      } else {
        delete process.env[name];
      }
    }
  };

  const getAgentEnvironment = (
    config: WrapperConfig,
    networkConfig: NetworkConfig = mockNetworkConfigWithProxy
  ): NodeJS.ProcessEnv => {
    const result = generateDockerCompose(config, networkConfig);
    return result.services.agent.environment ?? {};
  };

  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

  it.each([
    ['openai', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 10000],
    ['anthropic', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 10001],
    ['copilot', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BASE_URL', 10002],
    ['gemini', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 10003],
    ['vertex', 'GOOGLE_API_KEY', 'GOOGLE_VERTEX_BASE_URL', 10004],
  ])('passes the neutral key only to the %s sidecar path', (provider, nativeKey, baseUrlKey, port) => {
    withEnvVar('AWF_AGENT_API_KEY', 'test-neutral-key', () => {
      withEnvVar('AWF_AGENT_API_PROVIDER', String(provider), () => {
        withEnvVar(String(nativeKey), '', () => {
          const config = {
            ...mockConfig,
            enableApiProxy: true,
            envAll: true,
            ...resolveApiCredentials({ enableApiProxy: true }),
          };
          const result = generateDockerCompose(config, mockNetworkConfigWithProxy);
          const agentEnv = result.services.agent.environment ?? {};
          const proxyEnv = result.services['api-proxy'].environment ?? {};

          expect(proxyEnv[nativeKey]).toBe('test-neutral-key');
          expect(proxyEnv.AWF_AGENT_API_KEY).toBeUndefined();
          expect(agentEnv.AWF_AGENT_API_KEY).toBeUndefined();
          expect(Object.values(agentEnv)).not.toContain('test-neutral-key');
          expect(agentEnv[baseUrlKey]).toBe(`http://172.30.0.30:${port}`);
        });
      });
    });
  });

  it.each(['AWF_AGENT_API_KEY', 'AGENT_API_KEY'])('excludes %s from host env-all passthrough', (key) => {
    withEnvVar(key, 'test-neutral-key', () => {
      const env = getAgentEnvironment({ ...mockConfig, enableApiProxy: true, envAll: true });
      expect(env[key]).toBeUndefined();
    });
  });

  it.each(['AWF_AGENT_API_KEY', 'AGENT_API_KEY'])('excludes %s from explicit additionalEnv', (key) => {
    const env = getAgentEnvironment({
      ...mockConfig,
      enableApiProxy: true,
      additionalEnv: { [key]: 'test-neutral-key' },
    });
    expect(env[key]).toBeUndefined();
  });

  it.each(['AWF_AGENT_API_KEY', 'AGENT_API_KEY'])('excludes %s from env-file passthrough', (key) => {
    const envFile = path.join(mockConfig.workDir, 'neutral-key.env');
    fs.writeFileSync(envFile, `${key}=test-neutral-key\n`);

    const env = getAgentEnvironment({ ...mockConfig, enableApiProxy: true, envFile });
    expect(env[key]).toBeUndefined();
  });

      it('should not leak ANTHROPIC_API_KEY to agent when api-proxy is enabled', () => {
        // Simulate the key being in process.env (as it would be in real usage)
        withEnvVar('ANTHROPIC_API_KEY', 'sk-ant-secret-key', () => {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-secret-key' };
          const env = getAgentEnvironment(configWithProxy);
          // Agent should NOT have the raw API key — only the sidecar gets it
          expect(env.ANTHROPIC_API_KEY).toBeUndefined();
          // Agent should have the BASE_URL to reach the sidecar instead
          expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
          // Agent should have placeholder token for Claude Code compatibility
          expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
        });
      });

      it('should not leak OPENAI_API_KEY to agent when api-proxy is enabled', () => {
        // Simulate the key being in process.env (as it would be in real usage)
        withEnvVar('OPENAI_API_KEY', 'sk-secret-key', () => {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-secret-key' };
          const env = getAgentEnvironment(configWithProxy);
          // Agent should NOT have the real API key — only the sidecar holds it.
          // A placeholder is injected so Codex/OpenAI clients route through OPENAI_BASE_URL
          // (Codex v0.121+ bypasses OPENAI_BASE_URL when no key is present in the env).
          expect(env.OPENAI_API_KEY).toBe('sk-placeholder-for-api-proxy');
          expect(env.OPENAI_API_KEY).not.toBe('sk-secret-key');
          // Agent should have OPENAI_BASE_URL to proxy through sidecar
          expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
        });
      });

      it('should not leak CODEX_API_KEY to agent when api-proxy is enabled with envAll', () => {
        // Simulate the key being in process.env AND envAll enabled.
        // The host's real CODEX_API_KEY must not reach the agent; a placeholder is
        // injected instead so Codex routes through OPENAI_BASE_URL (api-proxy).
        withEnvVar('CODEX_API_KEY', 'sk-codex-secret', () => {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test', envAll: true };
          const env = getAgentEnvironment(configWithProxy);
          // CODEX_API_KEY placeholder is set; the real host key must not be present
          expect(env.CODEX_API_KEY).toBe('sk-placeholder-for-api-proxy');
          expect(env.CODEX_API_KEY).not.toBe('sk-codex-secret');
          // OPENAI_BASE_URL should be set when api-proxy is enabled with openaiApiKey
          expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
        });
      });

      it('should not leak OPENAI_API_KEY to agent when api-proxy is enabled with envAll', () => {
        // Simulate envAll scenario (smoke-codex uses --env-all).
        // Even with envAll, the real key must not reach the agent; a placeholder is used instead.
        withEnvVar('OPENAI_API_KEY', 'sk-openai-secret', () => {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-openai-secret', envAll: true };
          const env = getAgentEnvironment(configWithProxy);
          // Placeholder is set; real key must not be passed to agent
          expect(env.OPENAI_API_KEY).toBe('sk-placeholder-for-api-proxy');
          expect(env.OPENAI_API_KEY).not.toBe('sk-openai-secret');
          // Agent should have OPENAI_BASE_URL to proxy through sidecar
          expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
        });
      });

      it('should not leak ANTHROPIC_API_KEY to agent when api-proxy is enabled with envAll', () => {
        withEnvVar('ANTHROPIC_API_KEY', 'sk-ant-secret', () => {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-secret', envAll: true };
          const env = getAgentEnvironment(configWithProxy);
          // Even with envAll, agent should NOT have ANTHROPIC_API_KEY when api-proxy is enabled
          expect(env.ANTHROPIC_API_KEY).toBeUndefined();
          expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
          // But should have placeholder token for Claude Code compatibility
          expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
        });
      });

      it('should not leak host ANTHROPIC_AUTH_TOKEN to agent when api-proxy is enabled with envAll', () => {
        withEnvVar('ANTHROPIC_AUTH_TOKEN', 'sk-ant-p-host-secret', () => {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-secret', envAll: true };
          const env = getAgentEnvironment(configWithProxy);
          expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
          expect(env.ANTHROPIC_AUTH_TOKEN).not.toBe('sk-ant-p-host-secret');
        });
      });

      it('should pass GITHUB_API_URL to agent when api-proxy is enabled with envAll', () => {
        // GITHUB_API_URL must remain in the agent environment even when api-proxy is enabled.
        // The Copilot CLI needs it to locate the GitHub API (token exchange, user info, etc.).
        // Copilot-specific calls route through COPILOT_API_URL → api-proxy regardless.
        // See: github/gh-aw#20875
        withEnvVar('GITHUB_API_URL', 'https://api.github.com', () => {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghp_test_token', envAll: true };
          const env = getAgentEnvironment(configWithProxy);
          // GITHUB_API_URL should be passed to agent even when api-proxy is enabled
          expect(env.GITHUB_API_URL).toBe('https://api.github.com');
          // COPILOT_API_URL should also be set to route Copilot calls through the api-proxy
          expect(env.COPILOT_API_URL).toBe('http://172.30.0.30:10002');
        });
      });

      it('should pass GITHUB_API_URL to agent when api-proxy is NOT enabled with envAll', () => {
        withEnvVar('GITHUB_API_URL', 'https://api.github.com', () => {
          const configNoProxy = { ...mockConfig, enableApiProxy: false, envAll: true };
          const env = getAgentEnvironment(configNoProxy, mockNetworkConfig);
          // When api-proxy is NOT enabled, GITHUB_API_URL should be passed through
          expect(env.GITHUB_API_URL).toBe('https://api.github.com');
        });
      });
});
