import { generateSquidConfig } from './squid-config';
import { SquidConfig } from './types';
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
      expect(auditLine).toContain('"timestamp":');
      expect(auditLine).toContain('"event":"http_access"');
      expect(auditLine).toContain('"client":');
      expect(auditLine).toContain('"host":');
      expect(auditLine).toContain('"dest":');
      expect(auditLine).toContain('"method":');
      expect(auditLine).toContain('"status":');
      expect(auditLine).toContain('"decision":');
      expect(auditLine).toContain('"url":');
    });
  });
});
