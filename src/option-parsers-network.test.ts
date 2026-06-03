import {
  parseDnsServers,
  parseDnsOverHttps,
  processLocalhostKeyword,
  validateAllowHostPorts,
  applyHostServicePortsConfig,
} from './option-parsers';

describe('DNS servers parsing', () => {
  it('should parse valid IPv4 DNS servers', () => {
    const result = parseDnsServers('8.8.8.8,8.8.4.4');
    expect(result).toEqual(['8.8.8.8', '8.8.4.4']);
  });

  it('should parse single DNS server', () => {
    const result = parseDnsServers('1.1.1.1');
    expect(result).toEqual(['1.1.1.1']);
  });

  it('should parse mixed IPv4 and IPv6 DNS servers', () => {
    const result = parseDnsServers('8.8.8.8,2001:4860:4860::8888');
    expect(result).toEqual(['8.8.8.8', '2001:4860:4860::8888']);
  });

  it('should trim whitespace from DNS servers', () => {
    const result = parseDnsServers('  8.8.8.8  ,  1.1.1.1  ');
    expect(result).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('should filter empty entries', () => {
    const result = parseDnsServers('8.8.8.8,,1.1.1.1,');
    expect(result).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('should throw error for invalid IP address', () => {
    expect(() => parseDnsServers('invalid.dns.server')).toThrow('Invalid DNS server IP address');
  });

  it('should throw error for empty input', () => {
    expect(() => parseDnsServers('')).toThrow('At least one DNS server must be specified');
  });

  it('should throw error for whitespace-only input', () => {
    expect(() => parseDnsServers('  ,  ,  ')).toThrow('At least one DNS server must be specified');
  });

  it('should throw error if any server is invalid', () => {
    expect(() => parseDnsServers('8.8.8.8,invalid,1.1.1.1')).toThrow('Invalid DNS server IP address: invalid');
  });
});

describe('parseDnsOverHttps', () => {
  it('should return undefined when value is undefined', () => {
    expect(parseDnsOverHttps(undefined)).toBeUndefined();
  });

  it('should return default Google resolver when value is true (flag without argument)', () => {
    const result = parseDnsOverHttps(true);
    expect(result).toEqual({ url: 'https://dns.google/dns-query' });
  });

  it('should return custom resolver URL when provided', () => {
    const result = parseDnsOverHttps('https://cloudflare-dns.com/dns-query');
    expect(result).toEqual({ url: 'https://cloudflare-dns.com/dns-query' });
  });

  it('should return error for non-https URL', () => {
    const result = parseDnsOverHttps('http://dns.google/dns-query');
    expect(result).toEqual({ error: '--dns-over-https resolver URL must start with https://' });
  });

  it('should return error for plain string without https prefix', () => {
    const result = parseDnsOverHttps('dns.google');
    expect(result).toEqual({ error: '--dns-over-https resolver URL must start with https://' });
  });
});

describe('processLocalhostKeyword', () => {
  describe('when localhost keyword is not present', () => {
    it('should return domains unchanged', () => {
      const result = processLocalhostKeyword(
        ['github.com', 'example.com'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(false);
      expect(result.allowedDomains).toEqual(['github.com', 'example.com']);
      expect(result.shouldEnableHostAccess).toBe(false);
      expect(result.defaultPorts).toBeUndefined();
    });
  });

  describe('when plain localhost is present', () => {
    it('should replace localhost with host.docker.internal', () => {
      const result = processLocalhostKeyword(
        ['localhost', 'github.com'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['github.com', 'host.docker.internal']);
      expect(result.shouldEnableHostAccess).toBe(true);
      expect(result.defaultPorts).toBe('3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090');
    });

    it('should replace localhost when it is the only domain', () => {
      const result = processLocalhostKeyword(
        ['localhost'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['host.docker.internal']);
      expect(result.shouldEnableHostAccess).toBe(true);
    });
  });

  describe('when http://localhost is present', () => {
    it('should replace with http://host.docker.internal', () => {
      const result = processLocalhostKeyword(
        ['http://localhost', 'github.com'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['github.com', 'http://host.docker.internal']);
      expect(result.shouldEnableHostAccess).toBe(true);
      expect(result.defaultPorts).toBe('3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090');
    });
  });

  describe('when https://localhost is present', () => {
    it('should replace with https://host.docker.internal', () => {
      const result = processLocalhostKeyword(
        ['https://localhost', 'github.com'],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['github.com', 'https://host.docker.internal']);
      expect(result.shouldEnableHostAccess).toBe(true);
      expect(result.defaultPorts).toBe('3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090');
    });
  });

  describe('when host access is already enabled', () => {
    it('should not suggest enabling host access again', () => {
      const result = processLocalhostKeyword(
        ['localhost', 'github.com'],
        true, // Already enabled
        undefined
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.shouldEnableHostAccess).toBe(false);
      expect(result.defaultPorts).toBe('3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090');
    });
  });

  describe('when custom ports are already specified', () => {
    it('should not suggest default ports', () => {
      const result = processLocalhostKeyword(
        ['localhost', 'github.com'],
        false,
        '8080,9000' // Custom ports
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.shouldEnableHostAccess).toBe(true);
      expect(result.defaultPorts).toBeUndefined();
    });
  });

  describe('when both host access and custom ports are specified', () => {
    it('should not suggest either', () => {
      const result = processLocalhostKeyword(
        ['localhost', 'github.com'],
        true, // Already enabled
        '8080' // Custom ports
      );

      expect(result.localhostDetected).toBe(true);
      expect(result.shouldEnableHostAccess).toBe(false);
      expect(result.defaultPorts).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should only replace first occurrence of localhost', () => {
      // Although unlikely, the function should handle this gracefully
      const result = processLocalhostKeyword(
        ['localhost', 'github.com', 'http://localhost'],
        false,
        undefined
      );

      // Should only replace the first match
      expect(result.localhostDetected).toBe(true);
      expect(result.allowedDomains).toEqual(['github.com', 'http://localhost', 'host.docker.internal']);
    });

    it('should preserve domain order', () => {
      const result = processLocalhostKeyword(
        ['github.com', 'localhost', 'example.com'],
        false,
        undefined
      );

      expect(result.allowedDomains).toEqual(['github.com', 'example.com', 'host.docker.internal']);
    });

    it('should handle empty domains list', () => {
      const result = processLocalhostKeyword(
        [],
        false,
        undefined
      );

      expect(result.localhostDetected).toBe(false);
      expect(result.allowedDomains).toEqual([]);
    });
  });
});
describe('validateAllowHostPorts', () => {
  it('should fail when --allow-host-ports is used without --enable-host-access', () => {
    const result = validateAllowHostPorts('3000', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--allow-host-ports requires --enable-host-access');
  });

  it('should fail when --allow-host-ports is used with enableHostAccess=false', () => {
    const result = validateAllowHostPorts('8080', false);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--allow-host-ports requires --enable-host-access');
  });

  it('should pass when --allow-host-ports is used with --enable-host-access', () => {
    const result = validateAllowHostPorts('3000', true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should pass when --allow-host-ports is not provided', () => {
    const result = validateAllowHostPorts(undefined, undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should pass when only --enable-host-access is set without ports', () => {
    const result = validateAllowHostPorts(undefined, true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should fail for port ranges without --enable-host-access', () => {
    const result = validateAllowHostPorts('3000-3010,8080', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--allow-host-ports requires --enable-host-access');
  });

  it('should pass for port ranges with --enable-host-access', () => {
    const result = validateAllowHostPorts('3000-3010,8000-8090', true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('allow host service ports validation (via public parser entrypoint)', () => {
  let mockLog: { warn: jest.Mock; info: jest.Mock };

  beforeEach(() => {
    mockLog = { warn: jest.fn(), info: jest.fn() };
  });

  it('should pass when no service ports are provided', () => {
    const result = applyHostServicePortsConfig(undefined, undefined, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBeUndefined();
    }
  });

  it('should pass for valid single port', () => {
    const result = applyHostServicePortsConfig('5432', undefined, mockLog);
    expect(result.valid).toBe(true);
  });

  it('should pass for valid multiple ports', () => {
    const result = applyHostServicePortsConfig('5432,6379,3306', undefined, mockLog);
    expect(result.valid).toBe(true);
  });

  it('should auto-enable host access when not already enabled', () => {
    const result = applyHostServicePortsConfig('5432', undefined, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBe(true);
    }
  });

  it('should auto-enable host access when enableHostAccess is false', () => {
    const result = applyHostServicePortsConfig('5432', false, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBe(true);
    }
  });

  it('should not auto-enable host access when already enabled', () => {
    const result = applyHostServicePortsConfig('5432', true, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBe(true);
    }
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('automatically enabling host access')
    );
  });

  it('should fail for non-numeric port', () => {
    const result = applyHostServicePortsConfig('abc', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Invalid port');
      expect(result.error).toContain('Must be a numeric value');
    }
  });

  it('should fail for port with letters mixed in', () => {
    const result = applyHostServicePortsConfig('54a32', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Must be a numeric value');
    }
  });

  it('should fail for port 0', () => {
    const result = applyHostServicePortsConfig('0', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Must be a number between 1 and 65535');
    }
  });

  it('should fail for port above 65535', () => {
    const result = applyHostServicePortsConfig('65536', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Must be a number between 1 and 65535');
    }
  });

  it('should fail if any port in comma-separated list is invalid', () => {
    const result = applyHostServicePortsConfig('5432,abc,6379', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('abc');
    }
  });

  it('should allow dangerous ports (by design, for host-local services)', () => {
    // Ports like 22 (SSH), 25 (SMTP), 5432 (Postgres), 6379 (Redis) are allowed
    // because they are restricted to host gateway only
    const result = applyHostServicePortsConfig('22,25,5432,6379,27017', undefined, mockLog);
    expect(result.valid).toBe(true);
  });

  it('should handle ports with whitespace around them', () => {
    const result = applyHostServicePortsConfig(' 5432 , 6379 ', undefined, mockLog);
    expect(result.valid).toBe(true);
  });

  it('should pass for port 1 (minimum valid)', () => {
    const result = applyHostServicePortsConfig('1', undefined, mockLog);
    expect(result.valid).toBe(true);
  });

  it('should pass for port 65535 (maximum valid)', () => {
    const result = applyHostServicePortsConfig('65535', undefined, mockLog);
    expect(result.valid).toBe(true);
  });

  it('should fail for negative port number', () => {
    const result = applyHostServicePortsConfig('-1', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Must be a numeric value');
    }
  });

  it('should fail for decimal port number', () => {
    const result = applyHostServicePortsConfig('80.5', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Must be a numeric value');
    }
  });
});

describe('applyHostServicePortsConfig', () => {
  let warnings: string[];
  let infos: string[];
  let mockLog: { warn: (msg: string) => void; info: (msg: string) => void };

  beforeEach(() => {
    warnings = [];
    infos = [];
    mockLog = {
      warn: (msg: string) => warnings.push(msg),
      info: (msg: string) => infos.push(msg),
    };
  });

  it('should return valid with no changes when no service ports provided', () => {
    const result = applyHostServicePortsConfig(undefined, undefined, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBeUndefined();
    }
    expect(warnings).toHaveLength(0);
    expect(infos).toHaveLength(0);
  });

  it('should return error for invalid port', () => {
    const result = applyHostServicePortsConfig('abc', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Invalid port');
    }
  });

  it('should auto-enable host access and emit warnings when ports provided without host access', () => {
    const result = applyHostServicePortsConfig('5432,6379', undefined, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBe(true);
    }
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('bypasses dangerous port restrictions');
    expect(warnings[1]).toContain('Ensure host services');
    expect(warnings[2]).toContain('automatically enabling host access');
    expect(warnings[2]).toContain('80/443');
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('5432,6379');
  });

  it('should not auto-enable host access when already enabled', () => {
    const result = applyHostServicePortsConfig('5432', true, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBe(true);
    }
    // Should still warn but not log auto-enable message
    expect(warnings).toHaveLength(2);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('5432');
  });

  it('should auto-enable host access when enableHostAccess is false', () => {
    const result = applyHostServicePortsConfig('3306', false, mockLog);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.enableHostAccess).toBe(true);
    }
    expect(warnings.some(m => m.includes('automatically enabling'))).toBe(true);
  });

  it('should return error for out-of-range port', () => {
    const result = applyHostServicePortsConfig('70000', undefined, mockLog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Must be a number between 1 and 65535');
    }
  });
});
