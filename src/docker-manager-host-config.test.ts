import { parseDifcProxyHost } from './host-env';

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('docker-manager host config utilities', () => {
  describe('parseDifcProxyHost', () => {
    it('should return default host and port for empty string', () => {
      expect(parseDifcProxyHost('')).toEqual({ host: 'host.docker.internal', port: '18443' });
    });

    it('should return default host and port for whitespace-only string', () => {
      expect(parseDifcProxyHost('   ')).toEqual({ host: 'host.docker.internal', port: '18443' });
    });

    it('should parse bare host:port', () => {
      expect(parseDifcProxyHost('my-gateway.internal:8443')).toEqual({ host: 'my-gateway.internal', port: '8443' });
    });

    it('should parse host with default port when no port given', () => {
      expect(parseDifcProxyHost('my-gateway.internal')).toEqual({ host: 'my-gateway.internal', port: '18443' });
    });

    it('should strip scheme prefix and parse host:port', () => {
      expect(parseDifcProxyHost('tcp://my-gateway.internal:9000')).toEqual({ host: 'my-gateway.internal', port: '9000' });
    });

    it('should parse https scheme with host:port', () => {
      expect(parseDifcProxyHost('https://proxy.internal:443')).toEqual({ host: 'proxy.internal', port: '443' });
    });

    it('should parse IPv6 bracketed notation', () => {
      expect(parseDifcProxyHost('[::1]:18443')).toEqual({ host: '::1', port: '18443' });
    });

    it('should throw for invalid host:port format', () => {
      expect(() => parseDifcProxyHost('not a valid:::host')).toThrow(/Invalid --difc-proxy-host/);
    });

    it('should throw for port out of range (too high)', () => {
      // Port 99999 causes URL parsing to fail (WHATWG URL spec: max port is 65535)
      expect(() => parseDifcProxyHost('host.internal:99999')).toThrow(/Invalid --difc-proxy-host/);
    });

    it('should throw for port 0', () => {
      // Port 0 parses as valid URL but fails the portNum < 1 check
      expect(() => parseDifcProxyHost('host.internal:0')).toThrow(/Invalid --difc-proxy-host port: 0/);
    });

    it('should parse port 1 (minimum valid port)', () => {
      expect(parseDifcProxyHost('host.internal:1')).toEqual({ host: 'host.internal', port: '1' });
    });

    it('should parse port 65535 (maximum valid port)', () => {
      expect(parseDifcProxyHost('host.internal:65535')).toEqual({ host: 'host.internal', port: '65535' });
    });
  });
});
