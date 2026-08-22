import { isExternalDifcProxyHost, normalizeLoopbackDifcHost } from './cli-proxy-service';
import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir } from './service-test-setup.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('CLI proxy sidecar (external DIFC proxy)', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

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
        const proxy = result.services['cli-proxy'] as any;
        expect(proxy.container_name).toBe('awf-cli-proxy');
        expect(proxy.user).toBeUndefined();
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
        expect(proxy.extra_hosts).toEqual({ 'host.docker.internal': 'host-gateway' });
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

      it('should route cli-proxy through a credential-free relay for an external topology target', () => {
        const originalGhToken = process.env.GH_TOKEN;
        try {
          process.env.GH_TOKEN = 'ghp_cli_proxy_test_token';
          const configWithCliProxy = {
            ...mockConfig,
            networkIsolation: true,
            difcProxyHost: 'host.docker.internal:18443',
          };
          const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
          const proxy = result.services['cli-proxy'];
          const relay = result.services['cli-proxy-egress'];
          const proxyNetworks = proxy.networks as Record<string, unknown>;
          const proxyEnvironment = proxy.environment as Record<string, string>;
          const proxyDependencies = proxy.depends_on as Record<string, { condition: string }>;
          const relayNetworks = relay.networks as Record<string, unknown>;
          const relayEnvironment = relay.environment as Record<string, string>;

          expect(proxyNetworks['awf-ext']).toBeUndefined();
          expect(proxyEnvironment.AWF_DIFC_PROXY_HOST).toBe('cli-proxy-egress');
          expect(proxyDependencies['cli-proxy-egress'].condition).toBe('service_healthy');

          expect(relayNetworks['awf-net']).toBeDefined();
          expect(relayNetworks['awf-ext']).toBeDefined();
          expect(relayEnvironment).toEqual({
            AWF_CLI_PROXY_RELAY_ONLY: '1',
            AWF_DIFC_PROXY_HOST: 'host.docker.internal',
            AWF_DIFC_PROXY_PORT: '18443',
          });
          expect(relay.volumes).toBeUndefined();
          expect(relay.read_only).toBe(true);
          expect(relay.cap_drop).toEqual(['ALL']);
        } finally {
          if (originalGhToken !== undefined) {
            process.env.GH_TOKEN = originalGhToken;
          } else {
            delete process.env.GH_TOKEN;
          }
        }
      });

      it('should not create an egress relay for an attached topology sibling', () => {
        const configWithCliProxy = {
          ...mockConfig,
          networkIsolation: true,
          difcProxyHost: 'awmg-cli-proxy:18443',
        };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxyEnvironment = result.services['cli-proxy'].environment as Record<string, string>;

        expect(result.services['cli-proxy-egress']).toBeUndefined();
        expect(proxyEnvironment.AWF_DIFC_PROXY_HOST).toBe('awmg-cli-proxy');
      });

      it('should parse custom host and port from difcProxyHost', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'custom-host:9999' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_DIFC_PROXY_HOST).toBe('custom-host');
        expect(env.AWF_DIFC_PROXY_PORT).toBe('9999');
      });

      it('should parse IPv6 bracketed host:port from difcProxyHost, normalizing loopback', () => {
        // [::1] is the cli-proxy container's own loopback, not the runner
        // host, so it must be normalized to host.docker.internal — otherwise
        // the tcp-tunnel would dial itself instead of the host DIFC proxy.
        const configWithCliProxy = { ...mockConfig, difcProxyHost: '[::1]:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.AWF_DIFC_PROXY_HOST).toBe('host.docker.internal');
        expect(env.AWF_DIFC_PROXY_PORT).toBe('18443');
      });

      it('should normalize localhost and 127.0.0.1 difcProxyHost to host.docker.internal', () => {
        for (const host of ['localhost:18443', '127.0.0.1:18443']) {
          const configWithCliProxy = { ...mockConfig, difcProxyHost: host };
          const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
          const proxy = result.services['cli-proxy'];
          const env = proxy.environment as Record<string, string>;
          expect(env.AWF_DIFC_PROXY_HOST).toBe('host.docker.internal');
        }
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

      it('should route artifact redirect downloads through Squid', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        const env = proxy.environment as Record<string, string>;
        expect(env.HTTP_PROXY).toBe('http://172.30.0.10:3128');
        expect(env.HTTPS_PROXY).toBe('http://172.30.0.10:3128');
        expect(env.https_proxy).toBe('http://172.30.0.10:3128');
        expect(env.NO_PROXY).not.toContain('blob.core.windows.net');
      });

      it('should configure healthcheck for cli-proxy', () => {
        const configWithCliProxy = { ...mockConfig, difcProxyHost: 'host.docker.internal:18443' };
        const result = generateDockerCompose(configWithCliProxy, mockNetworkConfigWithCliProxy);
        const proxy = result.services['cli-proxy'];
        expect(proxy.healthcheck).toBeDefined();
        expect((proxy.healthcheck as any).test).toEqual(['CMD', 'curl', '-f', 'http://127.0.0.1:11000/health']);
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
  describe('isExternalDifcProxyHost', () => {
    it('treats host gateway, non-subnet IPs and dotted names as external', () => {
      expect(isExternalDifcProxyHost('host.docker.internal')).toBe(true);
      expect(isExternalDifcProxyHost('172.17.0.1')).toBe(true);
      expect(isExternalDifcProxyHost('::1')).toBe(true);
      expect(isExternalDifcProxyHost('difc.example.com')).toBe(true);
    });

    it('treats bare container names as attached siblings', () => {
      expect(isExternalDifcProxyHost('awmg-cli-proxy')).toBe(false);
      expect(isExternalDifcProxyHost('')).toBe(false);
    });

    it('treats a static IP inside awf-net\'s own subnet as an attached sibling', () => {
      // 172.30.0.0/24 is awf-net's own subnet (see NETWORK_SUBNET); a sibling
      // given a static address there needs no extra egress.
      expect(isExternalDifcProxyHost('172.30.0.50')).toBe(false);
      expect(isExternalDifcProxyHost('172.30.0.255')).toBe(false);
      // Just outside the /24 is still external.
      expect(isExternalDifcProxyHost('172.30.1.1')).toBe(true);
    });
  });

  describe('normalizeLoopbackDifcHost', () => {
    it('rewrites loopback spellings to host.docker.internal', () => {
      expect(normalizeLoopbackDifcHost('localhost')).toBe('host.docker.internal');
      expect(normalizeLoopbackDifcHost('LOCALHOST')).toBe('host.docker.internal');
      expect(normalizeLoopbackDifcHost('127.0.0.1')).toBe('host.docker.internal');
      expect(normalizeLoopbackDifcHost('127.5.6.7')).toBe('host.docker.internal');
      expect(normalizeLoopbackDifcHost('::1')).toBe('host.docker.internal');
    });

    it('leaves non-loopback hosts unchanged', () => {
      expect(normalizeLoopbackDifcHost('host.docker.internal')).toBe('host.docker.internal');
      expect(normalizeLoopbackDifcHost('awmg-cli-proxy')).toBe('awmg-cli-proxy');
      expect(normalizeLoopbackDifcHost('172.30.0.50')).toBe('172.30.0.50');
    });
  });
});
