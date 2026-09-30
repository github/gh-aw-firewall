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


  describe('parseDifcProxyHost via barrel', () => {
    it('returns defaults for empty input', () => {
      expect(dockerManager.parseDifcProxyHost('  ')).toEqual({ host: 'host.docker.internal', port: '18443' });
    });

    it('parses host:port and strips scheme', () => {
      expect(dockerManager.parseDifcProxyHost('https://example.com:443')).toEqual({ host: 'example.com', port: '443' });
    });

    it('strips IPv6 brackets', () => {
      expect(dockerManager.parseDifcProxyHost('[::1]:9000')).toEqual({ host: '::1', port: '9000' });
    });

    it('rejects out-of-range ports', () => {
      expect(() => dockerManager.parseDifcProxyHost('host:70000')).toThrow();
    });
  });

  describe('filterCapDrop with bounding set override', () => {
    it('returns the list unchanged when bounding set is unknown', () => {
      expect(dockerManager.filterCapDrop(['NET_RAW'], null)).toEqual(['NET_RAW']);
    });

    it('keeps ALL and unknown capability names', () => {
      expect(dockerManager.filterCapDrop(['ALL', 'NOT_A_CAP'], 0n)).toEqual(['ALL', 'NOT_A_CAP']);
    });
  });

  describe('filterCapDrop via barrel', () => {
    it('returns empty for undefined or empty lists', () => {
      expect(dockerManager.filterCapDrop(undefined, null)).toEqual([]);
      expect(dockerManager.filterCapDrop([], null)).toEqual([]);
    });
  });
});
