import { WrapperConfig } from './service-test-setup.test-utils';
import { testHelpers } from './agent-service.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { buildAgentSecurityConfig } = testHelpers;

describe('buildAgentSecurityConfig', () => {
  const workDir = '/tmp/awf-test-1234';
  const baseSecurityConfig: WrapperConfig = {
    allowedDomains: ['github.com'],
    agentCommand: 'echo test',
    logLevel: 'info',
    keepContainers: false,
    workDir,
    buildLocal: false,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
  };

  it('adds SYS_CHROOT and SYS_ADMIN to cap_add', () => {
    const result = buildAgentSecurityConfig(baseSecurityConfig);
    expect(result.cap_add).toContain('SYS_CHROOT');
    expect(result.cap_add).toContain('SYS_ADMIN');
  });

  it('does NOT add NET_ADMIN to cap_add', () => {
    const result = buildAgentSecurityConfig(baseSecurityConfig);
    expect(result.cap_add).not.toContain('NET_ADMIN');
  });

  it('drops NET_RAW, SYS_PTRACE, SYS_MODULE, SYS_RAWIO, MKNOD capabilities', () => {
    const result = buildAgentSecurityConfig(baseSecurityConfig);
    expect(result.cap_drop).toEqual([
      'NET_RAW',
      'SYS_PTRACE',
      'SYS_MODULE',
      'SYS_RAWIO',
      'MKNOD',
    ]);
  });

  it('sets no-new-privileges and apparmor:unconfined security options', () => {
    const result = buildAgentSecurityConfig(baseSecurityConfig);
    expect(result.security_opt).toContain('no-new-privileges:true');
    expect(result.security_opt).toContain('apparmor:unconfined');
  });

  it('sets seccomp profile path relative to workDir', () => {
    const result = buildAgentSecurityConfig(baseSecurityConfig);
    expect(result.security_opt).toContain(`seccomp=${workDir}/seccomp-profile.json`);
  });

  it('includes tmpfs overlays for workDir and mcp-logs (both plain and /host-prefixed)', () => {
    const result = buildAgentSecurityConfig(baseSecurityConfig);
    expect(result.tmpfs).toContain('/tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m');
    expect(result.tmpfs).toContain('/host/tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m');
    expect(result.tmpfs).toContain(`${workDir}:rw,noexec,nosuid,size=1m`);
    expect(result.tmpfs).toContain(`/host${workDir}:rw,noexec,nosuid,size=1m`);
    expect(result.tmpfs).toContain('/host/dev/shm:rw,noexec,nosuid,nodev,size=65536k');
  });

  it('uses default 6g memory limit when memoryLimit is not set', () => {
    const result = buildAgentSecurityConfig(baseSecurityConfig);
    expect(result.mem_limit).toBe('6g');
    expect(result.memswap_limit).toBe('-1');
  });

  it('uses configured memoryLimit and disables swap when memoryLimit is set', () => {
    const result = buildAgentSecurityConfig({ ...baseSecurityConfig, memoryLimit: '4g' });
    expect(result.mem_limit).toBe('4g');
    expect(result.memswap_limit).toBe('4g');
  });

  it('sets pids_limit and cpu_shares to fixed values', () => {
    const result = buildAgentSecurityConfig(baseSecurityConfig);
    expect(result.pids_limit).toBe(1000);
    expect(result.cpu_shares).toBe(1024);
  });
});
