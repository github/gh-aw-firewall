import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir } from './service-test-setup.test-utils';
import { mockNetworkConfigWithProxy } from './api-proxy-service.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('API proxy sidecar: service configuration', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

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

      it('should set ANTHROPIC_BASE_URL in agent for Anthropic github-oidc auth without static key', () => {
        const originalAuthType = process.env.AWF_AUTH_TYPE;
        const originalAuthProvider = process.env.AWF_AUTH_PROVIDER;
        process.env.AWF_AUTH_TYPE = 'github-oidc';
        process.env.AWF_AUTH_PROVIDER = 'anthropic';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
          expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
          expect(env.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
        } finally {
          if (originalAuthType !== undefined) {
            process.env.AWF_AUTH_TYPE = originalAuthType;
          } else {
            delete process.env.AWF_AUTH_TYPE;
          }
          if (originalAuthProvider !== undefined) {
            process.env.AWF_AUTH_PROVIDER = originalAuthProvider;
          } else {
            delete process.env.AWF_AUTH_PROVIDER;
          }
        }
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

      it('should set NO_PROXY to include api-proxy IP and hostname', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.NO_PROXY).toContain('172.30.0.30');
        expect(env.NO_PROXY).toContain('api-proxy');
        expect(env.no_proxy).toContain('172.30.0.30');
        expect(env.no_proxy).toContain('api-proxy');
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
});
