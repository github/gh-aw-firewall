import { generateDockerCompose } from '../compose-generator';
import { WrapperConfig } from '../types';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)
const mockExecaFn = jest.fn();
const mockExecaSync = jest.fn();

// Mock execa module
jest.mock('execa', () => {
  const fn = (...args: any[]) => mockExecaFn(...args);
  fn.sync = (...args: any[]) => mockExecaSync(...args);
  return fn;
});

let mockConfig: WrapperConfig;

describe('API proxy sidecar', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

      const mockNetworkConfigWithProxy = {
        ...mockNetworkConfig,
        proxyIp: '172.30.0.30',
      };

      it('should not include api-proxy service when enableApiProxy is false', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfigWithProxy);
        expect(result.services['api-proxy']).toBeUndefined();
      });

      it('should not include api-proxy service when enableApiProxy is true but no proxyIp', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfig);
        expect(result.services['api-proxy']).toBeUndefined();
      });

      it('should include api-proxy service when enableApiProxy is true with OpenAI key', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-openai-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        expect(result.services['api-proxy']).toBeDefined();
        const proxy = result.services['api-proxy'];
        expect(proxy.container_name).toBe('awf-api-proxy');
        expect((proxy.networks as any)['awf-net'].ipv4_address).toBe('172.30.0.30');
      });

      it('should include api-proxy service when enableApiProxy is true with Anthropic key', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        expect(result.services['api-proxy']).toBeDefined();
        const proxy = result.services['api-proxy'];
        expect(proxy.container_name).toBe('awf-api-proxy');
      });

      it('should include api-proxy service with both keys', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-openai-key', anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        expect(result.services['api-proxy']).toBeDefined();
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.OPENAI_API_KEY).toBe('sk-test-openai-key');
        expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
      });

      it('should only pass OpenAI key when only OpenAI key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-openai-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.OPENAI_API_KEY).toBe('sk-test-openai-key');
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      });

      it('should only pass Anthropic key when only Anthropic key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
        expect(env.OPENAI_API_KEY).toBeUndefined();
      });

      it('should use GHCR image by default', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', buildLocal: false };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        expect(proxy.image).toBe('ghcr.io/github/gh-aw-firewall/api-proxy:latest');
        expect(proxy.build).toBeUndefined();
      });

      it('should build locally when buildLocal is true', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', buildLocal: true };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        expect(proxy.build).toBeDefined();
        expect((proxy.build as any).context).toContain('containers/api-proxy');
        expect(proxy.image).toBeUndefined();
      });

      it('should use custom registry and tag', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', buildLocal: false, imageRegistry: 'my-registry.com', imageTag: 'v1.0.0' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        expect(proxy.image).toBe('my-registry.com/api-proxy:v1.0.0');
      });

      it('should configure healthcheck for api-proxy', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        expect(proxy.healthcheck).toBeDefined();
        const healthcheck = proxy.healthcheck!;
        expect(healthcheck.test).toEqual(['CMD', 'curl', '-f', 'http://localhost:10000/health']);
        expect(healthcheck.timeout).toBe('3s');
        expect(healthcheck.retries).toBe(15);
        expect(healthcheck.start_period).toBe('30s');
      });

      it('should drop all capabilities', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        expect(proxy.cap_drop).toEqual(['ALL']);
        expect(proxy.security_opt).toContain('no-new-privileges:true');
      });

      it('should set stop_grace_period on api-proxy service', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'] as any;
        expect(proxy.stop_grace_period).toBe('2s');
      });

      it('should set resource limits', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        expect(proxy.mem_limit).toBe('512m');
        expect(proxy.memswap_limit).toBe('512m');
        expect(proxy.pids_limit).toBe(100);
        expect(proxy.cpu_shares).toBe(512);
      });

      it('should update agent depends_on to wait for api-proxy', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const dependsOn = agent.depends_on as { [key: string]: { condition: string } };
        expect(dependsOn['api-proxy']).toBeDefined();
        expect(dependsOn['api-proxy'].condition).toBe('service_healthy');
      });

      it('should set OPENAI_BASE_URL in agent when OpenAI key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
      });

      it('should configure HTTP_PROXY and HTTPS_PROXY in api-proxy to route through Squid', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.HTTP_PROXY).toBe('http://172.30.0.10:3128');
        expect(env.HTTPS_PROXY).toBe('http://172.30.0.10:3128');
      });

      it('should set ANTHROPIC_BASE_URL in agent when Anthropic key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
        expect(env.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
      });

      it('should set both ANTHROPIC_BASE_URL and OPENAI_BASE_URL when both keys are provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-openai-key', anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
        expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
        expect(env.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
      });

      it('should not set OPENAI_BASE_URL in agent when only Anthropic key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.OPENAI_BASE_URL).toBeUndefined();
        expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
        expect(env.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
      });

      it('should set OPENAI_BASE_URL and not set ANTHROPIC_BASE_URL when only OpenAI key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
      });

      it('should set AWF_API_PROXY_IP in agent environment', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.AWF_API_PROXY_IP).toBe('172.30.0.30');
      });

      it('should set NO_PROXY to include api-proxy IP', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.NO_PROXY).toContain('172.30.0.30');
        expect(env.no_proxy).toContain('172.30.0.30');
      });

      it('should set CLAUDE_CODE_API_KEY_HELPER when Anthropic key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
      });

      it('should not set CLAUDE_CODE_API_KEY_HELPER when only OpenAI key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.CLAUDE_CODE_API_KEY_HELPER).toBeUndefined();
      });

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

      it('should set AWF_ENABLE_OPENCODE=true in api-proxy when enableOpenCode is true', () => {
        const configWithOpenCode = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', enableOpenCode: true };
        const result = generateDockerCompose(configWithOpenCode, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_ENABLE_OPENCODE).toBe('true');
      });

      it('should not set AWF_ENABLE_OPENCODE in api-proxy when enableOpenCode is false', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key', enableOpenCode: false };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_ENABLE_OPENCODE).toBeUndefined();
      });

      it('should not set AWF_ENABLE_OPENCODE in api-proxy when enableOpenCode is undefined', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_ENABLE_OPENCODE).toBeUndefined();
      });

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
        expect(env.COPILOT_TOKEN).toBe('placeholder-token-for-credential-isolation');
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
        expect(env.COPILOT_PROVIDER_API_KEY).toBe('placeholder-token-for-credential-isolation');
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
});
