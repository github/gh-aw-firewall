import { buildContainerSecurityHardening } from './service-security';

describe('buildContainerSecurityHardening', () => {
  it('returns cap_drop ALL and no-new-privileges for a basic config', () => {
    const result = buildContainerSecurityHardening({ memLimit: '256m', pidsLimit: 50 });
    expect(result.cap_drop).toEqual(['ALL']);
    expect(result.security_opt).toEqual(['no-new-privileges:true']);
  });

  it('sets mem_limit to the supplied value', () => {
    const result = buildContainerSecurityHardening({ memLimit: '512m', pidsLimit: 100 });
    expect(result.mem_limit).toBe('512m');
  });

  it('sets memswap_limit equal to mem_limit', () => {
    const result = buildContainerSecurityHardening({ memLimit: '512m', pidsLimit: 100 });
    expect(result.memswap_limit).toBe('512m');
  });

  it('sets pids_limit to the supplied value', () => {
    const result = buildContainerSecurityHardening({ memLimit: '256m', pidsLimit: 75 });
    expect(result.pids_limit).toBe(75);
  });

  it('omits cpu_shares when cpuShares is undefined', () => {
    const result = buildContainerSecurityHardening({ memLimit: '256m', pidsLimit: 50 });
    expect(result).not.toHaveProperty('cpu_shares');
  });

  it('includes cpu_shares when cpuShares is provided', () => {
    const result = buildContainerSecurityHardening({ memLimit: '512m', pidsLimit: 100, cpuShares: 512 });
    expect(result.cpu_shares).toBe(512);
  });

  it('includes cpu_shares: 0 when cpuShares is explicitly 0', () => {
    const result = buildContainerSecurityHardening({ memLimit: '256m', pidsLimit: 50, cpuShares: 0 });
    // cpuShares: 0 is falsy but still defined — should be included
    expect(result).toHaveProperty('cpu_shares', 0);
  });

  it('returns all expected keys for a full config', () => {
    const result = buildContainerSecurityHardening({ memLimit: '1g', pidsLimit: 200, cpuShares: 1024 });
    const keys = Object.keys(result);
    expect(keys).toContain('cap_drop');
    expect(keys).toContain('security_opt');
    expect(keys).toContain('mem_limit');
    expect(keys).toContain('memswap_limit');
    expect(keys).toContain('pids_limit');
    expect(keys).toContain('cpu_shares');
  });

  it('returns a plain object (not a class instance)', () => {
    const result = buildContainerSecurityHardening({ memLimit: '256m', pidsLimit: 50 });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
