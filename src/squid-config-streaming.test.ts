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
});
