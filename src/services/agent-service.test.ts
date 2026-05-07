import { generateDockerCompose } from '../compose-generator';
import { WrapperConfig } from '../types';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
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
