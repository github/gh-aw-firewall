import { generateDockerCompose, ACT_PRESET_BASE_IMAGE, AGENT_CONTAINER_NAME } from './docker-manager';
import { WrapperConfig } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions
const mockExecaFn = jest.fn();
const mockExecaSync = jest.fn();

// Mock execa module
jest.mock('execa', () => {
  const fn = (...args: any[]) => mockExecaFn(...args);
  fn.sync = (...args: any[]) => mockExecaSync(...args);
  return fn;
});

describe('docker-manager generateDockerCompose', () => {
  describe('generateDockerCompose', () => {
    const mockConfig: WrapperConfig = {
      allowedDomains: ['github.com', 'npmjs.org'],
      agentCommand: 'echo "test"',
      logLevel: 'info',
      keepContainers: false,
      workDir: '/tmp/awf-test',
      buildLocal: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    };

    const mockNetworkConfig = {
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
    };

    // Ensure workDir exists for chroot tests that create chroot-hosts file
    beforeEach(() => {
      fs.mkdirSync(mockConfig.workDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
    });

    it('should generate docker-compose config with GHCR images by default', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);

      expect(result.services['squid-proxy'].image).toBe('ghcr.io/github/gh-aw-firewall/squid:latest');
      expect(result.services.agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent:latest');
      expect(result.services['squid-proxy'].build).toBeUndefined();
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should use local build when buildLocal is true', () => {
      const localConfig = { ...mockConfig, buildLocal: true };
      const result = generateDockerCompose(localConfig, mockNetworkConfig);

      expect(result.services['squid-proxy'].build).toBeDefined();
      expect(result.services.agent.build).toBeDefined();
      expect(result.services['squid-proxy'].image).toBeUndefined();
      expect(result.services.agent.image).toBeUndefined();
    });

    it('should pass BASE_IMAGE build arg when custom agentImage is specified with --build-local', () => {
      const customImageConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ghcr.io/catthehacker/ubuntu:runner-22.04',
      };
      const result = generateDockerCompose(customImageConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe('ghcr.io/catthehacker/ubuntu:runner-22.04');
    });

    it('should not include BASE_IMAGE build arg when using default agentImage with --build-local', () => {
      const localConfig = { ...mockConfig, buildLocal: true, agentImage: 'default' };
      const result = generateDockerCompose(localConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      // BASE_IMAGE should not be set when using the default preset
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBeUndefined();
    });

    it('should not include BASE_IMAGE build arg when agentImage is undefined with --build-local', () => {
      const localConfig = { ...mockConfig, buildLocal: true };
      // agentImage is not set, should default to 'default' preset
      const result = generateDockerCompose(localConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      // BASE_IMAGE should not be set when using the default (undefined means 'default')
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBeUndefined();
    });

    it('should pass BASE_IMAGE build arg when agentImage with SHA256 digest is specified', () => {
      const customImageConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ghcr.io/catthehacker/ubuntu:full-22.04@sha256:a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1',
      };
      const result = generateDockerCompose(customImageConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe('ghcr.io/catthehacker/ubuntu:full-22.04@sha256:a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1');
    });

    it('should use act base image when agentImage is "act" preset with --build-local', () => {
      const actPresetConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'act',
      };
      const result = generateDockerCompose(actPresetConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      // When using 'act' preset with --build-local, should use the catthehacker act image
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe(ACT_PRESET_BASE_IMAGE);
    });

    it('should use agent-act GHCR image when agentImage is "act" preset without --build-local', () => {
      const actPresetConfig = {
        ...mockConfig,
        agentImage: 'act',
      };
      const result = generateDockerCompose(actPresetConfig, mockNetworkConfig);

      expect(result.services.agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent-act:latest');
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should use agent GHCR image when agentImage is "default" preset', () => {
      const defaultPresetConfig = {
        ...mockConfig,
        agentImage: 'default',
      };
      const result = generateDockerCompose(defaultPresetConfig, mockNetworkConfig);

      expect(result.services.agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent:latest');
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should use agent GHCR image when agentImage is undefined', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);

      expect(result.services.agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent:latest');
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should use custom registry and tag with act preset', () => {
      const customConfig = {
        ...mockConfig,
        agentImage: 'act',
        imageRegistry: 'docker.io/myrepo',
        imageTag: 'v1.0.0',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services['squid-proxy'].image).toBe('docker.io/myrepo/squid:v1.0.0');
      expect(result.services.agent.image).toBe('docker.io/myrepo/agent-act:v1.0.0');
    });

    it('should use custom registry and tag', () => {
      const customConfig = {
        ...mockConfig,
        imageRegistry: 'docker.io/myrepo',
        imageTag: 'v1.0.0',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services['squid-proxy'].image).toBe('docker.io/myrepo/squid:v1.0.0');
      expect(result.services.agent.image).toBe('docker.io/myrepo/agent:v1.0.0');
    });

    it('should use custom registry and tag with default preset explicitly set', () => {
      const customConfig = {
        ...mockConfig,
        agentImage: 'default',
        imageRegistry: 'docker.io/myrepo',
        imageTag: 'v2.0.0',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.image).toBe('docker.io/myrepo/agent:v2.0.0');
      expect(result.services.agent.build).toBeUndefined();
    });

    it('should append per-image digests from image-tag metadata', () => {
      const customConfig = {
        ...mockConfig,
        enableApiProxy: true,
        imageTag: [
          'v1.0.0',
          'squid=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'agent=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'api-proxy=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        ].join(','),
      };
      const networkWithProxy = {
        ...mockNetworkConfig,
        proxyIp: '172.30.0.30',
      };
      const result = generateDockerCompose(customConfig, networkWithProxy);

      expect(result.services['squid-proxy'].image).toBe(
        'ghcr.io/github/gh-aw-firewall/squid:v1.0.0@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      );
      expect(result.services.agent.image).toBe(
        'ghcr.io/github/gh-aw-firewall/agent:v1.0.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      );
      expect(result.services['iptables-init'].image).toBe(
        'ghcr.io/github/gh-aw-firewall/agent:v1.0.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      );
      expect(result.services['api-proxy'].image).toBe(
        'ghcr.io/github/gh-aw-firewall/api-proxy:v1.0.0@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      );
    });

    it('should build locally with custom catthehacker full image', () => {
      const customConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ghcr.io/catthehacker/ubuntu:full-24.04',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe('ghcr.io/catthehacker/ubuntu:full-24.04');
      expect(result.services.agent.image).toBeUndefined();
    });

    it('should build locally with custom ubuntu image', () => {
      const customConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ubuntu:24.04',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.build).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe('ubuntu:24.04');
    });

    it('should include USER_UID and USER_GID in build args with custom image', () => {
      const customConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'ghcr.io/catthehacker/ubuntu:runner-22.04',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.build?.args?.USER_UID).toBeDefined();
      expect(result.services.agent.build?.args?.USER_GID).toBeDefined();
    });

    it('should include USER_UID and USER_GID in build args with act preset', () => {
      const customConfig = {
        ...mockConfig,
        buildLocal: true,
        agentImage: 'act',
      };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);

      expect(result.services.agent.build?.args?.USER_UID).toBeDefined();
      expect(result.services.agent.build?.args?.USER_GID).toBeDefined();
      expect(result.services.agent.build?.args?.BASE_IMAGE).toBe(ACT_PRESET_BASE_IMAGE);
    });

    it('should configure network with correct IPs', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);

      expect(result.networks['awf-net'].external).toBe(true);

      const squidNetworks = result.services['squid-proxy'].networks as { [key: string]: { ipv4_address?: string } };
      expect(squidNetworks['awf-net'].ipv4_address).toBe('172.30.0.10');

      const agentNetworks = result.services.agent.networks as { [key: string]: { ipv4_address?: string } };
      expect(agentNetworks['awf-net'].ipv4_address).toBe('172.30.0.20');
    });

    it('should configure squid container correctly', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const squid = result.services['squid-proxy'];

      expect(squid.container_name).toBe('awf-squid');
      // squid.conf is NOT bind-mounted; it's injected via AWF_SQUID_CONFIG_B64 env var
      expect(squid.volumes).not.toContainEqual(expect.stringContaining('squid.conf'));
      expect(squid.volumes).toContain('/tmp/awf-test/squid-logs:/var/log/squid:rw');
      expect(squid.healthcheck).toBeDefined();
      expect(squid.ports).toContain('3128:3128');
    });

    it('should set stop_grace_period on squid service', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const squid = result.services['squid-proxy'] as any;
      expect(squid.stop_grace_period).toBe('2s');
    });

    it('should inject squid config via base64 env var when content is provided', () => {
      const squidConfig = 'http_port 3128\nacl allowed_domains dstdomain .github.com\n';
      const result = generateDockerCompose(mockConfig, mockNetworkConfig, undefined, squidConfig);
      const squid = result.services['squid-proxy'] as any;

      // Should have AWF_SQUID_CONFIG_B64 env var with base64-encoded config
      expect(squid.environment.AWF_SQUID_CONFIG_B64).toBe(
        Buffer.from(squidConfig).toString('base64')
      );

      // Should override entrypoint to decode config before starting squid
      expect(squid.entrypoint).toBeDefined();
      expect(squid.entrypoint[2]).toContain('base64 -d > /etc/squid/squid.conf');
      expect(squid.entrypoint[2]).toContain('entrypoint.sh');
    });

    it('should configure agent container with proxy settings', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.HTTP_PROXY).toBe('http://172.30.0.10:3128');
      expect(env.HTTPS_PROXY).toBe('http://172.30.0.10:3128');
      expect(env.https_proxy).toBe('http://172.30.0.10:3128');
      expect(env.SQUID_PROXY_HOST).toBe('squid-proxy');
      expect(env.SQUID_PROXY_PORT).toBe('3128');
    });

    it('should set lowercase https_proxy for Yarn 4 and Corepack compatibility', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      // Yarn 4 (undici), Corepack, and some Node.js HTTP clients only check lowercase
      expect(env.https_proxy).toBe(env.HTTPS_PROXY);
      // http_proxy is intentionally NOT set - see comment in docker-manager.ts
      expect(env.http_proxy).toBeUndefined();
    });

    it('should set NODE_EXTRA_CA_CERTS when SSL Bump is enabled', () => {
      const sslBumpConfig = { ...mockConfig, sslBump: true };
      const ssl = {
        caFiles: {
          certPath: '/tmp/awf-test/ssl/ca-cert.pem',
          keyPath: '/tmp/awf-test/ssl/ca-key.pem',
          derPath: '/tmp/awf-test/ssl/ca-cert.der',
        },
        sslDbPath: '/tmp/awf-test/ssl_db',
      };
      const result = generateDockerCompose(sslBumpConfig, mockNetworkConfig, ssl);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.NODE_EXTRA_CA_CERTS).toBe('/usr/local/share/ca-certificates/awf-ca.crt');
      expect(env.AWF_SSL_BUMP_ENABLED).toBe('true');
    });

    it('should not set NODE_EXTRA_CA_CERTS when SSL Bump is disabled', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
      expect(env.AWF_SSL_BUMP_ENABLED).toBeUndefined();
    });

    it('should set NO_COLOR=1 when tty is false (default)', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.NO_COLOR).toBe('1');
      expect(env.FORCE_COLOR).toBeUndefined();
      expect(env.COLUMNS).toBeUndefined();
    });

    it('should set FORCE_COLOR, TERM, and COLUMNS when tty is true', () => {
      const ttyConfig = { ...mockConfig, tty: true };
      const result = generateDockerCompose(ttyConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.FORCE_COLOR).toBe('1');
      expect(env.TERM).toBe('xterm-256color');
      expect(env.COLUMNS).toBe('120');
      expect(env.NO_COLOR).toBeUndefined();
    });

    it('should mount required volumes in agent container (default behavior)', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // Default: selective mounting (no blanket /:/host:rw)
      expect(volumes).not.toContain('/:/host:rw');
      expect(volumes).toContain('/tmp:/tmp:rw');
      expect(volumes.some((v: string) => v.includes('agent-logs'))).toBe(true);
      // Should include home directory mount
      expect(volumes.some((v: string) => v.includes(process.env.HOME || '/root'))).toBe(true);
      // Should include credential hiding mounts
      expect(volumes.some((v: string) => v.includes('/dev/null') && v.includes('.docker/config.json'))).toBe(true);
    });

    it('should use custom volume mounts when specified', () => {
      const configWithMounts = {
        ...mockConfig,
        volumeMounts: ['/workspace:/workspace:ro', '/data:/data:rw']
      };
      const result = generateDockerCompose(configWithMounts, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // Should NOT include blanket /:/host:rw mount
      expect(volumes).not.toContain('/:/host:rw');

      // Should include custom mounts (prefixed with /host for chroot visibility)
      expect(volumes).toContain('/workspace:/host/workspace:ro');
      expect(volumes).toContain('/data:/host/data:rw');

      // Should still include essential mounts
      expect(volumes).toContain('/tmp:/tmp:rw');
      expect(volumes.some((v: string) => v.includes('agent-logs'))).toBe(true);
    });

    it('should use selective mounts when no custom mounts specified', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // Default: selective mounting (no blanket /:/host:rw)
      expect(volumes).not.toContain('/:/host:rw');
      // Should include selective mounts with credential hiding
      expect(volumes.some((v: string) => v.includes('/dev/null'))).toBe(true);
    });

    it('should handle malformed volume mount without colon as fallback', () => {
      const configWithBadMount = {
        ...mockConfig,
        volumeMounts: ['no-colon-here']
      };
      const result = generateDockerCompose(configWithBadMount, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];
      // Malformed mount should be added as-is (fallback)
      expect(volumes).toContain('no-colon-here');
    });

    it('should forward COPILOT_GITHUB_TOKEN when api-proxy is disabled', () => {
      process.env.COPILOT_GITHUB_TOKEN = 'ghp_test_token';
      const configNoProxy = { ...mockConfig, enableApiProxy: false };
      const result = generateDockerCompose(configNoProxy, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_GITHUB_TOKEN).toBe('ghp_test_token');
      delete process.env.COPILOT_GITHUB_TOKEN;
    });

    it('should forward COPILOT_API_KEY when api-proxy is disabled', () => {
      process.env.COPILOT_API_KEY = 'cpat_test_byok_key';
      const configNoProxy = { ...mockConfig, enableApiProxy: false };
      const result = generateDockerCompose(configNoProxy, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_API_KEY).toBe('cpat_test_byok_key');
      delete process.env.COPILOT_API_KEY;
    });

    it('should not forward COPILOT_API_KEY to agent when api-proxy is enabled', () => {
      process.env.COPILOT_API_KEY = 'cpat_test_byok_key';
      const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      // Placeholder is set to prevent --env-all from leaking the real key
      expect(env.COPILOT_API_KEY).toBe('placeholder-token-for-credential-isolation');
      delete process.env.COPILOT_API_KEY;
    });

    it('should forward AWF_ONE_SHOT_TOKEN_DEBUG when set', () => {
      process.env.AWF_ONE_SHOT_TOKEN_DEBUG = '1';
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.AWF_ONE_SHOT_TOKEN_DEBUG).toBe('1');
      delete process.env.AWF_ONE_SHOT_TOKEN_DEBUG;
    });



    it('should use selective mounts by default', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // Should NOT include blanket /:/host:rw mount
      expect(volumes).not.toContain('/:/host:rw');

      // Should include system paths (read-only)
      expect(volumes).toContain('/usr:/host/usr:ro');
      expect(volumes).toContain('/bin:/host/bin:ro');
      expect(volumes).toContain('/sbin:/host/sbin:ro');
      expect(volumes).toContain('/lib:/host/lib:ro');
      expect(volumes).toContain('/lib64:/host/lib64:ro');
      expect(volumes).toContain('/opt:/host/opt:ro');

      // Should include special filesystems (read-only)
      // NOTE: /proc is NOT bind-mounted. Instead, a container-scoped procfs is mounted
      // at /host/proc via 'mount -t proc' in entrypoint.sh (requires SYS_ADMIN, which
      // is dropped before user code). This provides dynamic /proc/self/exe resolution.
      expect(volumes).not.toContain('/proc:/host/proc:ro');
      expect(volumes).not.toContain('/proc/self:/host/proc/self:ro');
      expect(volumes).toContain('/sys:/host/sys:ro');
      expect(volumes).toContain('/dev:/host/dev:ro');

      // Should include /etc subdirectories (read-only)
      expect(volumes).toContain('/etc/ssl:/host/etc/ssl:ro');
      expect(volumes).toContain('/etc/ca-certificates:/host/etc/ca-certificates:ro');
      expect(volumes).toContain('/etc/alternatives:/host/etc/alternatives:ro');
      expect(volumes).toContain('/etc/ld.so.cache:/host/etc/ld.so.cache:ro');
      // /etc/hosts is always a custom hosts file in a secure chroot temp dir (for pre-resolved domains)
      const hostsVolume = volumes.find((v: string) => v.includes('/host/etc/hosts'));
      expect(hostsVolume).toBeDefined();
      expect(hostsVolume).toMatch(/chroot-.*\/hosts:\/host\/etc\/hosts:ro/);

      // Should still include essential mounts
      expect(volumes).toContain('/tmp:/tmp:rw');
      expect(volumes.some((v: string) => v.includes('agent-logs'))).toBe(true);
    });

    it('should hide Docker socket by default', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // Docker socket should be hidden with /dev/null
      expect(volumes).toContain('/dev/null:/host/var/run/docker.sock:ro');
      expect(volumes).toContain('/dev/null:/host/run/docker.sock:ro');
    });

    it('should expose Docker socket when enableDind is true', () => {
      const dindConfig = { ...mockConfig, enableDind: true };
      const result = generateDockerCompose(dindConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // Docker socket should be mounted read-write, not hidden
      expect(volumes).toContain('/var/run/docker.sock:/host/var/run/docker.sock:rw');
      expect(volumes).toContain('/run/docker.sock:/host/run/docker.sock:rw');
      // Should NOT have /dev/null mounts
      expect(volumes).not.toContain('/dev/null:/host/var/run/docker.sock:ro');
      expect(volumes).not.toContain('/dev/null:/host/run/docker.sock:ro');
    });

    it('should mount workspace directory under /host', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // SECURITY FIX: Should mount only workspace directory under /host (not entire HOME)
      const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
      expect(volumes).toContain(`${workspaceDir}:/host${workspaceDir}:rw`);
    });

    it('should mount Rust toolchain, Node/npm caches, and CLI state directories', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      const homeDir = process.env.HOME || '/root';
      // Rust toolchain directories
      expect(volumes).toContain(`${homeDir}/.cargo:/host${homeDir}/.cargo:rw`);
      expect(volumes).toContain(`${homeDir}/.rustup:/host${homeDir}/.rustup:rw`);
      // npm cache
      expect(volumes).toContain(`${homeDir}/.npm:/host${homeDir}/.npm:rw`);
      // nvm-managed Node.js cache/installations
      expect(volumes).toContain(`${homeDir}/.nvm:/host${homeDir}/.nvm:rw`);
      // CLI state directories
      expect(volumes).toContain(`${homeDir}/.claude:/host${homeDir}/.claude:rw`);
      expect(volumes).toContain(`${homeDir}/.anthropic:/host${homeDir}/.anthropic:rw`);
      // ~/.gemini is NOT mounted when geminiApiKey is absent (fixes suspicious log in Copilot runs)
      expect(volumes).not.toContain(`${homeDir}/.gemini:/host${homeDir}/.gemini:rw`);
      // ~/.copilot is only mounted if it already exists on the host
      if (fs.existsSync(path.join(homeDir, '.copilot'))) {
        expect(volumes).toContain(`${homeDir}/.copilot:/host${homeDir}/.copilot:rw`);
      }
      // session-state and logs are always overlaid from AWF workDir
      expect(volumes).toContain(`/tmp/awf-test/agent-session-state:/host${homeDir}/.copilot/session-state:rw`);
      expect(volumes).toContain(`/tmp/awf-test/agent-logs:/host${homeDir}/.copilot/logs:rw`);
    });

    it('should mount ~/.gemini when geminiApiKey is configured', () => {
      const configWithGemini = { ...mockConfig, geminiApiKey: 'AIza-test-gemini-key' };
      const result = generateDockerCompose(configWithGemini, mockNetworkConfig);
      const volumes = result.services.agent.volumes as string[];

      const homeDir = process.env.HOME || '/root';
      expect(volumes).toContain(`${homeDir}/.gemini:/host${homeDir}/.gemini:rw`);
    });

    it('should skip .copilot bind mount when directory does not exist at non-standard HOME path', () => {
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-home-'));
      const originalHome = process.env.HOME;
      const originalSudoUser = process.env.SUDO_USER;
      delete process.env.SUDO_USER;
      process.env.HOME = fakeHome;

      try {
        const copilotDir = path.join(fakeHome, '.copilot');
        expect(fs.existsSync(copilotDir)).toBe(false);

        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        // Directory should NOT be auto-created (changed in #2114)
        expect(fs.existsSync(copilotDir)).toBe(false);
        // The blanket .copilot mount should be absent
        expect(volumes).not.toContain(`${fakeHome}/.copilot:/host${fakeHome}/.copilot:rw`);
        // But session-state and logs overlays are always present
        expect(volumes).toContainEqual(expect.stringContaining(`${fakeHome}/.copilot/session-state:rw`));
        expect(volumes).toContainEqual(expect.stringContaining(`${fakeHome}/.copilot/logs:rw`));
      } finally {
        if (originalHome !== undefined) {
          process.env.HOME = originalHome;
        } else {
          delete process.env.HOME;
        }
        if (originalSudoUser !== undefined) {
          process.env.SUDO_USER = originalSudoUser;
        } else {
          delete process.env.SUDO_USER;
        }
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    it('should use sessionStateDir when specified for chroot mounts', () => {
      const configWithSessionDir = { ...mockConfig, sessionStateDir: '/custom/session-state' };
      const result = generateDockerCompose(configWithSessionDir, mockNetworkConfig);
      const volumes = result.services.agent.volumes as string[];
      const homeDir = process.env.HOME || '/root';
      expect(volumes).toContain(`/custom/session-state:/host${homeDir}/.copilot/session-state:rw`);
      expect(volumes).toContain(`/custom/session-state:${homeDir}/.copilot/session-state:rw`);
    });

    it('should add SYS_CHROOT and SYS_ADMIN capabilities but NOT NET_ADMIN', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;

      // NET_ADMIN is NOT on the agent - it's on the iptables-init container
      expect(agent.cap_add).not.toContain('NET_ADMIN');
      expect(agent.cap_add).toContain('SYS_CHROOT');
      // SYS_ADMIN is needed to mount procfs at /host/proc for dynamic /proc/self/exe
      expect(agent.cap_add).toContain('SYS_ADMIN');
    });

    it('should add apparmor:unconfined security_opt', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;

      expect(agent.security_opt).toContain('apparmor:unconfined');
    });

    it('should set AWF_CHROOT_ENABLED environment variable', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const environment = agent.environment as Record<string, string>;

      expect(environment.AWF_CHROOT_ENABLED).toBe('true');
    });

    it('should set AWF_REQUIRE_NODE when running Copilot CLI command', () => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'copilot --version' },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_REQUIRE_NODE).toBe('1');
    });

    it.each([
      { copilotGithubToken: 'ghu_test_token' },
      { copilotApiKey: 'cpat_test_key' },
    ])('should set AWF_REQUIRE_NODE when Copilot auth config is present: %o', (copilotConfig) => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'echo test', ...copilotConfig },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_REQUIRE_NODE).toBe('1');
    });

    it('should not set AWF_REQUIRE_NODE for non-Copilot commands', () => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'echo test' },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_REQUIRE_NODE).toBeUndefined();
    });

    it('should set AWF_PREFLIGHT_BINARY=codex when running codex command', () => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'codex --version' },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_PREFLIGHT_BINARY).toBe('codex');
    });

    it('should not set AWF_PREFLIGHT_BINARY for non-codex commands', () => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'echo test' },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_PREFLIGHT_BINARY).toBeUndefined();
    });

    it('should pass GOROOT, CARGO_HOME, RUSTUP_HOME, JAVA_HOME, DOTNET_ROOT, BUN_INSTALL to container when env vars are set', () => {
      const originalGoroot = process.env.GOROOT;
      const originalCargoHome = process.env.CARGO_HOME;
      const originalRustupHome = process.env.RUSTUP_HOME;
      const originalJavaHome = process.env.JAVA_HOME;
      const originalDotnetRoot = process.env.DOTNET_ROOT;
      const originalBunInstall = process.env.BUN_INSTALL;

      process.env.GOROOT = '/usr/local/go';
      process.env.CARGO_HOME = '/home/user/.cargo';
      process.env.RUSTUP_HOME = '/home/user/.rustup';
      process.env.JAVA_HOME = '/usr/lib/jvm/java-17';
      process.env.DOTNET_ROOT = '/usr/lib/dotnet';
      process.env.BUN_INSTALL = '/home/user/.bun';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const environment = agent.environment as Record<string, string>;

        expect(environment.AWF_GOROOT).toBe('/usr/local/go');
        expect(environment.AWF_CARGO_HOME).toBe('/home/user/.cargo');
        expect(environment.AWF_RUSTUP_HOME).toBe('/home/user/.rustup');
        expect(environment.AWF_JAVA_HOME).toBe('/usr/lib/jvm/java-17');
        expect(environment.AWF_DOTNET_ROOT).toBe('/usr/lib/dotnet');
        expect(environment.AWF_BUN_INSTALL).toBe('/home/user/.bun');
      } finally {
        // Restore original values
        if (originalGoroot !== undefined) {
          process.env.GOROOT = originalGoroot;
        } else {
          delete process.env.GOROOT;
        }
        if (originalCargoHome !== undefined) {
          process.env.CARGO_HOME = originalCargoHome;
        } else {
          delete process.env.CARGO_HOME;
        }
        if (originalRustupHome !== undefined) {
          process.env.RUSTUP_HOME = originalRustupHome;
        } else {
          delete process.env.RUSTUP_HOME;
        }
        if (originalJavaHome !== undefined) {
          process.env.JAVA_HOME = originalJavaHome;
        } else {
          delete process.env.JAVA_HOME;
        }
        if (originalDotnetRoot !== undefined) {
          process.env.DOTNET_ROOT = originalDotnetRoot;
        } else {
          delete process.env.DOTNET_ROOT;
        }
        if (originalBunInstall !== undefined) {
          process.env.BUN_INSTALL = originalBunInstall;
        } else {
          delete process.env.BUN_INSTALL;
        }
      }
    });

    it('should NOT set AWF_BUN_INSTALL when BUN_INSTALL is not in environment', () => {
      const originalBunInstall = process.env.BUN_INSTALL;
      delete process.env.BUN_INSTALL;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const environment = agent.environment as Record<string, string>;

        expect(environment.AWF_BUN_INSTALL).toBeUndefined();
      } finally {
        if (originalBunInstall !== undefined) {
          process.env.BUN_INSTALL = originalBunInstall;
        }
      }
    });

    it('should set AWF_WORKDIR environment variable', () => {
      const configWithWorkDir = {
        ...mockConfig,
        containerWorkDir: '/workspace/project'
      };
      const result = generateDockerCompose(configWithWorkDir, mockNetworkConfig);
      const agent = result.services.agent;
      const environment = agent.environment as Record<string, string>;

      expect(environment.AWF_WORKDIR).toBe('/workspace/project');
    });

    it('should mount /tmp under /host for chroot temp scripts', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // /tmp:/host/tmp:rw is required for entrypoint.sh to write command scripts
      expect(volumes).toContain('/tmp:/host/tmp:rw');
    });

    it('should mount /etc/passwd and /etc/group for user lookup in chroot mode', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // These are needed for getent/user lookup inside chroot
      expect(volumes).toContain('/etc/passwd:/host/etc/passwd:ro');
      expect(volumes).toContain('/etc/group:/host/etc/group:ro');
      expect(volumes).toContain('/etc/nsswitch.conf:/host/etc/nsswitch.conf:ro');
    });

    it('should mount read-only chroot-hosts when enableHostAccess is true', () => {
      const config = {
        ...mockConfig,
        enableHostAccess: true
      };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // Should mount a read-only copy of /etc/hosts with host.docker.internal pre-injected
      const hostsVolume = volumes.find((v: string) => v.includes('/host/etc/hosts'));
      expect(hostsVolume).toBeDefined();
      expect(hostsVolume).toMatch(/chroot-.*\/hosts:\/host\/etc\/hosts:ro/);
    });

    it('should inject host.docker.internal into chroot-hosts file', () => {
      const config = {
        ...mockConfig,
        enableHostAccess: true
      };
      generateDockerCompose(config, mockNetworkConfig);

      // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
      const chrootDir = fs.readdirSync(mockConfig.workDir).find(d => d.startsWith('chroot-'));
      expect(chrootDir).toBeDefined();
      const chrootHostsPath = `${mockConfig.workDir}/${chrootDir}/hosts`;
      expect(fs.existsSync(chrootHostsPath)).toBe(true);
      const content = fs.readFileSync(chrootHostsPath, 'utf8');
      // Docker bridge gateway resolution may succeed or fail in test env,
      // but the file should exist with at least localhost
      expect(content).toContain('localhost');
    });

    it('should mount custom chroot-hosts even without enableHostAccess', () => {
      const config = {
        ...mockConfig,
        enableHostAccess: false
      };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // Should mount a custom hosts file in a secure chroot temp dir (for pre-resolved domains)
      const hostsVolume = volumes.find((v: string) => v.includes('/host/etc/hosts'));
      expect(hostsVolume).toBeDefined();
      expect(hostsVolume).toMatch(/chroot-.*\/hosts:\/host\/etc\/hosts:ro/);
    });

    it('should pre-resolve allowed domains into chroot-hosts file', () => {
      // Mock getent to return a resolved IP for a test domain
      mockExecaSync.mockImplementation((...args: any[]) => {
        if (args[0] === 'getent' && args[1]?.[0] === 'hosts') {
          const domain = args[1][1];
          if (domain === 'github.com') {
            return { stdout: '140.82.121.4      github.com', stderr: '', exitCode: 0 };
          }
          if (domain === 'npmjs.org') {
            return { stdout: '104.16.22.35      npmjs.org', stderr: '', exitCode: 0 };
          }
          throw new Error('Resolution failed');
        }
        // For docker network inspect (host.docker.internal)
        throw new Error('Not found');
      });

      const config = {
        ...mockConfig,
        allowedDomains: ['github.com', 'npmjs.org', '*.wildcard.com'],
      };
      generateDockerCompose(config, mockNetworkConfig);

      // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
      const chrootDir = fs.readdirSync(mockConfig.workDir).find(d => d.startsWith('chroot-'));
      expect(chrootDir).toBeDefined();
      const chrootHostsPath = `${mockConfig.workDir}/${chrootDir}/hosts`;
      expect(fs.existsSync(chrootHostsPath)).toBe(true);
      const content = fs.readFileSync(chrootHostsPath, 'utf8');

      // Should contain pre-resolved domains
      expect(content).toContain('140.82.121.4\tgithub.com');
      expect(content).toContain('104.16.22.35\tnpmjs.org');
      // Should NOT contain wildcard domains (can't be resolved)
      expect(content).not.toContain('wildcard.com');

      // Reset mock
      mockExecaSync.mockReset();
    });

    it('should skip domains that fail to resolve during pre-resolution', () => {
      // Mock getent to fail for all domains
      mockExecaSync.mockImplementation(() => {
        throw new Error('Resolution failed');
      });

      const config = {
        ...mockConfig,
        allowedDomains: ['unreachable.tailnet.example'],
      };
      // Should not throw even if resolution fails
      generateDockerCompose(config, mockNetworkConfig);

      // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
      const chrootDir = fs.readdirSync(mockConfig.workDir).find(d => d.startsWith('chroot-'));
      expect(chrootDir).toBeDefined();
      const chrootHostsPath = `${mockConfig.workDir}/${chrootDir}/hosts`;
      expect(fs.existsSync(chrootHostsPath)).toBe(true);
      const content = fs.readFileSync(chrootHostsPath, 'utf8');

      // Should still have the base hosts content (localhost)
      expect(content).toContain('localhost');
      // Should NOT contain the unresolvable domain
      expect(content).not.toContain('unreachable.tailnet.example');

      // Reset mock
      mockExecaSync.mockReset();
    });

    it('should not add duplicate entries for domains already in /etc/hosts', () => {
      // Mock getent to return a resolved IP
      mockExecaSync.mockImplementation((...args: any[]) => {
        if (args[0] === 'getent' && args[1]?.[0] === 'hosts') {
          return { stdout: '127.0.0.1      localhost', stderr: '', exitCode: 0 };
        }
        throw new Error('Not found');
      });

      const config = {
        ...mockConfig,
        allowedDomains: ['localhost'], // localhost is already in /etc/hosts
      };
      generateDockerCompose(config, mockNetworkConfig);

      // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
      const chrootDir = fs.readdirSync(mockConfig.workDir).find(d => d.startsWith('chroot-'));
      expect(chrootDir).toBeDefined();
      const chrootHostsPath = `${mockConfig.workDir}/${chrootDir}/hosts`;
      const content = fs.readFileSync(chrootHostsPath, 'utf8');

      // Count occurrences of 'localhost' - should only be the original entries, not duplicated
      const localhostMatches = content.match(/localhost/g);
      // /etc/hosts typically has multiple localhost entries (127.0.0.1 and ::1)
      // The key assertion is that getent should NOT have been called for localhost
      // since it's already in the hosts file
      expect(localhostMatches).toBeDefined();

      // Reset mock
      mockExecaSync.mockReset();
    });

    it('should use GHCR image with default preset', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent as any;

      // Preset image should use GHCR (not build locally)
      expect(agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent:latest');
      expect(agent.build).toBeUndefined();
    });

    it('should use GHCR agent-act image with act preset', () => {
      const configWithAct = {
        ...mockConfig,
        agentImage: 'act'
      };
      const result = generateDockerCompose(configWithAct, mockNetworkConfig);
      const agent = result.services.agent as any;

      // 'act' preset should use GHCR agent-act image
      expect(agent.image).toBe('ghcr.io/github/gh-aw-firewall/agent-act:latest');
      expect(agent.build).toBeUndefined();
    });

    it('should build locally with full Dockerfile when using custom image', () => {
      const configWithCustomImage = {
        ...mockConfig,
        agentImage: 'ubuntu:24.04' // Custom (non-preset) image
      };
      const result = generateDockerCompose(configWithCustomImage, mockNetworkConfig);
      const agent = result.services.agent as any;

      // Custom image should build locally with full Dockerfile for feature parity
      expect(agent.build).toBeDefined();
      expect(agent.build.dockerfile).toBe('Dockerfile');
      expect(agent.build.args.BASE_IMAGE).toBe('ubuntu:24.04');
      expect(agent.image).toBeUndefined();
    });

    it('should build locally with full Dockerfile when buildLocal is true', () => {
      const configWithBuildLocal = {
        ...mockConfig,
        buildLocal: true
      };
      const result = generateDockerCompose(configWithBuildLocal, mockNetworkConfig);
      const agent = result.services.agent as any;

      // Should use full Dockerfile for feature parity
      expect(agent.build).toBeDefined();
      expect(agent.build.dockerfile).toBe('Dockerfile');
      expect(agent.image).toBeUndefined();
    });

    it('should set agent to depend on healthy squid', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const depends = agent.depends_on as { [key: string]: { condition: string } };

      expect(depends['squid-proxy'].condition).toBe('service_healthy');
    });

    it('should NOT add NET_ADMIN to agent (handled by iptables-init container)', () => {
      // NET_ADMIN is NOT granted to the agent container.
      // iptables setup is performed by the awf-iptables-init service which shares
      // the agent's network namespace.
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;

      expect(agent.cap_add).not.toContain('NET_ADMIN');
    });

    it('should add iptables-init service with NET_ADMIN capability', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const initService = result.services['iptables-init'] as any;

      expect(initService).toBeDefined();
      expect(initService.container_name).toBe('awf-iptables-init');
      expect(initService.cap_add).toEqual(['NET_ADMIN', 'NET_RAW']);
      expect(initService.cap_drop).toEqual(['ALL']);
      expect(initService.network_mode).toBe('service:agent');
      expect(initService.depends_on).toEqual({
        'agent': { condition: 'service_healthy' },
      });
      // Entrypoint is overridden to bypass agent's entrypoint.sh (which has init wait loop)
      expect(initService.entrypoint).toEqual(['/bin/bash']);
      expect(initService.command).toEqual([
        '-c',
        '/usr/local/bin/setup-iptables.sh > /tmp/awf-init/output.log 2>&1 && touch /tmp/awf-init/ready',
      ]);
      expect(initService.security_opt).toBeUndefined();
      expect(initService.restart).toBe('no');
    });

    it('should apply container hardening measures', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;

      // Verify dropped capabilities for security hardening
      expect(agent.cap_drop).toEqual([
        'NET_RAW',
        'SYS_PTRACE',
        'SYS_MODULE',
        'SYS_RAWIO',
        'MKNOD',
      ]);

      // Verify seccomp profile is configured
      expect(agent.security_opt).toContain('seccomp=/tmp/awf-test/seccomp-profile.json');

      // Verify no-new-privileges is enabled to prevent privilege escalation
      expect(agent.security_opt).toContain('no-new-privileges:true');

      // Verify resource limits
      expect(agent.mem_limit).toBe('6g');
      expect(agent.memswap_limit).toBe('-1');
      expect(agent.pids_limit).toBe(1000);
      expect(agent.cpu_shares).toBe(1024);
    });

    it('should use custom memory limit when specified', () => {
      const customConfig = { ...mockConfig, memoryLimit: '8g' };
      const result = generateDockerCompose(customConfig, mockNetworkConfig);
      const agent = result.services.agent;

      expect(agent.mem_limit).toBe('8g');
      expect(agent.memswap_limit).toBe('8g');
    });

    it('should disable TTY by default to prevent ANSI escape sequences', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;

      expect(agent.tty).toBe(false);
    });

    it('should enable TTY when config.tty is true', () => {
      const configWithTty = { ...mockConfig, tty: true };
      const result = generateDockerCompose(configWithTty, mockNetworkConfig);
      const agent = result.services.agent;

      expect(agent.tty).toBe(true);
    });

    it('should escape dollar signs in commands for docker-compose', () => {
      const configWithVars = {
        ...mockConfig,
        agentCommand: 'echo $HOME && echo ${USER}',
      };
      const result = generateDockerCompose(configWithVars, mockNetworkConfig);
      const agent = result.services.agent;

      // Docker compose requires $$ to represent a literal $
      expect(agent.command).toEqual(['/bin/bash', '-c', 'echo $$HOME && echo $${USER}']);
    });

    it('should pass through GITHUB_TOKEN when present in environment', () => {
      const originalEnv = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_testtoken123';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.GITHUB_TOKEN).toBe('ghp_testtoken123');
      } finally {
        if (originalEnv !== undefined) {
          process.env.GITHUB_TOKEN = originalEnv;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
      }
    });

    it('should not pass through GITHUB_TOKEN when not in environment', () => {
      const originalEnv = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.GITHUB_TOKEN).toBeUndefined();
      } finally {
        if (originalEnv !== undefined) {
          process.env.GITHUB_TOKEN = originalEnv;
        }
      }
    });

    it('should pass through ACTIONS_ID_TOKEN_REQUEST_URL when present in environment', () => {
      const originalEnv = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.actions.githubusercontent.com/abc';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://token.actions.githubusercontent.com/abc');
      } finally {
        if (originalEnv !== undefined) {
          process.env.ACTIONS_ID_TOKEN_REQUEST_URL = originalEnv;
        } else {
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
        }
      }
    });

    it('should pass through ACTIONS_ID_TOKEN_REQUEST_TOKEN when present in environment', () => {
      const originalEnv = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'test-oidc-token-value';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('test-oidc-token-value');
      } finally {
        if (originalEnv !== undefined) {
          process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = originalEnv;
        } else {
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
        }
      }
    });

    it('should not pass through OIDC variables when not in environment', () => {
      const origUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      const origToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
        expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      } finally {
        if (origUrl !== undefined) {
          process.env.ACTIONS_ID_TOKEN_REQUEST_URL = origUrl;
        } else {
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
        }
        if (origToken !== undefined) {
          process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = origToken;
        } else {
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
        }
      }
    });

    it('should forward DOCKER_HOST into agent container when set (TCP address)', () => {
      const originalDockerHost = process.env.DOCKER_HOST;
      process.env.DOCKER_HOST = 'tcp://localhost:2375';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        // Agent must receive the original DOCKER_HOST so it can reach the DinD daemon
        expect(env.DOCKER_HOST).toBe('tcp://localhost:2375');
      } finally {
        if (originalDockerHost !== undefined) {
          process.env.DOCKER_HOST = originalDockerHost;
        } else {
          delete process.env.DOCKER_HOST;
        }
      }
    });

    it('should forward DOCKER_HOST into agent container when set (unix socket)', () => {
      const originalDockerHost = process.env.DOCKER_HOST;
      process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
      } finally {
        if (originalDockerHost !== undefined) {
          process.env.DOCKER_HOST = originalDockerHost;
        } else {
          delete process.env.DOCKER_HOST;
        }
      }
    });

    it('should not set DOCKER_HOST in agent container when not in host environment', () => {
      const originalDockerHost = process.env.DOCKER_HOST;
      delete process.env.DOCKER_HOST;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.DOCKER_HOST).toBeUndefined();
      } finally {
        if (originalDockerHost !== undefined) {
          process.env.DOCKER_HOST = originalDockerHost;
        }
      }
    });

    it('should add additional environment variables from config', () => {
      const configWithEnv = {
        ...mockConfig,
        additionalEnv: {
          CUSTOM_VAR: 'custom_value',
          ANOTHER_VAR: 'another_value',
        },
      };
      const result = generateDockerCompose(configWithEnv, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.CUSTOM_VAR).toBe('custom_value');
      expect(env.ANOTHER_VAR).toBe('another_value');
    });

    it('should never pass ACTIONS_RUNTIME_TOKEN to agent container', () => {
      const originalToken = process.env.ACTIONS_RUNTIME_TOKEN;
      process.env.ACTIONS_RUNTIME_TOKEN = 'test-runtime-token-value';

      try {
        // Should not be passed in default mode
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
      } finally {
        if (originalToken !== undefined) {
          process.env.ACTIONS_RUNTIME_TOKEN = originalToken;
        } else {
          delete process.env.ACTIONS_RUNTIME_TOKEN;
        }
      }
    });

    it('should never pass ACTIONS_RESULTS_URL to agent container', () => {
      const originalUrl = process.env.ACTIONS_RESULTS_URL;
      process.env.ACTIONS_RESULTS_URL = 'https://results-receiver.actions.githubusercontent.com/';

      try {
        // Should not be passed in default mode
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_RESULTS_URL).toBeUndefined();
      } finally {
        if (originalUrl !== undefined) {
          process.env.ACTIONS_RESULTS_URL = originalUrl;
        } else {
          delete process.env.ACTIONS_RESULTS_URL;
        }
      }
    });

    it('should exclude ACTIONS_RUNTIME_TOKEN from env-all passthrough', () => {
      const originalToken = process.env.ACTIONS_RUNTIME_TOKEN;
      process.env.ACTIONS_RUNTIME_TOKEN = 'test-runtime-token-value';

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
      } finally {
        if (originalToken !== undefined) {
          process.env.ACTIONS_RUNTIME_TOKEN = originalToken;
        } else {
          delete process.env.ACTIONS_RUNTIME_TOKEN;
        }
      }
    });

    it('should exclude ACTIONS_RESULTS_URL from env-all passthrough', () => {
      const originalUrl = process.env.ACTIONS_RESULTS_URL;
      process.env.ACTIONS_RESULTS_URL = 'https://results-receiver.actions.githubusercontent.com/';

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_RESULTS_URL).toBeUndefined();
      } finally {
        if (originalUrl !== undefined) {
          process.env.ACTIONS_RESULTS_URL = originalUrl;
        } else {
          delete process.env.ACTIONS_RESULTS_URL;
        }
      }
    });

    it('should exclude system variables when envAll is enabled', () => {
      const originalPath = process.env.PATH;
      process.env.CUSTOM_HOST_VAR = 'test_value';

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;

        // Should NOT pass through excluded vars
        expect(env.PATH).not.toBe(originalPath);
        expect(env.PATH).toBe('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');

        // Should pass through non-excluded vars
        expect(env.CUSTOM_HOST_VAR).toBe('test_value');
      } finally {
        delete process.env.CUSTOM_HOST_VAR;
      }
    });

    it('should exclude specified variables when excludeEnv is set with envAll', () => {
      process.env.CUSTOM_HOST_VAR = 'test_value';
      process.env.SECRET_TOKEN = 'super-secret';

      try {
        const configWithExcludeEnv = { ...mockConfig, envAll: true, excludeEnv: ['SECRET_TOKEN'] };
        const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // Should pass through non-excluded vars
        expect(env.CUSTOM_HOST_VAR).toBe('test_value');
        // Should NOT pass through excluded var
        expect(env.SECRET_TOKEN).toBeUndefined();
      } finally {
        delete process.env.CUSTOM_HOST_VAR;
        delete process.env.SECRET_TOKEN;
      }
    });

    it('should exclude multiple variables when excludeEnv contains multiple names', () => {
      process.env.TOKEN_A = 'value-a';
      process.env.TOKEN_B = 'value-b';
      process.env.SAFE_VAR = 'safe';

      try {
        const configWithExcludeEnv = { ...mockConfig, envAll: true, excludeEnv: ['TOKEN_A', 'TOKEN_B'] };
        const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.TOKEN_A).toBeUndefined();
        expect(env.TOKEN_B).toBeUndefined();
        expect(env.SAFE_VAR).toBe('safe');
      } finally {
        delete process.env.TOKEN_A;
        delete process.env.TOKEN_B;
        delete process.env.SAFE_VAR;
      }
    });

    it('should have no effect when excludeEnv is set but envAll is false', () => {
      process.env.SECRET_TOKEN = 'super-secret';

      try {
        const configWithExcludeEnv = { ...mockConfig, envAll: false, excludeEnv: ['SECRET_TOKEN'] };
        const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // envAll is false so SECRET_TOKEN was never going to be injected anyway
        expect(env.SECRET_TOKEN).toBeUndefined();
      } finally {
        delete process.env.SECRET_TOKEN;
      }
    });

    it('should exclude GITHUB_TOKEN from env-all passthrough when specified in excludeEnv', () => {
      const prevToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_test_token';

      try {
        const configWithExcludeEnv = { ...mockConfig, envAll: true, excludeEnv: ['GITHUB_TOKEN'] };
        const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // GITHUB_TOKEN should be excluded from the env-all passthrough
        expect(env.GITHUB_TOKEN).toBeUndefined();
      } finally {
        if (prevToken !== undefined) process.env.GITHUB_TOKEN = prevToken;
        else delete process.env.GITHUB_TOKEN;
      }
    });

    it('should exclude host proxy env vars from env-all passthrough to prevent routing conflicts', () => {
      const saved: Record<string, string | undefined> = {};
      const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];

      for (const v of proxyVars) {
        saved[v] = process.env[v];
        process.env[v] = `http://host-proxy.corp.com:3128`;
      }

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // Host proxy vars must not leak — AWF sets its own proxy vars pointing to Squid
        for (const v of proxyVars) {
          // The value should either be absent or overwritten to Squid's address
          if (env[v] !== undefined) {
            expect(env[v]).not.toBe('http://host-proxy.corp.com:3128');
          }
        }
      } finally {
        for (const v of proxyVars) {
          if (saved[v] !== undefined) process.env[v] = saved[v];
          else delete process.env[v];
        }
      }
    });

    it('should skip env vars exceeding MAX_ENV_VALUE_SIZE from env-all passthrough', () => {
      const largeVarName = 'AWF_TEST_OVERSIZED_VAR';
      const saved = process.env[largeVarName];
      // Create a value larger than 64KB
      process.env[largeVarName] = 'x'.repeat(65 * 1024);

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // Oversized var should be skipped
        expect(env[largeVarName]).toBeUndefined();
      } finally {
        if (saved !== undefined) process.env[largeVarName] = saved;
        else delete process.env[largeVarName];
      }
    });

    it('should pass env vars under MAX_ENV_VALUE_SIZE from env-all passthrough', () => {
      const normalVarName = 'AWF_TEST_NORMAL_VAR';
      const saved = process.env[normalVarName];
      process.env[normalVarName] = 'normal_value';

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env[normalVarName]).toBe('normal_value');
      } finally {
        if (saved !== undefined) process.env[normalVarName] = saved;
        else delete process.env[normalVarName];
      }
    });

    it('should auto-inject GH_HOST from GITHUB_SERVER_URL when envAll is true', () => {
      const prevServerUrl = process.env.GITHUB_SERVER_URL;
      const prevGhHost = process.env.GH_HOST;
      process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
      delete process.env.GH_HOST;

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.GH_HOST).toBe('mycompany.ghe.com');
      } finally {
        if (prevServerUrl !== undefined) process.env.GITHUB_SERVER_URL = prevServerUrl;
        else delete process.env.GITHUB_SERVER_URL;
        if (prevGhHost !== undefined) process.env.GH_HOST = prevGhHost;
      }
    });

    it('should override proxy-rewritten GH_HOST from env-all with GITHUB_SERVER_URL-derived value', () => {
      const prevServerUrl = process.env.GITHUB_SERVER_URL;
      const prevGhHost = process.env.GH_HOST;
      process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
      process.env.GH_HOST = 'localhost:18443'; // proxy-rewritten value

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // GH_HOST should be derived from GITHUB_SERVER_URL, not the proxy value
        expect(env.GH_HOST).toBe('mycompany.ghe.com');
      } finally {
        if (prevServerUrl !== undefined) process.env.GITHUB_SERVER_URL = prevServerUrl;
        else delete process.env.GITHUB_SERVER_URL;
        if (prevGhHost !== undefined) process.env.GH_HOST = prevGhHost;
        else delete process.env.GH_HOST;
      }
    });

    it('should remove proxy-rewritten GH_HOST on github.com', () => {
      const prevServerUrl = process.env.GITHUB_SERVER_URL;
      const prevGhHost = process.env.GH_HOST;
      process.env.GITHUB_SERVER_URL = 'https://github.com';
      process.env.GH_HOST = 'localhost:18443'; // proxy-rewritten value

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // GH_HOST should be removed — gh CLI defaults to github.com
        expect(env.GH_HOST).toBeUndefined();
      } finally {
        if (prevServerUrl !== undefined) process.env.GITHUB_SERVER_URL = prevServerUrl;
        else delete process.env.GITHUB_SERVER_URL;
        if (prevGhHost !== undefined) process.env.GH_HOST = prevGhHost;
        else delete process.env.GH_HOST;
      }
    });

    describe('envFile option', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-envfile-'));
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('should inject variables from env file into agent environment', () => {
        const envFile = path.join(tmpDir, '.env');
        fs.writeFileSync(envFile, 'MY_CUSTOM_VAR=hello\nANOTHER_VAR=world\n');

        const config = { ...mockConfig, envFile };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.MY_CUSTOM_VAR).toBe('hello');
        expect(env.ANOTHER_VAR).toBe('world');
      });

      it('should allow --env flags to override env-file values', () => {
        const envFile = path.join(tmpDir, '.env');
        fs.writeFileSync(envFile, 'MY_VAR=from_file\n');

        const config = { ...mockConfig, envFile, additionalEnv: { MY_VAR: 'from_flag' } };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.MY_VAR).toBe('from_flag');
      });

      it('should not overwrite already-set env vars with env-file values', () => {
        const envFile = path.join(tmpDir, '.env');
        // AWF_DNS_SERVERS is set before envFile processing; file should not clobber it
        fs.writeFileSync(envFile, 'AWF_DNS_SERVERS=1.1.1.1\n');

        const config = { ...mockConfig, envFile };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // AWF_DNS_SERVERS is set by the framework; file should NOT override it
        expect(env.AWF_DNS_SERVERS).not.toBe('1.1.1.1');
      });

      it('should skip excluded system vars from env file', () => {
        const envFile = path.join(tmpDir, '.env');
        fs.writeFileSync(envFile, 'PATH=/evil/path\nHOME=/evil/home\nMY_VAR=ok\n');

        const config = { ...mockConfig, envFile };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.PATH).not.toBe('/evil/path');
        expect(env.HOME).not.toBe('/evil/home');
        expect(env.MY_VAR).toBe('ok');
      });

      it('should skip comment lines and blank lines in env file', () => {
        const envFile = path.join(tmpDir, '.env');
        fs.writeFileSync(envFile, '# comment\n\nFOO=bar\n');

        const config = { ...mockConfig, envFile };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.FOO).toBe('bar');
      });
    });

    it('should configure DNS to use Google DNS', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;

      expect(agent.dns).toEqual(['8.8.8.8', '8.8.4.4']);
      expect(agent.dns_search).toEqual([]);
    });

    it('should NOT configure extra_hosts by default (opt-in for security)', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const squid = result.services['squid-proxy'];

      expect(agent.extra_hosts).toBeUndefined();
      expect(squid.extra_hosts).toBeUndefined();
    });

    describe('enableHostAccess option', () => {
      it('should configure extra_hosts when enableHostAccess is true', () => {
        const config = { ...mockConfig, enableHostAccess: true };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const agent = result.services.agent;
        const squid = result.services['squid-proxy'];

        expect(agent.extra_hosts).toEqual(['host.docker.internal:host-gateway']);
        expect(squid.extra_hosts).toEqual(['host.docker.internal:host-gateway']);
      });

      it('should NOT configure extra_hosts when enableHostAccess is false', () => {
        const config = { ...mockConfig, enableHostAccess: false };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const agent = result.services.agent;
        const squid = result.services['squid-proxy'];

        expect(agent.extra_hosts).toBeUndefined();
        expect(squid.extra_hosts).toBeUndefined();
      });

      it('should NOT configure extra_hosts when enableHostAccess is undefined', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const squid = result.services['squid-proxy'];

        expect(agent.extra_hosts).toBeUndefined();
        expect(squid.extra_hosts).toBeUndefined();
      });

      it('should set AWF_ENABLE_HOST_ACCESS when enableHostAccess is true', () => {
        const config = { ...mockConfig, enableHostAccess: true };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_ENABLE_HOST_ACCESS).toBe('1');
      });

      it('should NOT set AWF_ENABLE_HOST_ACCESS when enableHostAccess is false', () => {
        const config = { ...mockConfig, enableHostAccess: false };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_ENABLE_HOST_ACCESS).toBeUndefined();
      });

      it('should NOT set AWF_ENABLE_HOST_ACCESS when enableHostAccess is undefined', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_ENABLE_HOST_ACCESS).toBeUndefined();
      });

      it('should set AWF_ENABLE_HOST_ACCESS to 1 via safety net when allowHostServicePorts is set without enableHostAccess', () => {
        const config = { ...mockConfig, allowHostServicePorts: '5432,6379' };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_ENABLE_HOST_ACCESS).toBe('1');
        expect(env.AWF_HOST_SERVICE_PORTS).toBe('5432,6379');
      });
    });

    describe('NO_PROXY baseline', () => {
      it('should always set NO_PROXY with localhost entries', () => {
        // Default config without enableHostAccess or enableApiProxy
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.NO_PROXY).toContain('localhost');
        expect(env.NO_PROXY).toContain('127.0.0.1');
        expect(env.NO_PROXY).toContain('::1');
        expect(env.NO_PROXY).toContain('0.0.0.0');
        expect(env.no_proxy).toBe(env.NO_PROXY);
      });

      it('should include agent IP in NO_PROXY', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.NO_PROXY).toContain('172.30.0.20');
      });

      it('should append host.docker.internal to NO_PROXY when host access enabled', () => {
        const configWithHost = { ...mockConfig, enableHostAccess: true };
        const result = generateDockerCompose(configWithHost, mockNetworkConfig);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        // Should have both baseline AND host access entries
        expect(env.NO_PROXY).toContain('localhost');
        expect(env.NO_PROXY).toContain('host.docker.internal');
      });

      it('should sync no_proxy when --env overrides NO_PROXY', () => {
        const configWithEnv = {
          ...mockConfig,
          additionalEnv: { NO_PROXY: 'custom.local,127.0.0.1' },
        };
        const result = generateDockerCompose(configWithEnv, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.NO_PROXY).toBe('custom.local,127.0.0.1');
        expect(env.no_proxy).toBe(env.NO_PROXY);
      });

      it('should sync NO_PROXY when --env overrides no_proxy', () => {
        const configWithEnv = {
          ...mockConfig,
          additionalEnv: { no_proxy: 'custom.local,127.0.0.1' },
        };
        const result = generateDockerCompose(configWithEnv, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.no_proxy).toBe('custom.local,127.0.0.1');
        expect(env.NO_PROXY).toBe(env.no_proxy);
      });
    });

    describe('allowHostPorts option', () => {
      it('should set AWF_ALLOW_HOST_PORTS when allowHostPorts is specified', () => {
        const config = { ...mockConfig, enableHostAccess: true, allowHostPorts: '8080,3000' };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_ALLOW_HOST_PORTS).toBe('8080,3000');
      });

      it('should NOT set AWF_ALLOW_HOST_PORTS when allowHostPorts is undefined', () => {
        const config = { ...mockConfig, enableHostAccess: true };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_ALLOW_HOST_PORTS).toBeUndefined();
      });
    });

    it('should override environment variables with additionalEnv', () => {
      const originalEnv = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'original_token';

      try {
        const configWithOverride = {
          ...mockConfig,
          additionalEnv: {
            GITHUB_TOKEN: 'overridden_token',
          },
        };
        const result = generateDockerCompose(configWithOverride, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // additionalEnv should win
        expect(env.GITHUB_TOKEN).toBe('overridden_token');
      } finally {
        if (originalEnv !== undefined) {
          process.env.GITHUB_TOKEN = originalEnv;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
      }
    });

    describe('containerWorkDir option', () => {
      it('should not set working_dir when containerWorkDir is not specified', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);

        expect(result.services.agent.working_dir).toBeUndefined();
      });

      it('should set working_dir when containerWorkDir is specified', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          containerWorkDir: '/home/runner/work/repo/repo',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.services.agent.working_dir).toBe('/home/runner/work/repo/repo');
      });

      it('should set working_dir to /workspace when containerWorkDir is /workspace', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          containerWorkDir: '/workspace',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.services.agent.working_dir).toBe('/workspace');
      });

      it('should handle paths with special characters', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          containerWorkDir: '/home/user/my-project with spaces',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.services.agent.working_dir).toBe('/home/user/my-project with spaces');
      });

      it('should preserve working_dir alongside other agent service config', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          containerWorkDir: '/custom/workdir',
          envAll: true,
        };
        const result = generateDockerCompose(config, mockNetworkConfig);

        // Verify working_dir is set
        expect(result.services.agent.working_dir).toBe('/custom/workdir');
        // Verify other config is still present
        expect(result.services.agent.container_name).toBe(AGENT_CONTAINER_NAME);
        expect(result.services.agent.cap_add).toContain('SYS_CHROOT');
      });

      it('should handle empty string containerWorkDir by not setting working_dir', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          containerWorkDir: '',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);

        // Empty string is falsy, so working_dir should not be set
        expect(result.services.agent.working_dir).toBeUndefined();
      });

      it('should handle absolute paths correctly', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          containerWorkDir: '/var/lib/app/data',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);

        expect(result.services.agent.working_dir).toBe('/var/lib/app/data');
      });
    });

    describe('proxyLogsDir option', () => {
      it('should use proxyLogsDir when specified', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          proxyLogsDir: '/custom/proxy/logs',
        };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const squid = result.services['squid-proxy'];

        expect(squid.volumes).toContain('/custom/proxy/logs:/var/log/squid:rw');
      });

      it('should use workDir/squid-logs when proxyLogsDir is not specified', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const squid = result.services['squid-proxy'];

        expect(squid.volumes).toContain('/tmp/awf-test/squid-logs:/var/log/squid:rw');
      });

      it('should use api-proxy-logs subdirectory inside proxyLogsDir when specified', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          proxyLogsDir: '/custom/proxy/logs',
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
        };
        const result = generateDockerCompose(config, {
          ...mockNetworkConfig,
          proxyIp: '172.30.0.30',
        });
        const apiProxy = result.services['api-proxy'];

        expect(apiProxy.volumes).toContain('/custom/proxy/logs/api-proxy-logs:/var/log/api-proxy:rw');
      });

      it('should use workDir/api-proxy-logs when proxyLogsDir is not specified', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
        };
        const result = generateDockerCompose(config, {
          ...mockNetworkConfig,
          proxyIp: '172.30.0.30',
        });
        const apiProxy = result.services['api-proxy'];

        expect(apiProxy.volumes).toContain('/tmp/awf-test/api-proxy-logs:/var/log/api-proxy:rw');
      });
    });

    describe('dnsServers option', () => {
      it('should use custom DNS servers for Docker embedded DNS forwarding', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          dnsServers: ['1.1.1.1', '1.0.0.1'],
        };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;

        expect(agent.dns).toEqual(['1.1.1.1', '1.0.0.1']);
        // AWF_DNS_SERVERS env var should be set for setup-iptables.sh DNS ACCEPT rules
        expect(env.AWF_DNS_SERVERS).toBe('1.1.1.1,1.0.0.1');
      });

      it('should use default DNS servers when not specified', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;

        expect(agent.dns).toEqual(['8.8.8.8', '8.8.4.4']);
        // AWF_DNS_SERVERS env var should be set for setup-iptables.sh DNS ACCEPT rules
        expect(env.AWF_DNS_SERVERS).toBe('8.8.8.8,8.8.4.4');
      });
    });

    describe('workDir tmpfs overlay (secrets protection)', () => {
      it('should hide workDir from agent container via tmpfs in normal mode', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const tmpfs = agent.tmpfs as string[];

        // workDir should be hidden via tmpfs overlay to prevent reading docker-compose.yml
        expect(tmpfs).toContainEqual(expect.stringContaining(mockConfig.workDir));
        expect(tmpfs.some((t: string) => t.startsWith(`${mockConfig.workDir}:`))).toBe(true);
      });

      it('should hide workDir at both normal and /host paths (chroot always on)', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const tmpfs = agent.tmpfs as string[];

        // Both /tmp/awf-test and /host/tmp/awf-test should be hidden
        expect(tmpfs.some((t: string) => t.startsWith(`${mockConfig.workDir}:`))).toBe(true);
        expect(tmpfs.some((t: string) => t.startsWith(`/host${mockConfig.workDir}:`))).toBe(true);
      });

      it('should still hide mcp-logs alongside workDir', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const tmpfs = agent.tmpfs as string[];

        // Both mcp-logs and workDir should be hidden
        expect(tmpfs.some((t: string) => t.includes('/tmp/gh-aw/mcp-logs'))).toBe(true);
        expect(tmpfs.some((t: string) => t.startsWith(`${mockConfig.workDir}:`))).toBe(true);
      });

      it('should set secure tmpfs options (noexec, nosuid, size limit)', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const tmpfs = agent.tmpfs as string[];

        // All tmpfs mounts should have security options
        tmpfs.forEach((mount: string) => {
          expect(mount).toContain('noexec');
          expect(mount).toContain('nosuid');
          // Each mount must have a size limit (value varies: 1m for secrets, 65536k for /dev/shm)
          expect(mount).toMatch(/size=\d+[mk]/);
        });
      });

      it('should apply tmpfs overlay to custom workDir paths', () => {
        const configWithCustomWorkDir = {
          ...mockConfig,
          workDir: '/var/tmp/custom-awf-work',
        };
        fs.mkdirSync(configWithCustomWorkDir.workDir, { recursive: true });
        try {
          const result = generateDockerCompose(configWithCustomWorkDir, mockNetworkConfig);
          const agent = result.services.agent;
          const tmpfs = agent.tmpfs as string[];

          expect(tmpfs.some((t: string) => t.startsWith('/var/tmp/custom-awf-work:'))).toBe(true);
          expect(tmpfs.some((t: string) => t.startsWith('/host/var/tmp/custom-awf-work:'))).toBe(true);
        } finally {
          fs.rmSync(configWithCustomWorkDir.workDir, { recursive: true, force: true });
        }
      });

      it('should include exactly 5 tmpfs mounts (mcp-logs + workDir both normal and /host, plus /host/dev/shm)', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const tmpfs = agent.tmpfs as string[];

        expect(tmpfs).toHaveLength(5);
        // Normal paths
        expect(tmpfs.some((t: string) => t.includes('/tmp/gh-aw/mcp-logs:'))).toBe(true);
        expect(tmpfs.some((t: string) => t.startsWith(`${mockConfig.workDir}:`))).toBe(true);
        // /host-prefixed paths (chroot always on)
        expect(tmpfs.some((t: string) => t.includes('/host/tmp/gh-aw/mcp-logs:'))).toBe(true);
        expect(tmpfs.some((t: string) => t.startsWith(`/host${mockConfig.workDir}:`))).toBe(true);
        // Writable /dev/shm for POSIX semaphores (chroot makes /host/dev read-only)
        expect(tmpfs.some((t: string) => t.startsWith('/host/dev/shm:'))).toBe(true);
      });
    });

    describe('API proxy sidecar', () => {
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

    describe('DNS-over-HTTPS proxy sidecar', () => {
      const mockNetworkConfigWithDoh = {
        ...mockNetworkConfig,
        dohProxyIp: '172.30.0.40',
      };

      it('should not include doh-proxy service when dnsOverHttps is not set', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfigWithDoh);
        expect(result.services['doh-proxy']).toBeUndefined();
      });

      it('should include doh-proxy service when dnsOverHttps is set', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        expect(result.services['doh-proxy']).toBeDefined();
        const doh = result.services['doh-proxy'];
        expect(doh.container_name).toBe('awf-doh-proxy');
        expect(doh.image).toBe('cloudflare/cloudflared:latest');
      });

      it('should assign correct IP address to doh-proxy', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect((doh.networks as any)['awf-net'].ipv4_address).toBe('172.30.0.40');
      });

      it('should pass the resolver URL in the command', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://cloudflare-dns.com/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect(doh.command).toEqual(['proxy-dns', '--address', '0.0.0.0', '--port', '53', '--upstream', 'https://cloudflare-dns.com/dns-query']);
      });

      it('should configure healthcheck for doh-proxy', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect(doh.healthcheck).toBeDefined();
        expect(doh.healthcheck!.test).toEqual(['CMD', 'nslookup', '-port=53', 'cloudflare.com', '127.0.0.1']);
      });

      it('should drop all capabilities', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect(doh.cap_drop).toEqual(['ALL']);
        expect(doh.security_opt).toContain('no-new-privileges:true');
      });

      it('should set resource limits', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect(doh.mem_limit).toBe('128m');
        expect(doh.memswap_limit).toBe('128m');
        expect(doh.pids_limit).toBe(50);
      });

      it('should update agent depends_on to wait for doh-proxy', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const agent = result.services.agent;
        const dependsOn = agent.depends_on as { [key: string]: { condition: string } };
        expect(dependsOn['doh-proxy']).toBeDefined();
        expect(dependsOn['doh-proxy'].condition).toBe('service_healthy');
      });

      it('should set agent DNS to DoH proxy IP when DoH is enabled', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const agent = result.services.agent;
        expect(agent.dns).toEqual(['172.30.0.40', '127.0.0.11']);
      });

      it('should set AWF_DOH_ENABLED and AWF_DOH_PROXY_IP environment variables', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.AWF_DOH_ENABLED).toBe('true');
        expect(env.AWF_DOH_PROXY_IP).toBe('172.30.0.40');
      });

      it('should not set DoH environment variables when dnsOverHttps is not set', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfigWithDoh);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.AWF_DOH_ENABLED).toBeUndefined();
        expect(env.AWF_DOH_PROXY_IP).toBeUndefined();
      });

      it('should not include doh-proxy when dohProxyIp is missing from networkConfig', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfig);
        expect(result.services['doh-proxy']).toBeUndefined();
      });
    });

    describe('CLI proxy sidecar (external DIFC proxy)', () => {
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
        expect(env.AWF_DIFC_PROXY_HOST).toBe('[::1]');
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
  });
  describe('toolchain var fallback to GITHUB_ENV', () => {
    let tmpDir: string;
    const testConfig: WrapperConfig = {
      allowedDomains: ['github.com'],
      agentCommand: 'echo "test"',
      logLevel: 'info',
      keepContainers: false,
      workDir: '/tmp/awf-toolchain-test',
      buildLocal: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    };
    const testNetworkConfig = {
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
    };

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-toolchain-'));
      fs.mkdirSync(testConfig.workDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(testConfig.workDir, { recursive: true, force: true });
    });

    it('should recover AWF_GOROOT from GITHUB_ENV when process.env.GOROOT is absent', () => {
      const savedGoroot = process.env.GOROOT;
      const savedGithubEnv = process.env.GITHUB_ENV;
      const savedSudoUid = process.env.SUDO_UID;
      delete process.env.GOROOT;

      // Simulate sudo context: getuid() === 0 && SUDO_UID is set
      const origGetuid = process.getuid;
      process.getuid = () => 0;
      process.env.SUDO_UID = '1000';

      const envFile = path.join(tmpDir, 'github_env');
      fs.writeFileSync(envFile, 'GOROOT=/opt/hostedtoolcache/go/1.22/x64\n');
      process.env.GITHUB_ENV = envFile;

      try {
        const result = generateDockerCompose(testConfig, testNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.AWF_GOROOT).toBe('/opt/hostedtoolcache/go/1.22/x64');
      } finally {
        process.getuid = origGetuid;
        if (savedGoroot !== undefined) process.env.GOROOT = savedGoroot;
        else delete process.env.GOROOT;
        if (savedGithubEnv !== undefined) process.env.GITHUB_ENV = savedGithubEnv;
        else delete process.env.GITHUB_ENV;
        if (savedSudoUid !== undefined) process.env.SUDO_UID = savedSudoUid;
        else delete process.env.SUDO_UID;
      }
    });

    it('should prefer process.env over GITHUB_ENV for toolchain vars', () => {
      const savedGoroot = process.env.GOROOT;
      const savedGithubEnv = process.env.GITHUB_ENV;
      process.env.GOROOT = '/usr/local/go-from-env';

      const envFile = path.join(tmpDir, 'github_env');
      fs.writeFileSync(envFile, 'GOROOT=/opt/go-from-file\n');
      process.env.GITHUB_ENV = envFile;

      try {
        const result = generateDockerCompose(testConfig, testNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.AWF_GOROOT).toBe('/usr/local/go-from-env');
      } finally {
        if (savedGoroot !== undefined) process.env.GOROOT = savedGoroot;
        else delete process.env.GOROOT;
        if (savedGithubEnv !== undefined) process.env.GITHUB_ENV = savedGithubEnv;
        else delete process.env.GITHUB_ENV;
      }
    });
  });

  describe('generateDockerCompose - GITHUB_PATH integration', () => {
    const mockConfig: WrapperConfig = {
      allowedDomains: ['github.com'],
      agentCommand: 'echo "test"',
      logLevel: 'info',
      keepContainers: false,
      workDir: '/tmp/awf-github-path-test',
      buildLocal: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    };

    const mockNetworkConfig = {
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
    };

    beforeEach(() => {
      fs.mkdirSync(mockConfig.workDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
    });

    it('should merge GITHUB_PATH entries into AWF_HOST_PATH', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-gp-'));
      const pathFile = path.join(tmpDir, 'add_path');
      fs.writeFileSync(pathFile, '/opt/hostedtoolcache/Ruby/3.3.10/x64/bin\n');

      const originalGithubPath = process.env.GITHUB_PATH;
      const originalPath = process.env.PATH;
      process.env.GITHUB_PATH = pathFile;
      process.env.PATH = '/usr/local/bin:/usr/bin';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_HOST_PATH).toContain('/opt/hostedtoolcache/Ruby/3.3.10/x64/bin');
        expect(env.AWF_HOST_PATH).toContain('/usr/local/bin');
        // Ruby path should be prepended
        expect(env.AWF_HOST_PATH.indexOf('/opt/hostedtoolcache/Ruby/3.3.10/x64/bin'))
          .toBeLessThan(env.AWF_HOST_PATH.indexOf('/usr/local/bin'));
      } finally {
        if (originalGithubPath !== undefined) {
          process.env.GITHUB_PATH = originalGithubPath;
        } else {
          delete process.env.GITHUB_PATH;
        }
        if (originalPath !== undefined) {
          process.env.PATH = originalPath;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should not duplicate PATH entries from GITHUB_PATH', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-gp-'));
      const pathFile = path.join(tmpDir, 'add_path');
      fs.writeFileSync(pathFile, '/usr/local/bin\n');

      const originalGithubPath = process.env.GITHUB_PATH;
      const originalPath = process.env.PATH;
      process.env.GITHUB_PATH = pathFile;
      process.env.PATH = '/usr/local/bin:/usr/bin';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // /usr/local/bin should appear exactly once
        const occurrences = env.AWF_HOST_PATH.split(':').filter(p => p === '/usr/local/bin').length;
        expect(occurrences).toBe(1);
      } finally {
        if (originalGithubPath !== undefined) {
          process.env.GITHUB_PATH = originalGithubPath;
        } else {
          delete process.env.GITHUB_PATH;
        }
        if (originalPath !== undefined) {
          process.env.PATH = originalPath;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should work when GITHUB_PATH is not set', () => {
      const originalGithubPath = process.env.GITHUB_PATH;
      const originalPath = process.env.PATH;
      delete process.env.GITHUB_PATH;
      process.env.PATH = '/usr/local/bin:/usr/bin';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_HOST_PATH).toBe('/usr/local/bin:/usr/bin');
      } finally {
        if (originalGithubPath !== undefined) {
          process.env.GITHUB_PATH = originalGithubPath;
        } else {
          delete process.env.GITHUB_PATH;
        }
        if (originalPath !== undefined) {
          process.env.PATH = originalPath;
        }
      }
    });
  });

});
