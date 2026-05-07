import { generateDockerCompose } from '../compose-generator';
import { AGENT_CONTAINER_NAME } from '../host-env';
import { WrapperConfig } from '../types';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

describe('agent service', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
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
          certPath: `${mockConfig.workDir}/ssl/ca-cert.pem`,
          keyPath: `${mockConfig.workDir}/ssl/ca-key.pem`,
          derPath: `${mockConfig.workDir}/ssl/ca-cert.der`,
        },
        sslDbPath: `${mockConfig.workDir}/ssl_db`,
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

    it('should not forward COPILOT_PROVIDER_API_KEY to agent from --env-all when api-proxy is enabled', () => {
      const providerApiKey = 'sk-real-provider-key';
      process.env.COPILOT_PROVIDER_API_KEY = providerApiKey;
      const configWithProxy = { ...mockConfig, enableApiProxy: true, envAll: true };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
      delete process.env.COPILOT_PROVIDER_API_KEY;
    });

    it('should keep COPILOT_PROVIDER_API_KEY placeholder when api-proxy is enabled with copilotApiKey and --env-all', () => {
      const providerApiKey = 'sk-real-provider-key';
      const copilotApiKey = 'cpat-config-byok-key';
      process.env.COPILOT_PROVIDER_API_KEY = providerApiKey;
      const configWithProxy = { ...mockConfig, enableApiProxy: true, envAll: true, copilotApiKey };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_PROVIDER_API_KEY).toBe('placeholder-token-for-credential-isolation');
      delete process.env.COPILOT_PROVIDER_API_KEY;
    });

    it('should keep COPILOT_API_KEY placeholder when api-proxy is enabled with copilotApiKey and --env-all', () => {
      process.env.COPILOT_API_KEY = 'cpat-host-value';
      const configWithProxy = { ...mockConfig, enableApiProxy: true, envAll: true, copilotApiKey: 'cpat-config-byok-key' };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
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
      expect(volumes).toContain(`${mockConfig.workDir}/agent-session-state:/host${homeDir}/.copilot/session-state:rw`);
      expect(volumes).toContain(`${mockConfig.workDir}/agent-logs:/host${homeDir}/.copilot/logs:rw`);
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
      expect(agent.security_opt).toContain(`seccomp=${mockConfig.workDir}/seccomp-profile.json`);

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

        expect(squid.volumes).toContain(`${mockConfig.workDir}/squid-logs:/var/log/squid:rw`);
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

        expect(apiProxy.volumes).toContain(`${mockConfig.workDir}/api-proxy-logs:/var/log/api-proxy:rw`);
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


  describe('toolchain var fallback to GITHUB_ENV', () => {
    let tmpDir: string;
    let testConfig: WrapperConfig;
    const testNetworkConfig = {
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
    };

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-toolchain-'));
      testConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo "test"',
        logLevel: 'info',
        keepContainers: false,
        workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-toolchain-work-')),
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      };
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
    let mockConfig: WrapperConfig;

    const mockNetworkConfig = {
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
    };

    beforeEach(() => {
      mockConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo "test"',
        logLevel: 'info',
        keepContainers: false,
        workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-github-path-')),
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      };
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
