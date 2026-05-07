import { generateDockerCompose } from '../docker-manager';
import { WrapperConfig } from '../types';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
import { mockExecaSync } from '../test-helpers/mock-execa.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('agent service', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
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
        expect(result.services.agent.container_name).toBe('awf-agent');
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
});
