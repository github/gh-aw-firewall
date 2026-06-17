import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir } from './service-test-setup.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('agent service', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

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

    it('should mount init-signal dir without translation when dockerHostPathPrefix is unset', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const initService = result.services['iptables-init'] as any;
      const volumes = initService.volumes as string[];

      // Source path is the runner-side init-signal dir, container path is /tmp/awf-init
      expect(volumes).toContain(`${mockConfig.workDir}/init-signal:/tmp/awf-init:rw`);
    });

    it('should apply dockerHostPathPrefix to the iptables-init init-signal volume', () => {
      // Regression: when --docker-host-path-prefix is set (e.g. ARC + DinD), the agent
      // container's init-signal mount source is prefixed via translateBindMountHostPath.
      // The iptables-init container's mount source must be prefixed identically — otherwise
      // the two containers bind to different daemon-side directories and the agent times
      // out with "No init container output log found" because the ready file written by
      // setup-iptables.sh lands in a different bind-mount target.
      const configWithPrefix = {
        ...mockConfig,
        dockerHostPathPrefix: '/host',
      };
      const result = generateDockerCompose(configWithPrefix, mockNetworkConfig);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const initService = result.services['iptables-init'] as any;
      const initVolumes = initService.volumes as string[];
      const agentVolumes = result.services.agent.volumes as string[];

      const expectedSource = `/host${mockConfig.workDir}/init-signal`;
      expect(initVolumes).toContain(`${expectedSource}:/tmp/awf-init:rw`);

      // The agent must mount the SAME daemon-side source so they share the ready file.
      expect(agentVolumes).toContain(`${expectedSource}:/tmp/awf-init:rw`);
    });

    it('should normalize trailing slash in dockerHostPathPrefix for iptables-init mount', () => {
      const configWithPrefix = {
        ...mockConfig,
        dockerHostPathPrefix: '/host/',
      };
      const result = generateDockerCompose(configWithPrefix, mockNetworkConfig);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const initService = result.services['iptables-init'] as any;
      const initVolumes = initService.volumes as string[];

      expect(initVolumes).toContain(`/host${mockConfig.workDir}/init-signal:/tmp/awf-init:rw`);
    });

    // Symmetric invariant: every absolute, non-kernel-virtual bind-mount source on every
    // service must be prefixed when dockerHostPathPrefix is set. This catches the original
    // class of bug (asymmetric translation between services that share a daemon-side dir)
    // for any future service builder, not just iptables-init.
    describe.each([
      { name: 'unset', prefix: undefined as string | undefined, expectPrefixed: false },
      { name: 'empty', prefix: '', expectPrefixed: false },
      { name: 'whitespace', prefix: '   ', expectPrefixed: false },
      { name: '/host', prefix: '/host', expectPrefixed: true },
      { name: '/host/ (trailing slash)', prefix: '/host/', expectPrefixed: true },
    ])('symmetric prefix translation across compose services (dockerHostPathPrefix=$name)', ({ prefix, expectPrefixed }) => {
      it('every absolute, non-kernel-virtual bind-mount source is prefixed consistently', () => {
        const cfg = {
          ...mockConfig,
          dockerHostPathPrefix: prefix,
          // Exercise sibling services that also build bind mounts.
          enableApiProxy: true,
          difcProxyHost: 'proxy.example.com:18443',
          difcProxyCaCert: '/etc/ssl/ca.crt',
        };
        const result = generateDockerCompose(cfg, mockNetworkConfig);

        const allVolumes: string[] = [];
        for (const [, svc] of Object.entries(result.services)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const volumes = (svc as any).volumes as string[] | undefined;
          if (Array.isArray(volumes)) allVolumes.push(...volumes);
        }

        // Sanity: at least one workDir-derived mount on every service we touched
        expect(allVolumes.some(v => v.includes(mockConfig.workDir))).toBe(true);

        for (const mount of allVolumes) {
          const [src] = mount.split(':');
          // Skip relative sources (named volumes) and the kernel virtual / /dev/null exemptions
          if (!src.startsWith('/')) continue;
          if (src === '/dev/null' || src.startsWith('/dev') || src.startsWith('/sys') || src.startsWith('/proc')) continue;

          if (expectPrefixed) {
            expect(src).toMatch(/^\/host(\/|$)/);
          } else {
            expect(src).not.toMatch(/^\/host(\/|$)/);
          }
        }
      });
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

  describe('generateDockerCompose - host PATH recovery', () => {
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

    it('should merge RUNNER_TOOL_CACHE bin directories into AWF_HOST_PATH', () => {
      const toolCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-tool-cache-'));
      const nodeBinDir = path.join(toolCacheDir, 'node', '24.16.0', 'x64', 'bin');
      fs.mkdirSync(nodeBinDir, { recursive: true });

      const originalGithubPath = process.env.GITHUB_PATH;
      const originalPath = process.env.PATH;
      const originalRunnerToolCache = process.env.RUNNER_TOOL_CACHE;
      delete process.env.GITHUB_PATH;
      process.env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      process.env.RUNNER_TOOL_CACHE = toolCacheDir;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_HOST_PATH).toContain(nodeBinDir);
        expect(env.AWF_HOST_PATH).toContain('/usr/local/bin');
        expect(env.AWF_HOST_PATH.indexOf(nodeBinDir))
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
        if (originalRunnerToolCache !== undefined) {
          process.env.RUNNER_TOOL_CACHE = originalRunnerToolCache;
        } else {
          delete process.env.RUNNER_TOOL_CACHE;
        }
        fs.rmSync(toolCacheDir, { recursive: true, force: true });
      }
    });

    it('should use PATH when RUNNER_TOOL_CACHE is not set', () => {
      const originalPath = process.env.PATH;
      const originalRunnerToolCache = process.env.RUNNER_TOOL_CACHE;
      process.env.PATH = '/usr/local/bin:/usr/bin';
      delete process.env.RUNNER_TOOL_CACHE;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        expect(env.AWF_HOST_PATH).toBe('/usr/local/bin:/usr/bin');
      } finally {
        if (originalPath !== undefined) {
          process.env.PATH = originalPath;
        }
        if (originalRunnerToolCache !== undefined) {
          process.env.RUNNER_TOOL_CACHE = originalRunnerToolCache;
        } else {
          delete process.env.RUNNER_TOOL_CACHE;
        }
      }
    });

    it('should ignore RUNNER_TOOL_CACHE when it points to a file', () => {
      const originalPath = process.env.PATH;
      const originalRunnerToolCache = process.env.RUNNER_TOOL_CACHE;

      process.env.PATH = '/usr/local/bin:/usr/bin';
      // create a file instead of a directory
      const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-tool-cache-file-')) + '.file';
      fs.writeFileSync(tmpFile, 'not a dir');
      process.env.RUNNER_TOOL_CACHE = tmpFile;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.AWF_HOST_PATH).toBe('/usr/local/bin:/usr/bin');
      } finally {
        if (originalPath !== undefined) {
          process.env.PATH = originalPath;
        }
        if (originalRunnerToolCache !== undefined) {
          process.env.RUNNER_TOOL_CACHE = originalRunnerToolCache;
        } else {
          delete process.env.RUNNER_TOOL_CACHE;
        }
        try { fs.rmSync(tmpFile, { force: true }); } catch {}
      }
    });

    it('should skip non-directory entries inside RUNNER_TOOL_CACHE', () => {
      const toolCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-tool-cache-'));
      // create a top-level file entry
      fs.writeFileSync(path.join(toolCacheDir, 'README.txt'), 'info');
      // create a tool dir with a version that is a file
      const toolDir = path.join(toolCacheDir, 'oddtool');
      fs.mkdirSync(toolDir, { recursive: true });
      fs.writeFileSync(path.join(toolDir, '1.0.0'), 'not-a-dir');

      const originalPath = process.env.PATH;
      const originalRunnerToolCache = process.env.RUNNER_TOOL_CACHE;
      process.env.PATH = '/usr/local/bin:/usr/bin';
      process.env.RUNNER_TOOL_CACHE = toolCacheDir;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        // no bin dirs should have been discovered, so AWF_HOST_PATH equals PATH
        expect(env.AWF_HOST_PATH).toBe('/usr/local/bin:/usr/bin');
      } finally {
        if (originalPath !== undefined) process.env.PATH = originalPath;
        if (originalRunnerToolCache !== undefined) process.env.RUNNER_TOOL_CACHE = originalRunnerToolCache;
        else delete process.env.RUNNER_TOOL_CACHE;
        fs.rmSync(toolCacheDir, { recursive: true, force: true });
      }
    });
  });
});
