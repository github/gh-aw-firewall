import {
  assertNetworkSubnetUsable,
  parseNetworkSubnet,
  resolveNetworkAddressing,
} from './network-subnet';
import { NETWORK_SUBNET, SQUID_IP } from './config/network-policy';

/** Builds a /proc/net/route body (little-endian hex, as the kernel emits it). */
function procNetRoute(entries: { iface: string; destination: string; mask: string }[]): string {
  const toHex = (ip: string): string =>
    ip
      .split('.')
      .map((octet) => Number(octet).toString(16).padStart(2, '0'))
      .reverse()
      .join('')
      .toUpperCase();
  const header =
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';
  const rows = entries.map(
    (entry) =>
      `${entry.iface}\t${toHex(entry.destination)}\t00000000\t0001\t0\t0\t0\t${toHex(entry.mask)}\t0\t0\t0`,
  );
  return [header, ...rows].join('\n');
}

describe('parseNetworkSubnet', () => {
  it('canonicalizes the value by clearing host bits', () => {
    expect(parseNetworkSubnet('10.88.0.5/24')).toBe('10.88.0.0/24');
    expect(parseNetworkSubnet(' 192.168.50.0/24 ')).toBe('192.168.50.0/24');
  });

  it('rejects non-CIDR values', () => {
    expect(() => parseNetworkSubnet('10.88.0.0')).toThrow(/Invalid network subnet/);
    expect(() => parseNetworkSubnet('999.0.0.0/24')).toThrow(/Invalid network subnet/);
  });

  it('rejects prefixes outside /16../26', () => {
    expect(() => parseNetworkSubnet('10.0.0.0/8')).toThrow(/prefix length/);
    expect(() => parseNetworkSubnet('10.88.0.0/28')).toThrow(/prefix length/);
  });
});

describe('resolveNetworkAddressing', () => {
  it('returns the policy defaults when no override is given', () => {
    const addressing = resolveNetworkAddressing();
    expect(addressing.subnet).toBe(NETWORK_SUBNET);
    expect(addressing.squidIp).toBe(SQUID_IP);
  });

  it('preserves the fixed host offsets inside a relocated subnet', () => {
    expect(resolveNetworkAddressing('10.88.0.0/24')).toEqual({
      subnet: '10.88.0.0/24',
      gatewayIp: '10.88.0.1',
      squidIp: '10.88.0.10',
      agentIp: '10.88.0.20',
      proxyIp: '10.88.0.30',
      dohProxyIp: '10.88.0.40',
      cliProxyIp: '10.88.0.50',
    });
  });

  it('supports wider blocks', () => {
    const addressing = resolveNetworkAddressing('10.200.0.0/16');
    expect(addressing.squidIp).toBe('10.200.0.10');
    expect(addressing.agentIp).toBe('10.200.0.20');
  });

  it('throws on an invalid override', () => {
    expect(() => resolveNetworkAddressing('not-a-cidr')).toThrow(/Invalid network subnet/);
  });
});

describe('assertNetworkSubnetUsable', () => {
  const noFiles = (): string => {
    throw new Error('ENOENT');
  };

  it('accepts a subnet with no colliding resolver or route', () => {
    expect(() =>
      assertNetworkSubnetUsable('172.30.0.0/24', {
        dnsServers: ['8.8.8.8'],
        readFile: noFiles,
      }),
    ).not.toThrow();
  });

  it('rejects a subnet containing a configured DNS resolver (OpenShift CoreDNS)', () => {
    expect(() =>
      assertNetworkSubnetUsable('172.30.0.0/24', {
        dnsServers: ['172.30.0.10'],
        readFile: noFiles,
      }),
    ).toThrow(/172\.30\.0\.10.*--network-subnet/s);
  });

  it('rejects a subnet containing a resolv.conf nameserver', () => {
    expect(() =>
      assertNetworkSubnetUsable('172.30.0.0/24', {
        readFile: (filePath) => {
          if (filePath === '/etc/resolv.conf') return 'search svc\nnameserver 172.30.0.10\n';
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/503 HIER_NONE/);
  });

  it('rejects a subnet overlapping a host route', () => {
    expect(() =>
      assertNetworkSubnetUsable('172.30.0.0/24', {
        readFile: (filePath) => {
          if (filePath === '/proc/net/route') {
            return procNetRoute([
              { iface: 'eth0', destination: '172.30.0.0', mask: '255.255.0.0' },
            ]);
          }
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/overlaps existing host route/);
  });

  it('ignores routes owned by Docker bridges, including a previous awf-net', () => {
    expect(() =>
      assertNetworkSubnetUsable('172.30.0.0/24', {
        readFile: (filePath) => {
          if (filePath === '/proc/net/route') {
            return procNetRoute([
              { iface: 'br-a1b2c3', destination: '172.30.0.0', mask: '255.255.255.0' },
              { iface: 'eth0', destination: '10.1.0.0', mask: '255.255.0.0' },
            ]);
          }
          throw new Error('ENOENT');
        },
      }),
    ).not.toThrow();
  });

  it('ignores the default route', () => {
    expect(() =>
      assertNetworkSubnetUsable('172.30.0.0/24', {
        readFile: (filePath) => {
          if (filePath === '/proc/net/route') {
            return procNetRoute([{ iface: 'eth0', destination: '0.0.0.0', mask: '0.0.0.0' }]);
          }
          throw new Error('ENOENT');
        },
      }),
    ).not.toThrow();
  });
});
