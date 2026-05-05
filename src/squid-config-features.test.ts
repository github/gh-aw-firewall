import { generateSquidConfig } from './squid-config';
import { SquidConfig } from './types';
import { DOMAIN_CHAR_PATTERN } from './domain-patterns';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: AWF_VERSION } = require('../package.json') as { version: string };

describe('generateSquidConfig', () => {
  const defaultPort = 3128;

  describe('Logging Configuration', () => {
    it('should include custom firewall_detailed log format', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('logformat firewall_detailed');
    });

    it('should log timestamp with milliseconds', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %ts.%03tu provides timestamp in seconds.milliseconds format
      expect(result).toMatch(/logformat firewall_detailed.*%ts\.%03tu/);
    });

    it('should log client IP and port', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %>a:%>p provides client IP:port
      expect(result).toMatch(/logformat firewall_detailed.*%>a:%>p/);
    });

    it('should log destination domain and IP:port', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %{Host}>h for domain, %<a:%<p for dest IP:port
      expect(result).toMatch(/logformat firewall_detailed.*%{Host}>h.*%<a:%<p/);
    });

    it('should log protocol and HTTP method', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %rv for protocol version, %rm for request method
      expect(result).toMatch(/logformat firewall_detailed.*%rv.*%rm/);
    });

    it('should log HTTP status code', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %>Hs for HTTP status code
      expect(result).toMatch(/logformat firewall_detailed.*%>Hs/);
    });

    it('should log decision (Squid status:hierarchy)', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %Ss:%Sh provides decision like TCP_DENIED:HIER_NONE or TCP_TUNNEL:HIER_DIRECT
      expect(result).toMatch(/logformat firewall_detailed.*%Ss:%Sh/);
    });

    it('should include comment about CONNECT requests for HTTPS', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // For HTTPS/CONNECT requests, domain is in the URL field
      expect(result).toContain('For CONNECT requests (HTTPS), the domain is in the URL field');
    });

    it('should use firewall_detailed format for access_log', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('access_log /var/log/squid/access.log firewall_detailed');
    });

    it('should filter localhost healthcheck probes from logs', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Squid 5+ uses ACL filter on access_log directive instead of deprecated log_access
      expect(result).toContain('acl healthcheck_localhost src 127.0.0.1 ::1');
      expect(result).toContain('access_log /var/log/squid/access.log firewall_detailed !healthcheck_localhost');
      // Ensure deprecated log_access directive is NOT present (removed in Squid 5+)
      expect(result).not.toContain('log_access');
    });

    it('should place healthcheck ACL before access_log directive', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Verify the order: ACL definition comes before access_log that uses it
      const aclIndex = result.indexOf('acl healthcheck_localhost');
      const accessLogIndex = result.indexOf('access_log /var/log/squid/access.log firewall_detailed !healthcheck_localhost');

      expect(aclIndex).toBeGreaterThan(-1);
      expect(accessLogIndex).toBeGreaterThan(aclIndex);
    });

    it('should include JSONL audit log format (audit_jsonl)', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('logformat audit_jsonl');
      expect(result).toContain('access_log /var/log/squid/audit.jsonl audit_jsonl');
    });

    it('audit_jsonl logformat should include versioned _schema field matching the package.json version', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // The audit_jsonl logformat line must embed the exact CLI version so that
      // every emitted record carries the correct schema identifier.
      expect(result).toContain(`"_schema":"audit/v${AWF_VERSION}"`);
    });

    it('audit_jsonl logformat should include all required fields', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Required fields per audit.schema.json
      const auditLine = result.split('\n').find(l => l.startsWith('logformat audit_jsonl'));
      expect(auditLine).toBeDefined();
      expect(auditLine).toContain('"ts":');
      expect(auditLine).toContain('"client":');
      expect(auditLine).toContain('"host":');
      expect(auditLine).toContain('"dest":');
      expect(auditLine).toContain('"method":');
      expect(auditLine).toContain('"status":');
      expect(auditLine).toContain('"decision":');
      expect(auditLine).toContain('"url":');
    });
  });

  describe('Streaming/Long-lived Connection Support', () => {
    it('should include read_timeout for streaming connections', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('read_timeout 30 minutes');
    });

    it('should include connect_timeout', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('connect_timeout 30 seconds');
    });

    it('should include client_lifetime for long sessions', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('client_lifetime 8 hours');
    });

    it('should enable half_closed_clients for SSE streaming', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('half_closed_clients on');
    });

    it('should include request_timeout', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('request_timeout 2 minutes');
    });

    it('should include persistent_request_timeout', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('persistent_request_timeout 2 minutes');
    });

    it('should include pconn_timeout', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('pconn_timeout 2 minutes');
    });

    it('should include shutdown_lifetime 0 for fast shutdown', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('shutdown_lifetime 0 seconds');
    });
  });

  describe('Blocklist Support', () => {
    it('should generate blocked domain ACL for plain domain', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['internal.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains dstdomain .internal.github.com');
      expect(result).toContain('http_access deny blocked_domains');
    });

    it('should generate blocked domain ACL for wildcard pattern', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        blockedDomains: ['*.internal.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains_regex dstdom_regex -i');
      expect(result).toContain(`^${DOMAIN_CHAR_PATTERN}\\.internal\\.example\\.com$`);
      expect(result).toContain('http_access deny blocked_domains_regex');
    });

    it('should handle both plain and wildcard blocked domains', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        blockedDomains: ['internal.example.com', '*.secret.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains dstdomain .internal.example.com');
      expect(result).toContain('acl blocked_domains_regex dstdom_regex -i');
      expect(result).toContain('http_access deny blocked_domains');
      expect(result).toContain('http_access deny blocked_domains_regex');
    });

    it('should place blocked domains deny rule before allowed domains deny rule', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['internal.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      const blockRuleIndex = result.indexOf('http_access deny blocked_domains');
      const allowRuleIndex = result.indexOf('http_access deny !allowed_domains');
      expect(blockRuleIndex).toBeLessThan(allowRuleIndex);
    });

    it('should include blocklist comment section', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['internal.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('# ACL definitions for blocked domains');
      expect(result).toContain('# Deny requests to blocked domains (blocklist takes precedence)');
    });

    it('should work without blocklist (backward compatibility)', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).not.toContain('blocked_domains');
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
    });

    it('should work with empty blocklist', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: [],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).not.toContain('blocked_domains');
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
    });

    it('should normalize blocked domains (remove protocol)', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['https://internal.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains dstdomain .internal.github.com');
      expect(result).not.toContain('https://');
    });

    it('should handle multiple blocked domains', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        blockedDomains: ['internal.example.com', 'secret.example.com', 'admin.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains dstdomain .internal.example.com');
      expect(result).toContain('acl blocked_domains dstdomain .secret.example.com');
      expect(result).toContain('acl blocked_domains dstdomain .admin.example.com');
    });

    it('should throw error for invalid blocked domain pattern', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['*'],
        port: defaultPort,
      };
      expect(() => generateSquidConfig(config)).toThrow();
    });
  });

  describe('SSL Bump Mode', () => {
    it('should add SSL Bump section when sslBump is enabled', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('SSL Bump configuration for HTTPS content inspection');
      expect(result).toContain('ssl-bump');
      expect(result).toContain('security_file_certgen');
    });

    it('should include SSL Bump warning comment', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('SSL Bump mode enabled');
      expect(result).toContain('HTTPS traffic will be intercepted');
    });

    it('should configure HTTP port with SSL Bump', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('http_port 3128 ssl-bump');
    });

    it('should include CA certificate path', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('cert=/tmp/test/ssl/ca-cert.pem');
      expect(result).toContain('key=/tmp/test/ssl/ca-key.pem');
    });

    it('should include SSL Bump ACL steps', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl step1 at_step SslBump1');
      expect(result).toContain('acl step2 at_step SslBump2');
      expect(result).toContain('ssl_bump peek step1');
      expect(result).toContain('ssl_bump stare step2');
    });

    it('should include ssl_bump rules for allowed domains', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('ssl_bump bump allowed_domains');
      expect(result).toContain('ssl_bump terminate all');
    });

    it('should include ssl_bump rules for regex patterns only', () => {
      const config: SquidConfig = {
        domains: ['api-*.example.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('ssl_bump bump allowed_domains_regex');
      expect(result).toContain('ssl_bump terminate all');
    });

    it('should include ssl_bump rules for both plain domains and regex patterns', () => {
      const config: SquidConfig = {
        domains: ['github.com', 'api-*.example.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('ssl_bump bump allowed_domains');
      expect(result).toContain('ssl_bump bump allowed_domains_regex');
      expect(result).toContain('ssl_bump terminate all');
    });

    it('should include URL pattern ACLs when provided', () => {
      // URL patterns passed here are the output of parseUrlPatterns which now uses [^\s]*
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
        urlPatterns: ['^https://github\\.com/myorg/[^\\s]*'],
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_url_0 url_regex');
      expect(result).toContain('^https://github\\.com/myorg/[^\\s]*');
    });

    it('should handle HTTP-only protocol-restricted domains', () => {
      const config: SquidConfig = {
        domains: ['http://legacy-api.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('allowed_http_only');
      expect(result).toContain('!CONNECT');
    });

    it('should handle HTTPS-only protocol-restricted domains', () => {
      const config: SquidConfig = {
        domains: ['https://secure.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('allowed_https_only');
      expect(result).toContain('CONNECT');
    });

    it('should handle mix of HTTP-only plain domains and wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['http://legacy.example.com', 'http://api-*.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Both plain and regex ACLs should be generated for http-only
      expect(result).toContain('allowed_http_only');
      expect(result).toContain('allowed_http_only_regex');
    });

    it('should handle mix of HTTPS-only plain domains and wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['https://secure.example.com', 'https://api-*.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Both plain and regex ACLs should be generated for https-only
      expect(result).toContain('allowed_https_only');
      expect(result).toContain('allowed_https_only_regex');
    });

    it('should not include SSL Bump section when disabled', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: false,
      };
      const result = generateSquidConfig(config);
      expect(result).not.toContain('SSL Bump configuration');
      expect(result).not.toContain('https_port');
      expect(result).not.toContain('ssl-bump');
    });

    it('should use http_port only when SSL Bump is disabled', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('http_port 3128');
      expect(result).not.toContain('https_port');
    });
  });
});

describe('Empty Domain List', () => {
  it('should generate config that denies all traffic when no domains are specified', () => {
    const config = {
      domains: [],
      port: 3128,
    };
    const result = generateSquidConfig(config);
    // Should deny all traffic when no domains are allowed
    expect(result).toContain('http_access deny all');
    // Should have a comment indicating no domains configured
    expect(result).toContain('# No domains configured');
    // Should not have any allowed_domains ACL
    expect(result).not.toContain('acl allowed_domains');
    expect(result).not.toContain('acl allowed_http_only');
    expect(result).not.toContain('acl allowed_https_only');
  });
});

describe('DLP Integration', () => {
  const defaultPort = 3128;

  it('should not include DLP rules when enableDlp is false', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: false,
    };
    const result = generateSquidConfig(config);
    expect(result).not.toContain('dlp_blocked');
    expect(result).not.toContain('DLP');
  });

  it('should not include DLP rules when enableDlp is undefined', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    expect(result).not.toContain('dlp_blocked');
  });

  it('should include DLP ACL and deny rules when enableDlp is true', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);
    // Should have DLP ACL definitions
    expect(result).toContain('acl dlp_blocked url_regex -i');
    // Should have DLP deny rule
    expect(result).toContain('http_access deny dlp_blocked');
    // Should still have normal domain ACLs
    expect(result).toContain('acl allowed_domains dstdomain .github.com');
  });

  it('should place DLP deny rules before domain allow rules', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);

    const dlpDenyIndex = result.indexOf('http_access deny dlp_blocked');
    const domainDenyIndex = result.indexOf('http_access deny !allowed_domains');
    // DLP deny should appear before domain deny
    expect(dlpDenyIndex).toBeGreaterThan(-1);
    expect(domainDenyIndex).toBeGreaterThan(-1);
    expect(dlpDenyIndex).toBeLessThan(domainDenyIndex);
  });

  it('should include credential patterns like ghp_ and AKIA in ACLs', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);
    // Check for a few key patterns
    expect(result).toContain('ghp_');
    expect(result).toContain('AKIA');
    expect(result).toContain('sk-ant-');
  });

  it('should work with DLP and blocked domains together', () => {
    const config = {
      domains: ['github.com'],
      blockedDomains: ['evil.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);
    // Should have both DLP and blocked domain rules
    expect(result).toContain('http_access deny dlp_blocked');
    expect(result).toContain('http_access deny blocked_domains');
    expect(result).toContain('acl dlp_blocked url_regex -i');
  });

  it('should work with DLP and SSL Bump together', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
      sslBump: true,
      caFiles: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
      sslDbPath: '/var/spool/squid_ssl_db',
    };
    const result = generateSquidConfig(config);
    // Should have DLP rules
    expect(result).toContain('http_access deny dlp_blocked');
    // Should have SSL Bump config
    expect(result).toContain('ssl_bump');
  });
});
