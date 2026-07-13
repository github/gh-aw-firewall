import execa from 'execa';
import { logger } from './logger';

jest.mock('execa');
jest.mock('./logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}));
jest.mock('./docker-host', () => ({
  getLocalDockerEnv: jest.fn(() => ({})),
}));
jest.mock('./docker-manager', () => ({
  getLocalDockerEnv: jest.fn(() => ({})),
}));

const mockExeca = execa as unknown as jest.Mock;

// --- host-iptables-validation ---

import {
  parseValidPortSpecs,
  getErrorStringProperty,
  isMissingIptablesError,
  iptablesRulesTestHelpers,
} from './host-iptables-validation';

describe('isValidPortSpec (internal)', () => {
  const { isValidPortSpec } = iptablesRulesTestHelpers;

  it('accepts valid single ports', () => {
    expect(isValidPortSpec('1')).toBe(true);
    expect(isValidPortSpec('80')).toBe(true);
    expect(isValidPortSpec('65535')).toBe(true);
  });

  it('rejects invalid single ports', () => {
    expect(isValidPortSpec('0')).toBe(false);
    expect(isValidPortSpec('65536')).toBe(false);
    expect(isValidPortSpec('abc')).toBe(false);
    expect(isValidPortSpec('')).toBe(false);
    expect(isValidPortSpec('08')).toBe(false); // leading zero
  });

  it('accepts valid port ranges', () => {
    expect(isValidPortSpec('80-443')).toBe(true);
    expect(isValidPortSpec('1-65535')).toBe(true);
    expect(isValidPortSpec('8080-8090')).toBe(true);
  });

  it('rejects invalid port ranges', () => {
    expect(isValidPortSpec('443-80')).toBe(false);   // reversed
    expect(isValidPortSpec('0-80')).toBe(false);     // start too low
    expect(isValidPortSpec('80-65536')).toBe(false); // end too high
    expect(isValidPortSpec('abc-443')).toBe(false);
  });
});

describe('parseValidPortSpecs', () => {
  it('returns empty array for undefined input', () => {
    expect(parseValidPortSpecs(undefined, 'port')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseValidPortSpecs('', 'port')).toEqual([]);
  });

  it('parses single valid port', () => {
    expect(parseValidPortSpecs('8080', 'port')).toEqual(['8080']);
  });

  it('parses multiple valid ports', () => {
    expect(parseValidPortSpecs('80,443,8080', 'port')).toEqual(['80', '443', '8080']);
  });

  it('parses valid port ranges', () => {
    expect(parseValidPortSpecs('8000-9000', 'port')).toEqual(['8000-9000']);
  });

  it('skips invalid entries and warns', () => {
    const result = parseValidPortSpecs('80,abc,443', 'port');
    expect(result).toEqual(['80', '443']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('abc'));
  });

  it('trims whitespace around entries', () => {
    expect(parseValidPortSpecs(' 80 , 443 ', 'port')).toEqual(['80', '443']);
  });

  it('skips empty segments from trailing comma', () => {
    expect(parseValidPortSpecs('80,', 'port')).toEqual(['80']);
  });
});

describe('getErrorStringProperty', () => {
  it('returns string property value', () => {
    expect(getErrorStringProperty({ code: 'ENOENT' }, 'code')).toBe('ENOENT');
  });

  it('returns empty string for missing property', () => {
    expect(getErrorStringProperty({ code: 'ENOENT' }, 'stderr')).toBe('');
  });

  it('returns empty string for non-string property', () => {
    expect(getErrorStringProperty({ code: 42 }, 'code')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(getErrorStringProperty(null, 'code')).toBe('');
  });

  it('returns empty string for non-object', () => {
    expect(getErrorStringProperty('error', 'code')).toBe('');
  });
});

describe('isMissingIptablesError', () => {
  it('returns true for ENOENT code', () => {
    expect(isMissingIptablesError({ code: 'ENOENT' })).toBe(true);
  });

  it('returns true for Error with ENOENT in message', () => {
    expect(isMissingIptablesError(new Error('spawn ENOENT'))).toBe(true);
  });

  it('returns true for Error with "not found" in message', () => {
    expect(isMissingIptablesError(new Error('iptables not found'))).toBe(true);
  });

  it('returns false for permission denied error', () => {
    expect(isMissingIptablesError({ code: 'EPERM', stderr: 'Permission denied' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isMissingIptablesError(null)).toBe(false);
  });
});

// --- host-iptables-shared ---

import {
  isIp6tablesAvailable,
  getDockerBridgeGateway,
  getNetworkBridgeName,
  addDnsRules,
  cleanupChain,
  disableIpv6ViaSysctl,
  enableIpv6ViaSysctl,
  iptablesSharedTestHelpers,
} from './host-iptables-shared';

beforeEach(() => {
  jest.clearAllMocks();
  iptablesSharedTestHelpers.resetIpv6State();
});

describe('isIp6tablesAvailable', () => {
  it('returns true when ip6tables works', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'ip6tables v1.8.4' });
    const result = await isIp6tablesAvailable();
    expect(result).toBe(true);
    expect(mockExeca).toHaveBeenCalledWith('ip6tables', ['-L', '-n'], expect.any(Object));
  });

  it('returns false when ip6tables is unavailable', async () => {
    mockExeca.mockRejectedValueOnce(new Error('ip6tables not found'));
    const result = await isIp6tablesAvailable();
    expect(result).toBe(false);
  });

  it('caches result on second call', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    await isIp6tablesAvailable();
    await isIp6tablesAvailable();
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });
});

describe('getNetworkBridgeName', () => {
  it('returns bridge name on success', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'fw-bridge\n' });
    const result = await getNetworkBridgeName();
    expect(result).toBe('fw-bridge');
  });

  it('returns null when stdout is empty', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '   ' });
    const result = await getNetworkBridgeName();
    expect(result).toBeNull();
  });

  it('returns null on error', async () => {
    mockExeca.mockRejectedValueOnce(new Error('docker not found'));
    const result = await getNetworkBridgeName();
    expect(result).toBeNull();
  });
});

describe('getDockerBridgeGateway', () => {
  it('returns gateway IP on success', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '172.17.0.1\n' });
    const result = await getDockerBridgeGateway();
    expect(result).toBe('172.17.0.1');
  });

  it('returns null for empty stdout', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    const result = await getDockerBridgeGateway();
    expect(result).toBeNull();
  });

  it('returns null for invalid IPv4 format', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'not-an-ip' });
    const result = await getDockerBridgeGateway();
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid IPv4'));
  });

  it('returns null on error', async () => {
    mockExeca.mockRejectedValueOnce(new Error('network not found'));
    const result = await getDockerBridgeGateway();
    expect(result).toBeNull();
  });
});

describe('addDnsRules', () => {
  it('adds UDP and TCP rules for DNS', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 });
    await addDnsRules('iptables', 'FW_WRAPPER', '8.8.8.8');
    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(mockExeca).toHaveBeenCalledWith('iptables', expect.arrayContaining(['-p', 'udp', '-d', '8.8.8.8', '--dport', '53']));
    expect(mockExeca).toHaveBeenCalledWith('iptables', expect.arrayContaining(['-p', 'tcp', '-d', '8.8.8.8', '--dport', '53']));
  });

  it('rolls back UDP rule if TCP rule fails', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0 }) // UDP add succeeds
      .mockRejectedValueOnce(new Error('tcp failed')) // TCP add fails
      .mockResolvedValueOnce({ exitCode: 0 }); // rollback UDP delete

    await expect(addDnsRules('iptables', 'FW_WRAPPER', '8.8.8.8')).rejects.toThrow('tcp failed');
    // Should attempt rollback (delete)
    expect(mockExeca).toHaveBeenCalledWith('iptables', expect.arrayContaining(['-D']));
  });

  it('works with ip6tables for IPv6 DNS server', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 });
    await addDnsRules('ip6tables', 'FW_WRAPPER_V6', '2001:4860:4860::8888');
    expect(mockExeca).toHaveBeenCalledWith('ip6tables', expect.arrayContaining(['-d', '2001:4860:4860::8888']));
  });
});

describe('cleanupChain', () => {
  it('removes DOCKER-USER references and flushes chain', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: '1    FW_WRAPPER  -i fw-bridge\n2    RETURN\n', exitCode: 0 }) // list
      .mockResolvedValueOnce({ exitCode: 0 }) // delete line 1
      .mockResolvedValueOnce({ exitCode: 0 }) // flush
      .mockResolvedValueOnce({ exitCode: 0 }); // delete chain

    await cleanupChain('iptables', 'FW_WRAPPER');
    expect(mockExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '1'], expect.any(Object));
  });

  it('skips DOCKER-USER reference removal when removeDockerUserReferences is false', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0 }) // flush
      .mockResolvedValueOnce({ exitCode: 0 }); // delete chain

    await cleanupChain('iptables', 'FW_WRAPPER', { removeDockerUserReferences: false });
    // Should not list DOCKER-USER
    expect(mockExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining(['-L', 'DOCKER-USER']), expect.anything());
  });

  it('uses matchPredicate to filter lines', async () => {
    const output = '1    FW_WRAPPER  -i fw-bridge\n2    OTHER_CHAIN\n';
    mockExeca
      .mockResolvedValueOnce({ stdout: output, exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 0 }) // delete
      .mockResolvedValueOnce({ exitCode: 0 }) // flush
      .mockResolvedValueOnce({ exitCode: 0 }); // delete chain

    const predicate = (line: string) => line.includes('fw-bridge') && line.includes('FW_WRAPPER');
    await cleanupChain('iptables', 'FW_WRAPPER', { matchPredicate: predicate });
    expect(mockExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '1'], expect.any(Object));
    expect(mockExeca).not.toHaveBeenCalledWith('iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '2'], expect.any(Object));
  });
});

describe('disableIpv6ViaSysctl', () => {
  it('calls sysctl to disable IPv6', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 });
    await disableIpv6ViaSysctl();
    expect(mockExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=1']);
    expect(mockExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=1']);
  });

  it('warns but does not throw on sysctl failure', async () => {
    mockExeca.mockRejectedValue(new Error('permission denied'));
    await expect(disableIpv6ViaSysctl()).resolves.not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('enableIpv6ViaSysctl', () => {
  it('does nothing if IPv6 was not disabled', async () => {
    await enableIpv6ViaSysctl();
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('re-enables IPv6 if previously disabled', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 });
    await disableIpv6ViaSysctl(); // set the flag
    jest.clearAllMocks();

    mockExeca.mockResolvedValue({ exitCode: 0 });
    await enableIpv6ViaSysctl();
    expect(mockExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=0']);
    expect(mockExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=0']);
  });

  it('does not throw if sysctl fails during re-enable', async () => {
    mockExeca.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('sysctl error'));
    await disableIpv6ViaSysctl();
    jest.clearAllMocks();

    mockExeca.mockRejectedValue(new Error('sysctl failed'));
    await expect(enableIpv6ViaSysctl()).resolves.not.toThrow();
  });
});

// --- host-iptables-cleanup ---

import { cleanupHostIptables } from './host-iptables-cleanup';

describe('cleanupHostIptables', () => {
  it('runs cleanup successfully with bridge name', async () => {
    // getNetworkBridgeName (docker inspect), cleanupChain internals, isIp6tablesAvailable, enableIpv6ViaSysctl
    mockExeca
      .mockResolvedValueOnce({ stdout: 'fw-bridge' }) // getNetworkBridgeName
      .mockResolvedValueOnce({ stdout: '', exitCode: 0 }) // list DOCKER-USER (cleanupChain ipv4)
      .mockResolvedValueOnce({ exitCode: 0 }) // flush ipv4
      .mockResolvedValueOnce({ exitCode: 0 }) // delete ipv4 chain
      .mockResolvedValueOnce({ stdout: '' }) // ip6tables -L (isIp6tablesAvailable)
      .mockResolvedValueOnce({ stdout: '', exitCode: 0 }) // list DOCKER-USER (cleanupChain ipv6)
      .mockResolvedValueOnce({ exitCode: 0 }) // flush ipv6
      .mockResolvedValueOnce({ exitCode: 0 }); // delete ipv6 chain

    await expect(cleanupHostIptables()).resolves.not.toThrow();
  });

  it('handles null bridge name gracefully', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('no bridge')) // getNetworkBridgeName fails → null
      .mockResolvedValueOnce({ stdout: '', exitCode: 0 }) // list DOCKER-USER ipv4
      .mockResolvedValueOnce({ exitCode: 0 }) // flush ipv4
      .mockResolvedValueOnce({ exitCode: 0 }) // delete ipv4 chain
      .mockRejectedValueOnce(new Error('no ip6tables')); // ip6tables check fails

    await expect(cleanupHostIptables()).resolves.not.toThrow();
  });

  it('does not throw on errors (best-effort cleanup)', async () => {
    mockExeca.mockRejectedValue(new Error('iptables error'));
    await expect(cleanupHostIptables()).resolves.not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Error'), expect.any(Error));
  });

  it('skips IPv6 cleanup when ip6tables unavailable', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: 'fw-bridge' }) // getNetworkBridgeName
      .mockResolvedValueOnce({ stdout: '', exitCode: 0 }) // list DOCKER-USER
      .mockResolvedValueOnce({ exitCode: 0 }) // flush
      .mockResolvedValueOnce({ exitCode: 0 }) // delete chain
      .mockRejectedValueOnce(new Error('ip6tables not found')); // isIp6tablesAvailable → false

    await cleanupHostIptables();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('ip6tables not available'));
  });
});

// --- host-iptables-network ---

import { ensureFirewallNetwork } from './host-iptables-network';

describe('ensureFirewallNetwork', () => {
  it('returns network config when network already exists', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '[]' }); // docker network inspect

    const result = await ensureFirewallNetwork();
    expect(result).toEqual({
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
      proxyIp: '172.30.0.30',
    });
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('creates network if it does not exist', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('no network')) // inspect fails
      .mockResolvedValueOnce({ stdout: '' }); // create succeeds

    const result = await ensureFirewallNetwork();
    expect(result.subnet).toBe('172.30.0.0/24');
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['network', 'create', 'awf-net']),
      expect.any(Object),
    );
    expect(logger.success).toHaveBeenCalled();
  });

  it('propagates error on network creation failure', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('no network'))
      .mockRejectedValueOnce(new Error('create failed'));

    await expect(ensureFirewallNetwork()).rejects.toThrow('create failed');
  });
});
