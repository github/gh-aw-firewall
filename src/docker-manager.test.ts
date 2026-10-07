// Tests for the docker-manager barrel module.
//
// docker-manager.ts re-exports the public API from several focused modules
// (host-env, config-writer, container-lifecycle, container-cleanup). Those
// modules have their own dedicated test suites; this file verifies that the
// barrel module itself correctly re-exports every expected symbol and that
// each symbol has the expected shape (function). This exercises the barrel's
// export statements for coverage purposes without duplicating the underlying
// module tests.

import * as dockerManager from './docker-manager';
import { execFileSync } from 'child_process';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFileSync: jest.fn() }));
const mockExec = execFileSync as unknown as jest.Mock;
type Compose = Parameters<typeof dockerManager.filterComposeCapDrop>[0];
type Out = { services: Record<string, { cap_drop?: string[] }> };

describe('docker-manager (barrel re-exports)', () => {
  it('re-exports host-env symbols', () => {
    expect(typeof dockerManager.setAwfDockerHost).toBe('function');
    expect(typeof dockerManager.getLocalDockerEnv).toBe('function');
    expect(typeof dockerManager.parseDifcProxyHost).toBe('function');
  });

  it('re-exports config-writer symbols', () => {
    expect(typeof dockerManager.writeConfigs).toBe('function');
  });

  it('re-exports container-lifecycle symbols', () => {
    expect(typeof dockerManager.startContainers).toBe('function');
    expect(typeof dockerManager.runAgentCommand).toBe('function');
    expect(typeof dockerManager.fastKillAgentContainer).toBe('function');
  });

  it('re-exports container-cleanup symbols', () => {
    expect(typeof dockerManager.collectDiagnosticLogs).toBe('function');
    expect(typeof dockerManager.stopContainers).toBe('function');
    expect(typeof dockerManager.preserveIptablesAudit).toBe('function');
    expect(typeof dockerManager.cleanup).toBe('function');
  });

  it('re-exports capability-filter symbols', () => {
    expect(typeof dockerManager.filterCapDrop).toBe('function');
    expect(typeof dockerManager.filterComposeCapDrop).toBe('function');
    expect(typeof dockerManager.getHostCapabilityBoundingSet).toBe('function');
    expect(typeof dockerManager.isCapDropSkipped).toBe('function');
  });

  it('exposes no unexpected additional exports', () => {
    const expectedExports = new Set([
      'setAwfDockerHost',
      'getLocalDockerEnv',
      'parseDifcProxyHost',
      'writeConfigs',
      'startContainers',
      'runAgentCommand',
      'fastKillAgentContainer',
      'collectDiagnosticLogs',
      'stopContainers',
      'preserveIptablesAudit',
      'cleanup',
      'filterCapDrop',
      'filterComposeCapDrop',
      'getHostCapabilityBoundingSet',
      'isCapDropSkipped',
    ]);
    const actualExports = new Set(Object.keys(dockerManager));
    expect(actualExports).toEqual(expectedExports);
  });

  it('filterCapDrop behaves as a pass-through re-export (basic sanity)', () => {
    // Exercises the re-exported function directly for coverage of the
    // barrel's export wiring; detailed behavior is covered in
    // capability-filter.test.ts.
    const result = dockerManager.filterCapDrop(['ALL'], null);
    expect(Array.isArray(result)).toBe(true);
  });

  it('isCapDropSkipped returns a boolean via the barrel re-export', () => {
    expect(typeof dockerManager.isCapDropSkipped()).toBe('boolean');
  });






  describe('filterCapDrop with explicit bounding set', () => {
    const original = process.env.AWF_SKIP_CAP_DROP;
    afterEach(() => {
      if (original === undefined) delete process.env.AWF_SKIP_CAP_DROP;
      else process.env.AWF_SKIP_CAP_DROP = original;
    });

    it('returns the original list when the bounding set is unknown', () => {
      delete process.env.AWF_SKIP_CAP_DROP;
      expect(dockerManager.filterCapDrop(['NET_ADMIN'], null)).toEqual(['NET_ADMIN']);
    });

    it('keeps ALL and drops capabilities absent from the bounding set', () => {
      delete process.env.AWF_SKIP_CAP_DROP;
      const capBnd = BigInt(1) << BigInt(12); // NET_ADMIN only
      expect(dockerManager.filterCapDrop(['ALL', 'NET_ADMIN', 'SYS_ADMIN'], capBnd)).toEqual(['ALL', 'NET_ADMIN']);
    });

    it.each(['1', 'true', 'YES'])('returns empty when AWF_SKIP_CAP_DROP=%s', (v) => {
      process.env.AWF_SKIP_CAP_DROP = v;
      expect(dockerManager.isCapDropSkipped()).toBe(true);
      expect(dockerManager.filterCapDrop(['ALL'], null)).toEqual([]);
    });

    it('does not skip for other values', () => {
      process.env.AWF_SKIP_CAP_DROP = 'no';
      expect(dockerManager.isCapDropSkipped()).toBe(false);
    });
  });

  describe('getHostCapabilityBoundingSet via barrel', () => {
    beforeEach(() => mockExec.mockReset());

    it('parses CapBnd from probe output', () => {
      mockExec.mockReturnValue('Name:\tsh\nCapBnd:\t000000000000ffff\n');
      expect(dockerManager.getHostCapabilityBoundingSet('img:1')).toBe(BigInt(0xffff));
      expect(mockExec.mock.calls[0][1]).toContain('img:1');
    });

    it('returns null when CapBnd is missing or docker fails', () => {
      mockExec.mockReturnValueOnce('Name: sh\n');
      expect(dockerManager.getHostCapabilityBoundingSet()).toBeNull();
      mockExec.mockImplementationOnce(() => { throw new Error('no docker'); });
      expect(dockerManager.getHostCapabilityBoundingSet()).toBeNull();
    });
  });

  describe('filterComposeCapDrop via barrel', () => {
    const original = process.env.AWF_SKIP_CAP_DROP;
    beforeEach(() => { mockExec.mockReset(); delete process.env.AWF_SKIP_CAP_DROP; });
    afterEach(() => {
      if (original === undefined) delete process.env.AWF_SKIP_CAP_DROP;
      else process.env.AWF_SKIP_CAP_DROP = original;
    });

    it('returns config unchanged when it has no services', () => {
      const cfg = {} as unknown as Compose;
      expect(dockerManager.filterComposeCapDrop(cfg, null)).toBe(cfg);
    });

    it('filters per-service cap_drop and removes empty lists', () => {
      const capBnd = BigInt(1) << BigInt(12);
      const cfg = {
        services: {
          a: { image: 'x', cap_drop: ['NET_ADMIN', 'SYS_ADMIN'] },
          b: { image: 'y', cap_drop: ['SYS_ADMIN'] },
          c: { image: 'z' },
        },
      } as unknown as Compose;
      const out = dockerManager.filterComposeCapDrop(cfg, capBnd) as unknown as Out;
      expect(out.services.a.cap_drop).toEqual(['NET_ADMIN']);
      expect(out.services.b.cap_drop).toBeUndefined();
      expect(out.services.c.cap_drop).toBeUndefined();
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('probes the daemon with the first service image when no override is given', () => {
      mockExec.mockReturnValue('CapBnd:\t0000000000000000\n');
      const cfg = { services: { a: { image: 'probe:img', cap_drop: ['NET_ADMIN', 'ALL'] } } } as unknown as Compose;
      const out = dockerManager.filterComposeCapDrop(cfg) as unknown as Out;
      expect(mockExec.mock.calls[0][1]).toContain('probe:img');
      expect(out.services.a.cap_drop).toEqual(['ALL']);
    });
  });

  describe('filterCapDrop via barrel', () => {
    it('returns empty for undefined or empty lists', () => {
      expect(dockerManager.filterCapDrop(undefined, null)).toEqual([]);
      expect(dockerManager.filterCapDrop([], null)).toEqual([]);
    });
  });
});

describe('parseDifcProxyHost via barrel', () => {
  it('defaults for empty or whitespace input', () => {
    expect(dockerManager.parseDifcProxyHost('  ')).toEqual({ host: 'host.docker.internal', port: '18443' });
  });

  it('parses host:port, schemes, and bracketed IPv6', () => {
    expect(dockerManager.parseDifcProxyHost('proxy.local:9000')).toEqual({ host: 'proxy.local', port: '9000' });
    expect(dockerManager.parseDifcProxyHost('https://proxy.local:443')).toEqual({ host: 'proxy.local', port: '443' });
    expect(dockerManager.parseDifcProxyHost('[::1]:18443')).toEqual({ host: '::1', port: '18443' });
    expect(dockerManager.parseDifcProxyHost('proxy.local')).toEqual({ host: 'proxy.local', port: '18443' });
  });

  it('rejects malformed hosts and out-of-range ports', () => {
    expect(() => dockerManager.parseDifcProxyHost('host:abc')).toThrow(/Invalid --difc-proxy-host/);
    expect(() => dockerManager.parseDifcProxyHost('host:0')).toThrow(/between 1 and 65535/);
    expect(() => dockerManager.parseDifcProxyHost('host:70000')).toThrow(/Invalid --difc-proxy-host/);
  });
});
