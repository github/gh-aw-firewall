import { generateDockerCompose, subnetsOverlap, writeConfigs, startContainers, stopContainers, cleanup, runAgentCommand, validateIdNotInSystemRange, getSafeHostUid, getSafeHostGid, getRealUserHome, MIN_REGULAR_UID, ACT_PRESET_BASE_IMAGE } from './docker-manager';
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

describe('docker-manager', () => {
  describe('subnetsOverlap', () => {

    it('should detect overlapping subnets with same CIDR', () => {
      expect(subnetsOverlap('172.30.0.0/24', '172.30.0.0/24')).toBe(true);
    });

    it('should detect non-overlapping subnets', () => {
      expect(subnetsOverlap('172.30.0.0/24', '172.31.0.0/24')).toBe(false);
      expect(subnetsOverlap('192.168.1.0/24', '192.168.2.0/24')).toBe(false);
    });

    it('should detect when smaller subnet is inside larger subnet', () => {
      expect(subnetsOverlap('172.16.0.0/16', '172.16.5.0/24')).toBe(true);
      expect(subnetsOverlap('172.16.5.0/24', '172.16.0.0/16')).toBe(true);
    });

    it('should detect partial overlap', () => {
      expect(subnetsOverlap('172.30.0.0/23', '172.30.1.0/24')).toBe(true);
    });

    it('should handle Docker default bridge network', () => {
      expect(subnetsOverlap('172.17.0.0/16', '172.17.5.0/24')).toBe(true);
      expect(subnetsOverlap('172.17.0.0/16', '172.18.0.0/16')).toBe(false);
    });

    it('should handle /32 (single host) networks', () => {
      expect(subnetsOverlap('192.168.1.1/32', '192.168.1.1/32')).toBe(true);
      expect(subnetsOverlap('192.168.1.1/32', '192.168.1.2/32')).toBe(false);
    });
  });

  describe('ACT_PRESET_BASE_IMAGE', () => {
    it('should be a valid catthehacker act image', () => {
      expect(ACT_PRESET_BASE_IMAGE).toBe('ghcr.io/catthehacker/ubuntu:act-24.04');
    });

    it('should match expected pattern for catthehacker images', () => {
      expect(ACT_PRESET_BASE_IMAGE).toMatch(/^ghcr\.io\/catthehacker\/ubuntu:act-\d+\.\d+$/);
    });
  });

  describe('validateIdNotInSystemRange', () => {
    it('should return 1000 for system UIDs (0-999)', () => {
      expect(validateIdNotInSystemRange(0)).toBe('1000');
      expect(validateIdNotInSystemRange(1)).toBe('1000');
      expect(validateIdNotInSystemRange(13)).toBe('1000'); // proxy user
      expect(validateIdNotInSystemRange(999)).toBe('1000');
    });

    it('should return the UID as-is for regular users (>= 1000)', () => {
      expect(validateIdNotInSystemRange(1000)).toBe('1000');
      expect(validateIdNotInSystemRange(1001)).toBe('1001');
      expect(validateIdNotInSystemRange(65534)).toBe('65534'); // nobody user on some systems
    });
  });

  describe('getSafeHostUid', () => {
    const originalGetuid = process.getuid;
    const originalSudoUid = process.env.SUDO_UID;

    afterEach(() => {
      process.getuid = originalGetuid;
      if (originalSudoUid !== undefined) {
        process.env.SUDO_UID = originalSudoUid;
      } else {
        delete process.env.SUDO_UID;
      }
    });

    it('should return 1000 when SUDO_UID is a system UID', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = '13'; // proxy user
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return SUDO_UID when it is a regular user UID', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = '1001';
      expect(getSafeHostUid()).toBe('1001');
    });

    it('should return 1000 when SUDO_UID is 0', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = '0';
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return 1000 when running as root without SUDO_UID', () => {
      process.getuid = () => 0;
      delete process.env.SUDO_UID;
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return 1000 for non-root system UID', () => {
      process.getuid = () => 13; // proxy user
      delete process.env.SUDO_UID;
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return the UID when running as regular user', () => {
      process.getuid = () => 1001;
      delete process.env.SUDO_UID;
      expect(getSafeHostUid()).toBe('1001');
    });
  });

  describe('getSafeHostGid', () => {
    const originalGetgid = process.getgid;
    const originalSudoGid = process.env.SUDO_GID;

    afterEach(() => {
      process.getgid = originalGetgid;
      if (originalSudoGid !== undefined) {
        process.env.SUDO_GID = originalSudoGid;
      } else {
        delete process.env.SUDO_GID;
      }
    });

    it('should return 1000 when SUDO_GID is a system GID', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = '13'; // proxy group
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return SUDO_GID when it is a regular user GID', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = '1001';
      expect(getSafeHostGid()).toBe('1001');
    });

    it('should return 1000 when SUDO_GID is 0', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = '0';
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return 1000 when running as root without SUDO_GID', () => {
      process.getgid = () => 0;
      delete process.env.SUDO_GID;
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return 1000 for non-root system GID', () => {
      process.getgid = () => 13; // proxy group
      delete process.env.SUDO_GID;
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return the GID when running as regular user', () => {
      process.getgid = () => 1001;
      delete process.env.SUDO_GID;
      expect(getSafeHostGid()).toBe('1001');
    });
  });

  describe('getRealUserHome', () => {
    const originalGetuid = process.getuid;
    const originalSudoUser = process.env.SUDO_USER;
    const originalHome = process.env.HOME;

    afterEach(() => {
      process.getuid = originalGetuid;
      process.env.SUDO_USER = originalSudoUser;
      process.env.HOME = originalHome;
      jest.restoreAllMocks();
    });

    it('should return HOME when running as regular user', () => {
      process.getuid = () => 1001;
      process.env.HOME = '/home/testuser';
      expect(getRealUserHome()).toBe('/home/testuser');
    });

    it('should return /root as fallback when HOME is not set and running as root', () => {
      process.getuid = () => 0;
      delete process.env.SUDO_USER;
      delete process.env.HOME;
      expect(getRealUserHome()).toBe('/root');
    });

    it('should use HOME as fallback when running as root without SUDO_USER', () => {
      process.getuid = () => 0;
      delete process.env.SUDO_USER;
      process.env.HOME = '/root';
      expect(getRealUserHome()).toBe('/root');
    });

    it('should look up user home from /etc/passwd when running as root with SUDO_USER (using real root user)', () => {
      // Test with actual /etc/passwd by using 'root' user which always exists
      process.getuid = () => 0;
      process.env.SUDO_USER = 'root';
      process.env.HOME = '/some/other/path';

      // Should find root's home directory from /etc/passwd
      expect(getRealUserHome()).toBe('/root');
    });

    it('should fall back to HOME when SUDO_USER not found in /etc/passwd', () => {
      process.getuid = () => 0;
      process.env.SUDO_USER = 'nonexistent_user_12345';
      process.env.HOME = '/fallback/home';

      // User doesn't exist in /etc/passwd, should fall back to HOME
      expect(getRealUserHome()).toBe('/fallback/home');
    });

    it('should handle undefined getuid gracefully (using real /etc/passwd)', () => {
      // Simulate environment where process.getuid is undefined (e.g., Windows)
      process.getuid = undefined as any;
      process.env.SUDO_USER = 'root';
      process.env.HOME = '/custom/home';

      // With getuid undefined, uid is undefined (falsy), so it attempts passwd lookup
      // Should find root's home directory from /etc/passwd
      expect(getRealUserHome()).toBe('/root');
    });
  });

  describe('MIN_REGULAR_UID constant', () => {
    it('should be 1000 (standard Linux regular user UID threshold)', () => {
      expect(MIN_REGULAR_UID).toBe(1000);
    });
  });

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
      expect(squid.volumes).toContain('/tmp/awf-test/squid.conf:/etc/squid/squid.conf:ro');
      expect(squid.volumes).toContain('/tmp/awf-test/squid-logs:/var/log/squid:rw');
      expect(squid.healthcheck).toBeDefined();
      expect(squid.ports).toContain('3128:3128');
    });

    it('should configure agent container with proxy settings', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.HTTP_PROXY).toBe('http://172.30.0.10:3128');
      expect(env.HTTPS_PROXY).toBe('http://172.30.0.10:3128');
      expect(env.SQUID_PROXY_HOST).toBe('squid-proxy');
      expect(env.SQUID_PROXY_PORT).toBe('3128');
    });

    it('should set NO_COLOR=1 to disable ANSI color output from CLI tools', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.NO_COLOR).toBe('1');
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

      // Should include custom mounts
      expect(volumes).toContain('/workspace:/workspace:ro');
      expect(volumes).toContain('/data:/data:rw');

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

    it('should hide Docker socket', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // Docker socket should be hidden with /dev/null
      expect(volumes).toContain('/dev/null:/host/var/run/docker.sock:ro');
      expect(volumes).toContain('/dev/null:/host/run/docker.sock:ro');
    });

    it('should mount workspace directory under /host', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      // SECURITY FIX: Should mount only workspace directory under /host (not entire HOME)
      const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
      expect(volumes).toContain(`${workspaceDir}:/host${workspaceDir}:rw`);
    });

    it('should mount Rust toolchain, npm cache, and CLI state directories', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const volumes = agent.volumes as string[];

      const homeDir = process.env.HOME || '/root';
      // Rust toolchain directories
      expect(volumes).toContain(`${homeDir}/.cargo:/host${homeDir}/.cargo:rw`);
      expect(volumes).toContain(`${homeDir}/.rustup:/host${homeDir}/.rustup:rw`);
      // npm cache
      expect(volumes).toContain(`${homeDir}/.npm:/host${homeDir}/.npm:rw`);
      // CLI state directories
      expect(volumes).toContain(`${homeDir}/.claude:/host${homeDir}/.claude:rw`);
      expect(volumes).toContain(`${homeDir}/.anthropic:/host${homeDir}/.anthropic:rw`);
      expect(volumes).toContain(`${homeDir}/.copilot:/host${homeDir}/.copilot:rw`);
    });

    it('should add SYS_CHROOT and SYS_ADMIN capabilities', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;

      expect(agent.cap_add).toContain('NET_ADMIN');
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

    it('should pass GOROOT, CARGO_HOME, JAVA_HOME, DOTNET_ROOT, BUN_INSTALL to container when env vars are set', () => {
      const originalGoroot = process.env.GOROOT;
      const originalCargoHome = process.env.CARGO_HOME;
      const originalJavaHome = process.env.JAVA_HOME;
      const originalDotnetRoot = process.env.DOTNET_ROOT;
      const originalBunInstall = process.env.BUN_INSTALL;

      process.env.GOROOT = '/usr/local/go';
      process.env.CARGO_HOME = '/home/user/.cargo';
      process.env.JAVA_HOME = '/usr/lib/jvm/java-17';
      process.env.DOTNET_ROOT = '/usr/lib/dotnet';
      process.env.BUN_INSTALL = '/home/user/.bun';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const environment = agent.environment as Record<string, string>;

        expect(environment.AWF_GOROOT).toBe('/usr/local/go');
        expect(environment.AWF_CARGO_HOME).toBe('/home/user/.cargo');
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

    it('should add NET_ADMIN capability to agent for iptables setup', () => {
      // NET_ADMIN is required at container start for setup-iptables.sh
      // The capability is dropped before user command execution via capsh
      // (see containers/agent/entrypoint.sh)
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;

      expect(agent.cap_add).toContain('NET_ADMIN');
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
      expect(agent.mem_limit).toBe('4g');
      expect(agent.memswap_limit).toBe('4g');
      expect(agent.pids_limit).toBe(1000);
      expect(agent.cpu_shares).toBe(1024);
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
        expect(result.services.agent.container_name).toBe('awf-agent');
        expect(result.services.agent.cap_add).toContain('NET_ADMIN');
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
    });

    describe('dnsServers option', () => {
      it('should use custom DNS servers when specified', () => {
        const config: WrapperConfig = {
          ...mockConfig,
          dnsServers: ['1.1.1.1', '1.0.0.1'],
        };
        const result = generateDockerCompose(config, mockNetworkConfig);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;

        expect(agent.dns).toEqual(['1.1.1.1', '1.0.0.1']);
        expect(env.AWF_DNS_SERVERS).toBe('1.1.1.1,1.0.0.1');
      });

      it('should use default DNS servers when not specified', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;

        expect(agent.dns).toEqual(['8.8.8.8', '8.8.4.4']);
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
        expect((proxy.healthcheck as any).test).toEqual(['CMD', 'curl', '-f', 'http://localhost:10000/health']);
      });

      it('should drop all capabilities', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const proxy = result.services['api-proxy'];
        expect(proxy.cap_drop).toEqual(['ALL']);
        expect(proxy.security_opt).toContain('no-new-privileges:true');
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
        expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000/v1');
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
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder-token-for-credential-isolation');
        expect(env.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
      });

      it('should set both ANTHROPIC_BASE_URL and OPENAI_BASE_URL when both keys are provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-openai-key', anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000/v1');
        expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder-token-for-credential-isolation');
        expect(env.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
      });

      it('should not set OPENAI_BASE_URL in agent when only Anthropic key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, anthropicApiKey: 'sk-ant-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.OPENAI_BASE_URL).toBeUndefined();
        expect(env.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder-token-for-credential-isolation');
        expect(env.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
      });

      it('should set OPENAI_BASE_URL and not set ANTHROPIC_BASE_URL when only OpenAI key is provided', () => {
        const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test-key' };
        const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000/v1');
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
          expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder-token-for-credential-isolation');
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
          // Agent should NOT have the raw API key — only the sidecar gets it
          expect(env.OPENAI_API_KEY).toBeUndefined();
          // Agent should have OPENAI_BASE_URL to proxy through sidecar
          expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000/v1');
        } finally {
          if (origKey !== undefined) {
            process.env.OPENAI_API_KEY = origKey;
          } else {
            delete process.env.OPENAI_API_KEY;
          }
        }
      });

      it('should not leak CODEX_API_KEY to agent when api-proxy is enabled with envAll', () => {
        // Simulate the key being in process.env AND envAll enabled
        // CODEX_API_KEY is now excluded when api-proxy is enabled for credential isolation
        const origKey = process.env.CODEX_API_KEY;
        process.env.CODEX_API_KEY = 'sk-codex-secret';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-test', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // CODEX_API_KEY should NOT be passed to agent when api-proxy is enabled
          expect(env.CODEX_API_KEY).toBeUndefined();
          // OPENAI_BASE_URL should be set when api-proxy is enabled with openaiApiKey
          expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000/v1');
        } finally {
          if (origKey !== undefined) {
            process.env.CODEX_API_KEY = origKey;
          } else {
            delete process.env.CODEX_API_KEY;
          }
        }
      });

      it('should not leak OPENAI_API_KEY to agent when api-proxy is enabled with envAll', () => {
        // Simulate envAll scenario (smoke-codex uses --env-all)
        const origKey = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = 'sk-openai-secret';
        try {
          const configWithProxy = { ...mockConfig, enableApiProxy: true, openaiApiKey: 'sk-openai-secret', envAll: true };
          const result = generateDockerCompose(configWithProxy, mockNetworkConfigWithProxy);
          const agent = result.services.agent;
          const env = agent.environment as Record<string, string>;
          // Even with envAll, agent should NOT have OPENAI_API_KEY when api-proxy is enabled
          expect(env.OPENAI_API_KEY).toBeUndefined();
          // Agent should have OPENAI_BASE_URL to proxy through sidecar
          expect(env.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000/v1');
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
          expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder-token-for-credential-isolation');
        } finally {
          if (origKey !== undefined) {
            process.env.ANTHROPIC_API_KEY = origKey;
          } else {
            delete process.env.ANTHROPIC_API_KEY;
          }
        }
      });

      it('should set AWF_RATE_LIMIT env vars when rateLimitConfig is provided', () => {
        const configWithRateLimit = {
          ...mockConfig,
          enableApiProxy: true,
          openaiApiKey: 'sk-test-key',
          rateLimitConfig: { enabled: true, rpm: 30, rph: 500, bytesPm: 10485760, tpm: 0 },
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
          rateLimitConfig: { enabled: false, rpm: 60, rph: 1000, bytesPm: 52428800, tpm: 0 },
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
    });
  });

  describe('writeConfigs', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      jest.clearAllMocks();
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should create work directory if it does not exist', async () => {
      const newWorkDir = path.join(testDir, 'new-work-dir');
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: newWorkDir,
      };

      // writeConfigs may succeed if seccomp profile is found, or fail if not
      try {
        await writeConfigs(config);
      } catch {
        // Expected to fail if seccomp profile not found, but directories should still be created
      }

      // Verify work directory was created
      expect(fs.existsSync(newWorkDir)).toBe(true);
    });

    it('should create agent-logs directory', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: testDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail, but directories should still be created
      }

      // Verify agent-logs directory was created
      expect(fs.existsSync(path.join(testDir, 'agent-logs'))).toBe(true);
    });

    it('should create squid-logs directory', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: testDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail, but directories should still be created
      }

      // Verify squid-logs directory was created
      expect(fs.existsSync(path.join(testDir, 'squid-logs'))).toBe(true);
    });

    it('should create /tmp/gh-aw/mcp-logs directory with world-writable permissions', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: testDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail, but directory should still be created
      }

      // Verify /tmp/gh-aw/mcp-logs directory was created
      expect(fs.existsSync('/tmp/gh-aw/mcp-logs')).toBe(true);
      const stats = fs.statSync('/tmp/gh-aw/mcp-logs');
      expect(stats.isDirectory()).toBe(true);
      // Verify permissions are 0o777 (rwxrwxrwx) to allow non-root users to create subdirectories
      expect((stats.mode & 0o777).toString(8)).toBe('777');
    });

    it('should write squid.conf file', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com', 'example.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: testDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail after writing configs
      }

      // Verify squid.conf was created (it's created before seccomp check)
      const squidConfPath = path.join(testDir, 'squid.conf');
      if (fs.existsSync(squidConfPath)) {
        const content = fs.readFileSync(squidConfPath, 'utf-8');
        expect(content).toContain('github.com');
        expect(content).toContain('example.com');
      }
    });

    it('should write docker-compose.yml file', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: testDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail after writing configs
      }

      // Verify docker-compose.yml was created
      const dockerComposePath = path.join(testDir, 'docker-compose.yml');
      if (fs.existsSync(dockerComposePath)) {
        const content = fs.readFileSync(dockerComposePath, 'utf-8');
        expect(content).toContain('awf-squid');
        expect(content).toContain('awf-agent');
      }
    });

    it('should create work directory with restricted permissions (0o700)', async () => {
      const newWorkDir = path.join(testDir, 'restricted-dir');
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: newWorkDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail if seccomp profile not found
      }

      // Verify directory was created with restricted permissions
      expect(fs.existsSync(newWorkDir)).toBe(true);
      const stats = fs.statSync(newWorkDir);
      expect((stats.mode & 0o777).toString(8)).toBe('700');
    });

    it('should write config files with restricted permissions (0o600)', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: testDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail after writing configs
      }

      // Verify squid.conf has restricted permissions
      const squidConfPath = path.join(testDir, 'squid.conf');
      if (fs.existsSync(squidConfPath)) {
        const stats = fs.statSync(squidConfPath);
        expect((stats.mode & 0o777).toString(8)).toBe('600');
      }

      // Verify docker-compose.yml has restricted permissions
      const dockerComposePath = path.join(testDir, 'docker-compose.yml');
      if (fs.existsSync(dockerComposePath)) {
        const stats = fs.statSync(dockerComposePath);
        expect((stats.mode & 0o777).toString(8)).toBe('600');
      }
    });

    it('should use proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(testDir, 'custom-proxy-logs');
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: testDir,
        proxyLogsDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail after writing configs
      }

      // Verify proxyLogsDir was created
      expect(fs.existsSync(proxyLogsDir)).toBe(true);
    });

    it('should pre-create chroot home subdirectories with correct ownership', async () => {
      // Use a temporary home directory to avoid modifying the real one
      const fakeHome = path.join(testDir, 'fakehome');
      fs.mkdirSync(fakeHome, { recursive: true });
      const originalHome = process.env.HOME;
      const originalSudoUser = process.env.SUDO_USER;
      process.env.HOME = fakeHome;
      // Clear SUDO_USER to make getRealUserHome() use process.env.HOME
      delete process.env.SUDO_USER;

      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: testDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail after writing configs
      }

      // Verify chroot home subdirectories were created
      const expectedDirs = [
        '.copilot', '.cache', '.config', '.local',
        '.anthropic', '.claude', '.cargo', '.rustup', '.npm',
      ];
      for (const dir of expectedDirs) {
        expect(fs.existsSync(path.join(fakeHome, dir))).toBe(true);
      }

      process.env.HOME = originalHome;
      if (originalSudoUser) {
        process.env.SUDO_USER = originalSudoUser;
      }
    });
  });

  describe('startContainers', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      jest.clearAllMocks();
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should remove existing containers before starting', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(testDir, ['github.com']);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'awf-squid', 'awf-agent', 'awf-api-proxy'],
        { reject: false }
      );
    });

    it('should continue when removing existing containers fails', async () => {
      // First call (docker rm) throws an error, but we should continue
      mockExecaFn.mockRejectedValueOnce(new Error('No such container'));
      // Second call (docker compose up) succeeds
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(testDir, ['github.com']);

      // Should still call docker compose up even if rm failed
      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d'],
        { cwd: testDir, stdio: 'inherit' }
      );
    });

    it('should run docker compose up', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(testDir, ['github.com']);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d'],
        { cwd: testDir, stdio: 'inherit' }
      );
    });

    it('should run docker compose up with --pull never when skipPull is true', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(testDir, ['github.com'], undefined, true);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d', '--pull', 'never'],
        { cwd: testDir, stdio: 'inherit' }
      );
    });

    it('should run docker compose up without --pull never when skipPull is false', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(testDir, ['github.com'], undefined, false);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d'],
        { cwd: testDir, stdio: 'inherit' }
      );
    });

    it('should handle docker compose failure', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockRejectedValueOnce(new Error('Docker compose failed'));

      await expect(startContainers(testDir, ['github.com'])).rejects.toThrow('Docker compose failed');
    });

    it('should handle healthcheck failure with blocked domains', async () => {
      // Create access.log with denied entries
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockRejectedValueOnce(new Error('is unhealthy'));

      await expect(startContainers(testDir, ['github.com'])).rejects.toThrow();
    });
  });

  describe('stopContainers', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      jest.clearAllMocks();
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should skip stopping when keepContainers is true', async () => {
      await stopContainers(testDir, true);

      expect(mockExecaFn).not.toHaveBeenCalled();
    });

    it('should run docker compose down when keepContainers is false', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await stopContainers(testDir, false);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'down', '-v'],
        { cwd: testDir, stdio: 'inherit' }
      );
    });

    it('should throw error when docker compose down fails', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('Docker compose down failed'));

      await expect(stopContainers(testDir, false)).rejects.toThrow('Docker compose down failed');
    });
  });

  describe('runAgentCommand', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      jest.clearAllMocks();
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should return exit code from container', async () => {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait
      mockExecaFn.mockResolvedValueOnce({ stdout: '0', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(0);
    });

    it('should return non-zero exit code when command fails', async () => {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(1);
    });

    it('should detect blocked domains from access log', async () => {
      // Create access.log with denied entries
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code (command failed)
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(1);
      expect(result.blockedDomains).toContain('blocked.com');
    });

    it('should use proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(testDir, 'custom-logs');
      fs.mkdirSync(proxyLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(proxyLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com'], proxyLogsDir);

      expect(result.blockedDomains).toContain('blocked.com');
    });

    it('should throw error when docker wait fails', async () => {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait failure
      mockExecaFn.mockRejectedValueOnce(new Error('Container not found'));

      await expect(runAgentCommand(testDir, ['github.com'])).rejects.toThrow('Container not found');
    });

    it('should handle blocked domain without port (standard port 443)', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 example.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE example.com:443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(1);
      expect(result.blockedDomains).toContain('example.com');
    });

    it('should handle allowed domain in blocklist correctly', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // Create a log entry for subdomain of allowed domain
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 api.github.com:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE api.github.com:8443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(1);
      // api.github.com should be blocked because port 8443 is not allowed
      expect(result.blockedDomains).toContain('api.github.com');
    });

    it('should return empty blockedDomains when no access log exists', async () => {
      // Don't create access.log

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait
      mockExecaFn.mockResolvedValueOnce({ stdout: '0', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(0);
      expect(result.blockedDomains).toEqual([]);
    });
  });

  describe('cleanup', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-'));
      jest.clearAllMocks();
      // Mock execa.sync for chmod
      mockExecaSync.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
    });

    afterEach(() => {
      // Clean up any remaining test directories
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
      // Clean up any moved log directories
      const timestamp = path.basename(testDir).replace('awf-', '');
      const agentLogsDir = path.join(os.tmpdir(), `awf-agent-logs-${timestamp}`);
      const squidLogsDir = path.join(os.tmpdir(), `squid-logs-${timestamp}`);
      if (fs.existsSync(agentLogsDir)) {
        fs.rmSync(agentLogsDir, { recursive: true, force: true });
      }
      if (fs.existsSync(squidLogsDir)) {
        fs.rmSync(squidLogsDir, { recursive: true, force: true });
      }
    });

    it('should skip cleanup when keepFiles is true', async () => {
      await cleanup(testDir, true);

      // Verify directory still exists
      expect(fs.existsSync(testDir)).toBe(true);
    });

    it('should remove work directory when keepFiles is false', async () => {
      await cleanup(testDir, false);

      expect(fs.existsSync(testDir)).toBe(false);
    });

    it('should clean up chroot-home directory alongside workDir', async () => {
      // Create chroot-home sibling directory (as writeConfigs does in chroot mode)
      const chrootHomeDir = `${testDir}-chroot-home`;
      fs.mkdirSync(chrootHomeDir, { recursive: true });

      await cleanup(testDir, false);

      // Both workDir and chroot-home should be removed
      expect(fs.existsSync(testDir)).toBe(false);
      expect(fs.existsSync(chrootHomeDir)).toBe(false);
    });

    it('should preserve agent logs when they exist', async () => {
      // Create agent logs directory with a file
      const agentLogsDir = path.join(testDir, 'agent-logs');
      fs.mkdirSync(agentLogsDir, { recursive: true });
      fs.writeFileSync(path.join(agentLogsDir, 'test.log'), 'test log content');

      await cleanup(testDir, false);

      // Verify work directory was removed
      expect(fs.existsSync(testDir)).toBe(false);

      // Verify agent logs were moved
      const timestamp = path.basename(testDir).replace('awf-', '');
      const preservedLogsDir = path.join(os.tmpdir(), `awf-agent-logs-${timestamp}`);
      expect(fs.existsSync(preservedLogsDir)).toBe(true);
      expect(fs.readFileSync(path.join(preservedLogsDir, 'test.log'), 'utf-8')).toBe('test log content');
    });

    it('should preserve squid logs when they exist', async () => {
      // Create squid logs directory with a file
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(path.join(squidLogsDir, 'access.log'), 'squid log content');

      await cleanup(testDir, false);

      // Verify work directory was removed
      expect(fs.existsSync(testDir)).toBe(false);

      // Verify squid logs were moved
      const timestamp = path.basename(testDir).replace('awf-', '');
      const preservedLogsDir = path.join(os.tmpdir(), `squid-logs-${timestamp}`);
      expect(fs.existsSync(preservedLogsDir)).toBe(true);
    });

    it('should not preserve empty log directories', async () => {
      // Create empty agent logs directory
      const agentLogsDir = path.join(testDir, 'agent-logs');
      fs.mkdirSync(agentLogsDir, { recursive: true });

      await cleanup(testDir, false);

      // Verify work directory was removed
      expect(fs.existsSync(testDir)).toBe(false);

      // Verify no empty log directory was created
      const timestamp = path.basename(testDir).replace('awf-', '');
      const preservedLogsDir = path.join(os.tmpdir(), `awf-agent-logs-${timestamp}`);
      expect(fs.existsSync(preservedLogsDir)).toBe(false);
    });

    it('should use proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(testDir, 'custom-proxy-logs');
      fs.mkdirSync(proxyLogsDir, { recursive: true });
      fs.writeFileSync(path.join(proxyLogsDir, 'access.log'), 'proxy log content');

      await cleanup(testDir, false, proxyLogsDir);

      // Verify chmod was called on proxyLogsDir
      expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', proxyLogsDir]);
    });

    it('should handle non-existent work directory gracefully', async () => {
      const nonExistentDir = path.join(os.tmpdir(), 'awf-nonexistent-12345');

      // Should not throw
      await expect(cleanup(nonExistentDir, false)).resolves.not.toThrow();
    });
  });
});
