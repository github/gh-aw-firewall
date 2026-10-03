import { generateSquidConfig } from './squid-config';
import { SquidConfig } from './types';

describe('generateSquidConfig', () => {
  const defaultPort = 3128;

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

    it.each([
      {},
      {
        sslBump: true,
        caFiles: { certPath: '/cert.pem', keyPath: '/key.pem' },
        sslDbPath: '/var/spool/squid_ssl_db',
      },
      { apiProxyIp: '172.30.0.30', apiProxyPorts: [10001] },
    ])('should disable half_closed_clients to safely handle EOF before ClientHello (%j)', (options) => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
        ...options,
      };
      const result = generateSquidConfig(config);
      expect(result).toMatch(/^half_closed_clients off$/m);
      expect(result).not.toMatch(/^half_closed_clients on$/m);
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
});
