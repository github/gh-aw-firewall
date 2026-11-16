import * as fs from 'fs';
import * as path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import { generateSquidConfig } from './squid-config';
import { parseAuditJsonlLine } from './logs/log-parser';
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

    it('excludes sensitive domains from both access log formats', () => {
      const result = generateSquidConfig({
        domains: ['example.com', 'https://lb.secret.example.com'],
        sensitiveDomains: ['https://lb.secret.example.com'],
        port: defaultPort,
      });
      expect(result).toContain('acl sensitive_log_domains dstdomain .lb.secret.example.com');
      expect(result).toContain(
        'access_log /var/log/squid/access.log firewall_detailed !healthcheck_localhost !sensitive_log_domains'
      );
      expect(result).toContain(
        'access_log /var/log/squid/audit.jsonl audit_jsonl !healthcheck_localhost !sensitive_log_domains'
      );
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

    it('audit_jsonl logformat renders records that satisfy audit.schema.json and the audit parser', () => {
      const result = generateSquidConfig({
        domains: ['example.com'],
        port: defaultPort,
      });
      const auditLine = result.split('\n').find(l => l.startsWith('logformat audit_jsonl'));
      expect(auditLine).toBeDefined();
      const template = (auditLine ?? '').replace(/^logformat audit_jsonl\s+/, '');

      // Squid is not available in unit tests, so each format code is replaced with a fixed
      // sample value. Longest tokens are matched first so `%{Host}>h` is not split.
      const render = (values: Map<string, string>): string =>
        template.replace(
          /%\{%Y-%m-%dT%H:%M:%S\}tg\.%03tu|%<a:%<p|%\{Host\}>h|%>a|%rm|%>Hs|%Ss|%ru/g,
          token => {
            const value = values.get(token);
            if (value === undefined) throw new Error(`unexpected format code ${token}`);
            return value;
          }
        );

      const allowed = render(new Map([
        ['%{%Y-%m-%dT%H:%M:%S}tg.%03tu', '2026-05-25T09:00:00.000'],
        ['%>a', '172.30.0.20'],
        ['%{Host}>h', 'api.github.com:443'],
        ['%<a:%<p', '140.82.114.22:443'],
        ['%rm', 'CONNECT'],
        ['%>Hs', '200'],
        ['%Ss', 'TCP_TUNNEL'],
        ['%ru', 'api.github.com:443'],
      ]));
      const denied = render(new Map([
        ['%{%Y-%m-%dT%H:%M:%S}tg.%03tu', '2026-05-25T09:00:01.000'],
        ['%>a', '172.30.0.20'],
        ['%{Host}>h', 'example.com:443'],
        ['%<a:%<p', '-:-'],
        ['%rm', 'CONNECT'],
        ['%>Hs', '403'],
        ['%Ss', 'TCP_DENIED'],
        ['%ru', 'example.com:443'],
      ]));

      const schema = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'schemas', 'audit.schema.json'), 'utf8')
      ) as object;
      const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
      const validate = ajv.compile(schema);

      // Schema validation catches type drift such as a quoted numeric status.
      const allowedRecord: unknown = JSON.parse(allowed);
      const deniedRecord: unknown = JSON.parse(denied);
      expect(validate(allowedRecord)).toBe(true);
      expect(validate(deniedRecord)).toBe(true);
      expect(allowedRecord).toMatchObject({
        _schema: `audit/v${AWF_VERSION}`,
        timestamp: '2026-05-25T09:00:00.000Z',
        status: 200,
        decision: 'TCP_TUNNEL',
      });

      const allowedEntry = parseAuditJsonlLine(allowed);
      expect(allowedEntry).toMatchObject({
        timestamp: Date.parse('2026-05-25T09:00:00.000Z') / 1000,
        clientIp: '172.30.0.20',
        domain: 'api.github.com',
        destIp: '140.82.114.22',
        destPort: '443',
        method: 'CONNECT',
        statusCode: 200,
        decision: 'TCP_TUNNEL',
        isAllowed: true,
        isHttps: true,
      });

      const deniedEntry = parseAuditJsonlLine(denied);
      expect(deniedEntry).toMatchObject({
        domain: 'example.com',
        statusCode: 403,
        decision: 'TCP_DENIED',
        isAllowed: false,
      });
    });
  });
});
