/**
 * Tests for the validation error branches in network-policy.ts.
 * These are exercised by mocking the JSON import to inject invalid data,
 * then requiring the module fresh so the top-level validate() call runs.
 */

/** Helper to reset modules and re-require with a mocked policy JSON. */
function loadWithPolicy(policy: unknown): () => unknown {
  return () => {
    jest.resetModules();
    jest.doMock('./sandbox-network-policy.json', () => policy, { virtual: false });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./network-policy');
  };
}

const BASE_POLICY = {
  topology: {
    networkName: 'awf-net',
    externalBridgeName: 'awf-ext',
    subnet: '172.30.0.0/24',
    hosts: {
      squid: { ip: '172.30.0.10', role: 'egress-proxy', required: true, dualHomed: true },
      agent: { ip: '172.30.0.20', role: 'workload', required: true },
      apiProxy: { ip: '172.30.0.30', role: 'credential-proxy', required: false },
      dohProxy: { ip: '172.30.0.40', role: 'dns-proxy', required: false },
      cliProxy: { ip: '172.30.0.50', role: 'difc-proxy', required: false },
    },
  },
  proxies: {
    squid: { port: 3128 },
    apiProxy: {
      ports: { openai: 10000, anthropic: 10001, copilot: 10002, gemini: 10003, vertex: 10004 },
      healthPort: 10000,
    },
    cliProxy: { port: 11000 },
    dohProxy: { upstreamPort: 443 },
  },
  dns: {
    embeddedResolver: '127.0.0.11',
    defaultUpstreamServers: ['8.8.8.8', '8.8.4.4'],
    port: 53,
  },
  legacyIptables: {
    hostGateway: '172.30.0.1',
    blockedPorts: [
      { port: 22, reason: 'SSH' },
      { port: 25, reason: 'SMTP' },
    ],
    blockedCidrs: [
      { cidr: '169.254.0.0/16', reason: 'link-local' },
      { cidr: '224.0.0.0/4', reason: 'multicast' },
    ],
  },
};

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('network-policy validation errors', () => {
  describe('asObject', () => {
    it('throws when root is not an object', () => {
      expect(loadWithPolicy(null)).toThrow('Invalid sandbox-network-policy.json: root must be an object');
      expect(loadWithPolicy([])).toThrow('Invalid sandbox-network-policy.json: root must be an object');
      expect(loadWithPolicy('string')).toThrow('Invalid sandbox-network-policy.json: root must be an object');
    });
  });

  describe('assertString', () => {
    it('throws when networkName is empty string', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.topology as Record<string, unknown>).networkName = '';
      expect(loadWithPolicy(policy)).toThrow('topology.networkName must be a non-empty string');
    });

    it('throws when networkName is not a string', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.topology as Record<string, unknown>).networkName = 42;
      expect(loadWithPolicy(policy)).toThrow('topology.networkName must be a non-empty string');
    });
  });

  describe('assertPort', () => {
    it('throws when port is not a number', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.proxies.squid as Record<string, unknown>).port = 'not-a-port';
      expect(loadWithPolicy(policy)).toThrow('proxies.squid.port must be an integer port in 1-65535');
    });

    it('throws when port is 0', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.proxies.squid as Record<string, unknown>).port = 0;
      expect(loadWithPolicy(policy)).toThrow('proxies.squid.port must be an integer port in 1-65535');
    });

    it('throws when port is > 65535', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.proxies.squid as Record<string, unknown>).port = 70000;
      expect(loadWithPolicy(policy)).toThrow('proxies.squid.port must be an integer port in 1-65535');
    });

    it('throws when port is a float', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.proxies.squid as Record<string, unknown>).port = 3128.5;
      expect(loadWithPolicy(policy)).toThrow('proxies.squid.port must be an integer port in 1-65535');
    });
  });

  describe('assertIpv4', () => {
    it('throws when IP has an octet > 255', () => {
      const policy = deepClone(BASE_POLICY);
      policy.topology.hosts.squid.ip = '172.30.0.300';
      expect(loadWithPolicy(policy)).toThrow('topology.hosts.squid.ip must be a valid IPv4 address');
    });

    it('throws when IP is not the right format', () => {
      const policy = deepClone(BASE_POLICY);
      policy.topology.hosts.squid.ip = 'not-an-ip';
      expect(loadWithPolicy(policy)).toThrow('topology.hosts.squid.ip must be a valid IPv4 address');
    });
  });

  describe('assertCidr', () => {
    it('throws when subnet CIDR has an octet > 255', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.topology as Record<string, unknown>).subnet = '300.30.0.0/24';
      expect(loadWithPolicy(policy)).toThrow('topology.subnet must be a valid IPv4 CIDR');
    });

    it('throws when subnet prefix length is out of range', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.topology as Record<string, unknown>).subnet = '172.30.0.0/33';
      expect(loadWithPolicy(policy)).toThrow('topology.subnet must be a valid IPv4 CIDR');
    });
  });

  describe('parseHost', () => {
    it('throws on unrecognized role', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.topology.hosts.squid as Record<string, unknown>).role = 'unknown-role';
      expect(loadWithPolicy(policy)).toThrow('topology.hosts.squid.role is not a recognized role');
    });

    it('throws when required is not a boolean', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.topology.hosts.squid as Record<string, unknown>).required = 'yes';
      expect(loadWithPolicy(policy)).toThrow('topology.hosts.squid.required must be a boolean');
    });

    it('throws when dualHomed is present but not a boolean', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.topology.hosts.squid as Record<string, unknown>).dualHomed = 'yes';
      expect(loadWithPolicy(policy)).toThrow('topology.hosts.squid.dualHomed must be a boolean when present');
    });
  });

  describe('parseHosts', () => {
    it('throws on duplicate host IPs', () => {
      const policy = deepClone(BASE_POLICY);
      policy.topology.hosts.agent.ip = '172.30.0.10'; // same as squid
      expect(loadWithPolicy(policy)).toThrow('is a duplicate address: 172.30.0.10');
    });
  });

  describe('parseDns', () => {
    it('throws when defaultUpstreamServers is empty', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.dns as Record<string, unknown>).defaultUpstreamServers = [];
      expect(loadWithPolicy(policy)).toThrow('dns.defaultUpstreamServers must be a non-empty array');
    });

    it('throws when defaultUpstreamServers is not an array', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.dns as Record<string, unknown>).defaultUpstreamServers = '8.8.8.8';
      expect(loadWithPolicy(policy)).toThrow('dns.defaultUpstreamServers must be a non-empty array');
    });
  });

  describe('parseLegacyIptables', () => {
    it('throws when blockedPorts is empty', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.legacyIptables as Record<string, unknown>).blockedPorts = [];
      expect(loadWithPolicy(policy)).toThrow('legacyIptables.blockedPorts must be a non-empty array');
    });

    it('throws when blockedPorts is not an array', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.legacyIptables as Record<string, unknown>).blockedPorts = 22;
      expect(loadWithPolicy(policy)).toThrow('legacyIptables.blockedPorts must be a non-empty array');
    });

    it('throws on duplicate blocked ports', () => {
      const policy = deepClone(BASE_POLICY);
      policy.legacyIptables.blockedPorts = [
        { port: 22, reason: 'SSH' },
        { port: 22, reason: 'SSH-dup' },
      ];
      expect(loadWithPolicy(policy)).toThrow('legacyIptables.blockedPorts has duplicate port: 22');
    });

    it('throws when blockedCidrs is empty', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.legacyIptables as Record<string, unknown>).blockedCidrs = [];
      expect(loadWithPolicy(policy)).toThrow('legacyIptables.blockedCidrs must be a non-empty array');
    });

    it('throws when blockedCidrs is not an array', () => {
      const policy = deepClone(BASE_POLICY);
      (policy.legacyIptables as Record<string, unknown>).blockedCidrs = '169.254.0.0/16';
      expect(loadWithPolicy(policy)).toThrow('legacyIptables.blockedCidrs must be a non-empty array');
    });

    it('throws on duplicate blocked CIDRs', () => {
      const policy = deepClone(BASE_POLICY);
      policy.legacyIptables.blockedCidrs = [
        { cidr: '169.254.0.0/16', reason: 'link-local' },
        { cidr: '169.254.0.0/16', reason: 'dup' },
      ];
      expect(loadWithPolicy(policy)).toThrow('legacyIptables.blockedCidrs has duplicate cidr: 169.254.0.0/16');
    });
  });
});
