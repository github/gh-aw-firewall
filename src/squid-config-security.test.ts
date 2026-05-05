import { generateSquidConfig } from './squid-config';
import { SquidConfig } from './types';

describe('defense-in-depth: rejects injected values', () => {
  const defaultPort = 3128;

  it('should reject newline in domain via validateDomainOrPattern', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['evil.com\nhttp_access allow all'],
        port: defaultPort,
      });
    }).toThrow();
  });

  it('should reject newline in URL pattern', () => {
    // URL patterns go through generateSslBumpSection, which interpolates into squid.conf.
    // The assertSafeForSquidConfig guard should catch this.
    const maliciousPattern = 'https://evil.com/path\nhttp_access allow all';
    expect(() => {
      generateSquidConfig({
        domains: ['evil.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
        sslDbPath: '/tmp/ssl_db',
        urlPatterns: [maliciousPattern],
      });
    }).toThrow(/SECURITY/);
  });

  it('should reject hash character in URL pattern (Squid comment injection)', () => {
    const maliciousPattern = 'https://evil.com/path#http_access allow all';
    expect(() => {
      generateSquidConfig({
        domains: ['evil.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
        sslDbPath: '/tmp/ssl_db',
        urlPatterns: [maliciousPattern],
      });
    }).toThrow(/SECURITY/);
  });

  it('should reject semicolon in URL pattern (Squid token injection)', () => {
    const maliciousPattern = 'https://evil.com/path;injected';
    expect(() => {
      generateSquidConfig({
        domains: ['evil.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
        sslDbPath: '/tmp/ssl_db',
        urlPatterns: [maliciousPattern],
      });
    }).toThrow(/SECURITY/);
  });

  it('should reject space in domain (ACL token injection)', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['.evil.com .attacker.com'],
        port: defaultPort,
      });
    }).toThrow();
  });
});

describe('Direct IP bypass protection', () => {
  const defaultPort = 3128;

  it('should include IPv4 deny ACL in generated config', () => {
    const config: SquidConfig = {
      domains: ['github.com'],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    expect(result).toContain('acl dst_ipv4 dstdom_regex');
    expect(result).toContain('http_access deny dst_ipv4');
  });

  it('should include IPv6 deny ACL in generated config', () => {
    const config: SquidConfig = {
      domains: ['github.com'],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    expect(result).toContain('acl dst_ipv6 dstdom_regex');
    expect(result).toContain('http_access deny dst_ipv6');
  });

  it('should place IP deny rules before domain allow/deny rules', () => {
    const config: SquidConfig = {
      domains: ['github.com'],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    const ipv4DenyPos = result.indexOf('http_access deny dst_ipv4');
    const domainDenyPos = result.indexOf('http_access deny !allowed_domains');
    expect(ipv4DenyPos).toBeGreaterThan(-1);
    expect(domainDenyPos).toBeGreaterThan(-1);
    expect(ipv4DenyPos).toBeLessThan(domainDenyPos);
  });

  it('should include IP deny rules even with no domains configured', () => {
    const config: SquidConfig = {
      domains: [],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    expect(result).toContain('http_access deny dst_ipv4');
    expect(result).toContain('http_access deny dst_ipv6');
  });

  it('should include IP deny rules in SSL Bump mode', () => {
    const config: SquidConfig = {
      domains: ['github.com'],
      port: defaultPort,
      sslBump: true,
      caFiles: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
      sslDbPath: '/tmp/ssl_db',
    };
    const result = generateSquidConfig(config);
    expect(result).toContain('http_access deny dst_ipv4');
    expect(result).toContain('http_access deny dst_ipv6');
  });
});

describe('Port validation in generateSquidConfig', () => {
  it('should accept valid single ports', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000,8080,9000',
      });
    }).not.toThrow();
  });

  it('should accept valid port ranges', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000-3010,7000-7090',
      });
    }).not.toThrow();
  });

  it('should reject invalid port numbers', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '70000',
      });
    }).toThrow('Invalid port: 70000');
  });

  it('should reject negative ports', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '-1',
      });
    }).toThrow('Invalid port: -1');
  });

  it('should reject non-numeric ports', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: 'abc',
      });
    }).toThrow('Invalid port: abc');
  });

  it('should reject invalid port ranges', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000-2000',
      });
    }).toThrow('Invalid port range: 3000-2000');
  });

  it('should reject port ranges with invalid boundaries', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000-70000',
      });
    }).toThrow('Invalid port range: 3000-70000');
  });
});

describe('Dangerous ports blocklist in generateSquidConfig', () => {
  it('should reject SSH port 22', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '22',
      });
    }).toThrow('Port 22 is blocked for security reasons');
  });

  it('should reject MySQL port 3306', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3306',
      });
    }).toThrow('Port 3306 is blocked for security reasons');
  });

  it('should reject PostgreSQL port 5432', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '5432',
      });
    }).toThrow('Port 5432 is blocked for security reasons');
  });

  it('should reject Redis port 6379', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '6379',
      });
    }).toThrow('Port 6379 is blocked for security reasons');
  });

  it('should reject MongoDB port 27017', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '27017',
      });
    }).toThrow('Port 27017 is blocked for security reasons');
  });

  it('should reject CouchDB port 5984', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '5984',
      });
    }).toThrow('Port 5984 is blocked for security reasons');
  });

  it('should reject CouchDB SSL port 6984', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '6984',
      });
    }).toThrow('Port 6984 is blocked for security reasons');
  });

  it('should reject Elasticsearch HTTP port 9200', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '9200',
      });
    }).toThrow('Port 9200 is blocked for security reasons');
  });

  it('should reject Elasticsearch transport port 9300', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '9300',
      });
    }).toThrow('Port 9300 is blocked for security reasons');
  });

  it('should reject InfluxDB HTTP port 8086', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '8086',
      });
    }).toThrow('Port 8086 is blocked for security reasons');
  });

  it('should reject InfluxDB RPC port 8088', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '8088',
      });
    }).toThrow('Port 8088 is blocked for security reasons');
  });

  it('should reject port range containing SSH (20-25)', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '20-25',
      });
    }).toThrow('Port range 20-25 includes dangerous port 22');
  });

  it('should reject port range containing MySQL (3300-3310)', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3300-3310',
      });
    }).toThrow('Port range 3300-3310 includes dangerous port 3306');
  });

  it('should reject port range containing PostgreSQL (5400-5500)', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '5400-5500',
      });
    }).toThrow('Port range 5400-5500 includes dangerous port 5432');
  });

  it('should reject port range containing InfluxDB (8080-8090)', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '8080-8090',
      });
    }).toThrow('Port range 8080-8090 includes dangerous port 8086');
  });

  it('should reject multiple ports including a dangerous one', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000,3306,8080',
      });
    }).toThrow('Port 3306 is blocked for security reasons');
  });

  it('should accept safe ports not in blocklist', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000,8080,9000',
      });
    }).not.toThrow();
  });

  it('should accept safe port range not overlapping with dangerous ports', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '7000-7100',
      });
    }).not.toThrow();
  });
});
