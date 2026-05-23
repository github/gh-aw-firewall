import { validateAndSanitizeHostAccessPort, validateApiProxyIp, validateApiProxyPort } from './validation';

describe('squid validation helpers', () => {
  describe('validateApiProxyIp', () => {
    it('accepts valid IPv4 addresses', () => {
      expect(() => validateApiProxyIp('172.30.0.30')).not.toThrow();
    });

    it('rejects invalid IPv4 octets', () => {
      expect(() => validateApiProxyIp('999.30.0.30')).toThrow(/SECURITY/);
    });
  });

  describe('validateAndSanitizeHostAccessPort', () => {
    it('trims surrounding whitespace for valid ports', () => {
      expect(validateAndSanitizeHostAccessPort(' 3000 ')).toBe('3000');
    });

    it('preserves valid port ranges', () => {
      expect(validateAndSanitizeHostAccessPort('3000-3010')).toBe('3000-3010');
    });

    it('rejects mixed-character input that could parse inconsistently', () => {
      expect(() => validateAndSanitizeHostAccessPort('2\n2')).toThrow('Invalid port: 2\n2. Must be a number between 1 and 65535');
    });

    it('rejects dangerous ports', () => {
      expect(() => validateAndSanitizeHostAccessPort('22')).toThrow('Port 22 is blocked for security reasons');
    });
  });

  describe('validateApiProxyPort', () => {
    it('accepts safe integer ports', () => {
      expect(() => validateApiProxyPort(10000)).not.toThrow();
    });

    it('rejects dangerous api-proxy ports', () => {
      expect(() => validateApiProxyPort(22)).toThrow('Api-proxy port 22 is blocked for security reasons');
    });
  });
});
