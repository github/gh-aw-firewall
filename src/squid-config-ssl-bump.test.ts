import { generateSquidConfig } from './squid-config';
import { SquidConfig } from './types';

describe('generateSquidConfig', () => {
  const defaultPort = 3128;

  describe('SSL Bump Mode', () => {
    const sslBumpConfig: SquidConfig = {
      domains: ['github.com'],
      port: defaultPort,
      sslBump: true,
      caFiles: {
        certPath: '/tmp/test/ssl/ca-cert.pem',
        keyPath: '/tmp/test/ssl/ca-key.pem',
      },
      sslDbPath: '/tmp/test/ssl_db',
    };

    it('should add SSL Bump section when sslBump is enabled', () => {
      const result = generateSquidConfig(sslBumpConfig);
      expect(result).toContain('SSL Bump configuration for HTTPS content inspection');
      expect(result).toContain('ssl-bump');
      expect(result).toContain('security_file_certgen');
    });

    it('should include SSL Bump warning comment', () => {
      const result = generateSquidConfig(sslBumpConfig);
      expect(result).toContain('SSL Bump mode enabled');
      expect(result).toContain('HTTPS traffic will be intercepted');
    });

    it('should configure HTTP port with SSL Bump', () => {
      const result = generateSquidConfig(sslBumpConfig);
      expect(result).toContain('http_port 3128 ssl-bump');
    });

    it('should include CA certificate path', () => {
      const result = generateSquidConfig(sslBumpConfig);
      expect(result).toContain('cert=/tmp/test/ssl/ca-cert.pem');
      expect(result).toContain('key=/tmp/test/ssl/ca-key.pem');
    });

    it('should include SSL Bump ACL steps', () => {
      const result = generateSquidConfig(sslBumpConfig);
      expect(result).toContain('acl step1 at_step SslBump1');
      expect(result).toContain('acl step2 at_step SslBump2');
      expect(result).toContain('ssl_bump peek step1');
      expect(result).toContain('ssl_bump stare step2');
    });

    it('should include ssl_bump rules for allowed domains', () => {
      const result = generateSquidConfig(sslBumpConfig);
      expect(result).toContain('ssl_bump bump allowed_domains');
      expect(result).toContain('ssl_bump terminate all');
    });

    it('should include ssl_bump rules for regex patterns only', () => {
      const config: SquidConfig = {
        ...sslBumpConfig,
        domains: ['api-*.example.com'],
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('ssl_bump bump allowed_domains_regex');
      expect(result).toContain('ssl_bump terminate all');
    });

    it('should include ssl_bump rules for both plain domains and regex patterns', () => {
      const config: SquidConfig = {
        ...sslBumpConfig,
        domains: ['github.com', 'api-*.example.com'],
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('ssl_bump bump allowed_domains');
      expect(result).toContain('ssl_bump bump allowed_domains_regex');
      expect(result).toContain('ssl_bump terminate all');
    });

    it('should include URL pattern ACLs when provided', () => {
      // URL patterns passed here are the output of parseUrlPatterns which now uses [^\s]*
      const config: SquidConfig = {
        ...sslBumpConfig,
        urlPatterns: ['^https://github\\.com/myorg/[^\\s]*'],
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_url_0 url_regex');
      expect(result).toContain('^https://github\\.com/myorg/[^\\s]*');
    });

    it('should place URL pattern access rules after Safe_ports deny rules', () => {
      const config: SquidConfig = {
        ...sslBumpConfig,
        urlPatterns: ['^https://github\\.com/myorg/[^\\s]*'],
      };
      const result = generateSquidConfig(config);

      const safePortsDenyPos = result.indexOf('http_access deny CONNECT !Safe_ports');
      const urlAllowPos = result.indexOf('http_access allow allowed_url_0');
      expect(safePortsDenyPos).toBeGreaterThan(-1);
      expect(urlAllowPos).toBeGreaterThan(-1);
      expect(urlAllowPos).toBeGreaterThan(safePortsDenyPos);
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
