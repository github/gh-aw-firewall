import { generateDockerCompose } from '../docker-manager';
import { WrapperConfig } from '../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Create mock functions
const mockExecaFn = jest.fn();
const mockExecaSync = jest.fn();

// Mock execa module
jest.mock('execa', () => {
  const fn = (...args: any[]) => mockExecaFn(...args);
  fn.sync = (...args: any[]) => mockExecaSync(...args);
  return fn;
});

const baseConfig: Omit<WrapperConfig, 'workDir'> = {
  allowedDomains: ['github.com', 'npmjs.org'],
  agentCommand: 'echo "test"',
  logLevel: 'info',
  keepContainers: false,
  buildLocal: false,
  imageRegistry: 'ghcr.io/github/gh-aw-firewall',
  imageTag: 'latest',
};

let mockConfig: WrapperConfig;

const mockNetworkConfig = {
  subnet: '172.30.0.0/24',
  squidIp: '172.30.0.10',
  agentIp: '172.30.0.20',
};

describe('CLI proxy sidecar (external DIFC proxy)', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

      const mockNetworkConfigWithCliProxy = {
        ...mockNetworkConfig,
        cliProxyIp: '172.30.0.50',
      };

      it('should not include cli-proxy service when difcProxyHost is not set', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfigWithCliProxy);
        expect(result.services['cli-proxy']).toBeUndefined();
      });

      it('should not include cli-proxy service when difcProxyHost is set but no cliProxyIp', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfig);
        expect(result.services['cli-proxy']).toBeUndefined();
      });

      it('should include cli-proxy service when difcProxyHost is set with cliProxyIp', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        expect(result.services['cli-proxy']).toBeDefined();
        const proxy = result.services['cli-proxy'];
        expect(proxy.container_name).toBe('awf-cli-proxy');
        // cli-proxy gets its own IP on awf-net (no shared network namespace)
        expect((proxy.networks as any)['awf-net'].ipv4_address).toBe('172.30.0.50');
        expect(proxy.network_mode).toBeUndefined();
      });

      it('should not include cli-proxy-mcpg service (mcpg runs externally)', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        expect(result.services['cli-proxy-mcpg']).toBeUndefined();
      });

      it('should not add cli-proxy-tls named volume (CA cert is bind-mounted)', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        expect(result.volumes).toBeUndefined();
      });

      it('should include extra_hosts for host.docker.internal', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        expect(proxy.extra_hosts).toContain('host.docker.internal:host-gateway');
      });

      it('should mount CA cert as read-only volume when difcProxyCaCert is set', () => {
        const configWithCliProxy = {
          ...mockConfig,
          difcProxyHost: 'host.docker.internal:18443',
          difcProxyCaCert: '/tmp/difc-proxy-tls/ca.crt',
        };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        expect(proxy.volumes).toContainEqual('/tmp/difc-proxy-tls/ca.crt:/tmp/proxy-tls/ca.crt:ro');
      });

      it('should not mount CA cert when difcProxyCaCert is not set', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const volumes = proxy.volumes as string[];
        expect(volumes.some((v: string) => v.includes('ca.crt'))).toBe(false);
      });

      it('should set AWF_DIFC_PROXY_HOST and AWF_DIFC_PROXY_PORT env vars', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_DIFC_PROXY_HOST).toBe('host.docker.internal');
        expect(env.AWF_DIFC_PROXY_PORT).toBe('18443');
      });

      it('should parse custom host and port from difcProxyHost', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'custom-host:9999' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_DIFC_PROXY_HOST).toBe('custom-host');
        expect(env.AWF_DIFC_PROXY_PORT).toBe('9999');
      });

      it('should parse IPv6 bracketed host:port from difcProxyHost', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: '[::1]:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_DIFC_PROXY_HOST).toBe('::1');
        expect(env.AWF_DIFC_PROXY_PORT).toBe('18443');
      });

      it('should default port to 18443 when only host is specified', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'my-host' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_DIFC_PROXY_HOST).toBe('my-host');
        expect(env.AWF_DIFC_PROXY_PORT).toBe('18443');
      });

      it('should throw on invalid difcProxyHost value', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: ':::invalid' };
        expect(() => generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy))
          .toThrow('Invalid --difc-proxy-host');
      });

      it('should include host.docker.internal in NO_PROXY', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.NO_PROXY).toContain('host.docker.internal');
        expect(env.no_proxy).toContain('host.docker.internal');
      });

      it('should configure healthcheck for cli-proxy', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        expect(proxy.healthcheck).toBeDefined();
        expect((proxy.healthcheck as any).test).toEqual(['CMD', 'curl', '-f', 'http://localhost:11000/health']);
      });

      it('should drop all capabilities from cli-proxy', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        expect(proxy.cap_drop).toEqual(['ALL']);
        expect(proxy.security_opt).toContain('no-new-privileges:true');
      });

      it('should update agent depends_on to wait for cli-proxy', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const dependsOn = result.services['agent'].depends_on as Record<string, any>;
        expect(dependsOn['cli-proxy']).toBeDefined();
        expect(dependsOn['cli-proxy'].condition).toBe('service_healthy');
      });

      it('should set AWF_CLI_PROXY_URL in agent environment using cli-proxy IP', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const agent = result.services['agent'];
        const env = agent.environment as Record<string, string>;
        expect(env.AWF_CLI_PROXY_URL).toBe('http://172.30.0.50:11000');
      });

      it('should set AWF_CLI_PROXY_IP in agent environment using cli-proxy IP', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const agent = result.services['agent'];
        const env = agent.environment as Record<string, string>;
        expect(env.AWF_CLI_PROXY_IP).toBe('172.30.0.50');
      });

      it('should pass AWF_CLI_PROXY_IP to iptables-init environment', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const initEnv = result.services['iptables-init'].environment as Record<string, string>;
        expect(initEnv.AWF_CLI_PROXY_IP).toBe('172.30.0.50');
      });

      it('should use GHCR image by default', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443', buildLocal: false };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        expect(proxy.image).toContain('cli-proxy');
        expect(proxy.build).toBeUndefined();
      });

      it('should use local build when buildLocal is true', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443', buildLocal: true };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        expect((proxy.build as any).context).toContain('containers/cli-proxy');
        expect(proxy.image).toBeUndefined();
      });

      it('should depend only on squid-proxy (not mcpg)', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const dependsOn = proxy.depends_on as Record<string, any>;
        expect(dependsOn).toBeDefined();
        expect(dependsOn['squid-proxy']).toBeDefined();
        expect(dependsOn['cli-proxy-mcpg']).toBeUndefined();
      });

      it('should pass GH_TOKEN to cli-proxy environment when available', () => {
        const originalGhToken = process.env.GH_TOKEN;
        try {
          process.env.GH_TOKEN = 'ghp_cli_proxy_test_token';
          const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
          const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
          const proxy = result.services['cli-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.GH_TOKEN).toBe('ghp_cli_proxy_test_token');
        } finally {
          if (originalGhToken !== undefined) {
            process.env.GH_TOKEN = originalGhToken;
          } else {
            delete process.env.GH_TOKEN;
          }
        }
      });

      it('should fall back to GITHUB_TOKEN for cli-proxy when GH_TOKEN is absent', () => {
        const originalGhToken = process.env.GH_TOKEN;
        const originalGithubToken = process.env.GITHUB_TOKEN;
        try {
          delete process.env.GH_TOKEN;
          process.env.GITHUB_TOKEN = 'ghp_github_token_fallback';
          const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
          const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
          const proxy = result.services['cli-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.GH_TOKEN).toBe('ghp_github_token_fallback');
        } finally {
          if (originalGhToken !== undefined) {
            process.env.GH_TOKEN = originalGhToken;
          } else {
            delete process.env.GH_TOKEN;
          }
          if (originalGithubToken !== undefined) {
            process.env.GITHUB_TOKEN = originalGithubToken;
          } else {
            delete process.env.GITHUB_TOKEN;
          }
        }
      });

      it('should not set GH_TOKEN in cli-proxy when neither GH_TOKEN nor GITHUB_TOKEN is set', () => {
        const originalGhToken = process.env.GH_TOKEN;
        const originalGithubToken = process.env.GITHUB_TOKEN;
        try {
          delete process.env.GH_TOKEN;
          delete process.env.GITHUB_TOKEN;
          const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
          const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
          const proxy = result.services['cli-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.GH_TOKEN).toBeUndefined();
        } finally {
          if (originalGhToken !== undefined) {
            process.env.GH_TOKEN = originalGhToken;
          } else {
            delete process.env.GH_TOKEN;
          }
          if (originalGithubToken !== undefined) {
            process.env.GITHUB_TOKEN = originalGithubToken;
          } else {
            delete process.env.GITHUB_TOKEN;
          }
        }
      });
});
