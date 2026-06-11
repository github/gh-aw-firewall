import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('API proxy sidecar: API key isolation', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

      it('should not leak ANTHROPIC_API_KEY to agent when api-proxy is enabled', () => {
        // Simulate the key being in process.env (as it would be in real usage)
        const origKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-key';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-secret-key' };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // Agent should NOT have the raw API key — only the sidecar gets it
          expect(env.ANTHROPIC_API_KEY).toBeUndefined();
          // Agent should have the BASE_URL to reach the sidecar instead
          expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
          // Agent should have placeholder token for Claude Code compatibility
          expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
        } finally {
          if (origKey !== undefined) {
            process.env.ANTHROPIC_API_KEY = origKey;
          } else {
            delete process.env.ANTHROPIC_API_KEY;
          }
        }
      });

      it('should not leak OPENAI_API_KEY to agent when api-proxy is enabled', () => {
        // Simulate the key being in process.env (as it would be in real usage)
        const origKey = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = 'sk-secret-key';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-secret-key' };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // Agent should NOT have the real API key — only the sidecar holds it.
          // A placeholder is injected so Codex/OpenAI clients route through OPENAI_BASE_URL
          // (Codex v0.121+ bypasses OPENAI_BASE_URL when no key is present in the env).
          expect(env.OPENAI_API_KEY).toBe('sk-placeholder-for-api-proxy');
          expect(env.OPENAI_API_KEY).not.toBe('sk-secret-key');
          // Agent should have OPENAI_BASE_URL to proxy through sidecar
          expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
        } finally {
          if (origKey !== undefined) {
            process.env.OPENAI_API_KEY = origKey;
          } else {
            delete process.env.OPENAI_API_KEY;
          }
        }
      });

      it('should not leak CODEX_API_KEY to agent when api-proxy is enabled with envAll', () => {
        // Simulate the key being in process.env AND envAll enabled.
        // The host's real CODEX_API_KEY must not reach the agent; a placeholder is
        // injected instead so Codex routes through OPENAI_BASE_URL (api-proxy).
        const origKey = process.env.CODEX_API_KEY;
        process.env.CODEX_API_KEY = 'sk-codex-secret';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // CODEX_API_KEY placeholder is set; the real host key must not be present
          expect(env.CODEX_API_KEY).toBe('sk-placeholder-for-api-proxy');
          expect(env.CODEX_API_KEY).not.toBe('sk-codex-secret');
          // OPENAI_BASE_URL should be set when api-proxy is enabled with openaiApiKey
          expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
        } finally {
          if (origKey !== undefined) {
            process.env.CODEX_API_KEY = origKey;
          } else {
            delete process.env.CODEX_API_KEY;
          }
        }
      });

      it('should not leak OPENAI_API_KEY to agent when api-proxy is enabled with envAll', () => {
        // Simulate envAll scenario (smoke-codex uses --env-all).
        // Even with envAll, the real key must not reach the agent; a placeholder is used instead.
        const origKey = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = 'sk-openai-secret';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-openai-secret', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // Placeholder is set; real key must not be passed to agent
          expect(env.OPENAI_API_KEY).toBe('sk-placeholder-for-api-proxy');
          expect(env.OPENAI_API_KEY).not.toBe('sk-openai-secret');
          // Agent should have OPENAI_BASE_URL to proxy through sidecar
          expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
        } finally {
          if (origKey !== undefined) {
            process.env.OPENAI_API_KEY = origKey;
          } else {
            delete process.env.OPENAI_API_KEY;
          }
        }
      });

      it('should not leak ANTHROPIC_API_KEY to agent when api-proxy is enabled with envAll', () => {
        const origKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-secret', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // Even with envAll, agent should NOT have ANTHROPIC_API_KEY when api-proxy is enabled
          expect(env.ANTHROPIC_API_KEY).toBeUndefined();
          expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
          // But should have placeholder token for Claude Code compatibility
          expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
        } finally {
          if (origKey !== undefined) {
            process.env.ANTHROPIC_API_KEY = origKey;
          } else {
            delete process.env.ANTHROPIC_API_KEY;
          }
        }
      });

      it('should pass GITHUB_API_URL to agent when api-proxy is enabled with envAll', () => {
        // GITHUB_API_URL must remain in the agent environment even when api-proxy is enabled.
        // The Copilot CLI needs it to locate the GitHub API (token exchange, user info, etc.).
        // Copilot-specific calls route through COPILOT_API_URL → api-proxy regardless.
        // See: github/gh-aw#20875
        const origUrl = process.env.GITHUB_API_URL;
        process.env.GITHUB_API_URL = 'https://api.github.com';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotGithubToken: 'ghp_test_token', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // GITHUB_API_URL should be passed to agent even when api-proxy is enabled
          expect(env.GITHUB_API_URL).toBe('https://api.github.com');
          // COPILOT_API_URL should also be set to route Copilot calls through the api-proxy
          expect(env.COPILOT_API_URL).toBe('http://172.30.0.30:10002');
        } finally {
          if (origUrl !== undefined) {
            process.env.GITHUB_API_URL = origUrl;
          } else {
            delete process.env.GITHUB_API_URL;
          }
        }
      });

      it('should pass GITHUB_API_URL to agent when api-proxy is NOT enabled with envAll', () => {
        const origUrl = process.env.GITHUB_API_URL;
        process.env.GITHUB_API_URL = 'https://api.github.com';
        try {
          const configNoProxy = { ...mockConfig, enableApiProxy: false, envAll: true };
          const result = generateDockerCompose(configNoProxy, mockNetworkConfig);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // When api-proxy is NOT enabled, GITHUB_API_URL should be passed through
          expect(env.GITHUB_API_URL).toBe('https://api.github.com');
        } finally {
          if (origUrl !== undefined) {
            process.env.GITHUB_API_URL = origUrl;
          } else {
            delete process.env.GITHUB_API_URL;
          }
        }
      });
});
