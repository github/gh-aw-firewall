import { validateAndSanitizeHostAccessPort, validateApiProxyIp, validateApiProxyPort } from './validation';

describe('validateApiProxyIp', () => {
  it('passes when apiProxyIp is undefined', () => {
    expect(() => validateApiProxyIp(undefined)).not.toThrow();
  });

  it('passes for valid IPv4 addresses', () => {
    expect(() => validateApiProxyIp('172.30.0.30')).not.toThrow();
    expect(() => validateApiProxyIp('10.0.0.1')).not.toThrow();
    expect(() => validateApiProxyIp('255.255.255.255')).not.toThrow();
    expect(() => validateApiProxyIp('0.0.0.0')).not.toThrow();
  });

  it('throws SECURITY error for empty string', () => {
    expect(() => validateApiProxyIp('')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for hostname (non-IP)', () => {
    expect(() => validateApiProxyIp('proxy.corp.com')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for IPv6 address', () => {
    expect(() => validateApiProxyIp('::1')).toThrow(/SECURITY/);
    expect(() => validateApiProxyIp('2001:db8::1')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for out-of-range octet', () => {
    expect(() => validateApiProxyIp('256.0.0.1')).toThrow(/SECURITY/);
    expect(() => validateApiProxyIp('192.168.1.300')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for partial IP address', () => {
    expect(() => validateApiProxyIp('192.168.1')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for IP with trailing dot', () => {
    expect(() => validateApiProxyIp('192.168.1.1.')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for IP with newline injection', () => {
    expect(() => validateApiProxyIp('172.30.0.30\nevil')).toThrow(/SECURITY/);
  });
});

describe('validateAndSanitizeHostAccessPort', () => {
  it('returns trimmed port number for valid port', () => {
    expect(validateAndSanitizeHostAccessPort('8080')).toBe('8080');
    expect(validateAndSanitizeHostAccessPort(' 8080 ')).toBe('8080');
  });

  it('returns port range for valid range', () => {
    expect(validateAndSanitizeHostAccessPort('9000-9100')).toBe('9000-9100');
  });

  it('allows safe non-dangerous ports', () => {
    expect(validateAndSanitizeHostAccessPort('9000')).toBe('9000');
    expect(validateAndSanitizeHostAccessPort('443')).toBe('443');
    expect(validateAndSanitizeHostAccessPort('8443')).toBe('8443');
  });

  it('throws for non-numeric input', () => {
    expect(() => validateAndSanitizeHostAccessPort('abc')).toThrow(/Invalid port/);
  });

  it('rejects mixed-character input with newline (injection guard)', () => {
    expect(() => validateAndSanitizeHostAccessPort('2\n2')).toThrow('Invalid port: 2\n2. Must be a number between 1 and 65535');
  });

  it('throws for empty string', () => {
    expect(() => validateAndSanitizeHostAccessPort('')).toThrow(/Invalid port/);
  });

  it('throws for port 0 (below minimum)', () => {
    expect(() => validateAndSanitizeHostAccessPort('0')).toThrow(/Invalid port/);
  });

  it('throws for port above 65535', () => {
    expect(() => validateAndSanitizeHostAccessPort('65536')).toThrow(/Invalid port/);
  });

  it('throws for dangerous port 22 (SSH)', () => {
    expect(() => validateAndSanitizeHostAccessPort('22')).toThrow(/dangerous port/i);
  });

  it('throws for dangerous port 3306 (MySQL)', () => {
    expect(() => validateAndSanitizeHostAccessPort('3306')).toThrow(/dangerous port/i);
  });

  it('throws for port range that includes dangerous SSH port', () => {
    expect(() => validateAndSanitizeHostAccessPort('20-25')).toThrow(/dangerous port/i);
  });

  it('throws for invalid range where start > end', () => {
    expect(() => validateAndSanitizeHostAccessPort('9000-8000')).toThrow(/Invalid port range/i);
  });

  it('throws for port range with start below minimum', () => {
    expect(() => validateAndSanitizeHostAccessPort('0-8080')).toThrow(/Invalid port range/i);
  });
});

describe('validateApiProxyPort', () => {
  it('passes for valid port numbers', () => {
    expect(() => validateApiProxyPort(8080)).not.toThrow();
    expect(() => validateApiProxyPort(1)).not.toThrow();
    expect(() => validateApiProxyPort(65535)).not.toThrow();
    expect(() => validateApiProxyPort(9000)).not.toThrow();
  });

  it('throws for non-integer (float)', () => {
    expect(() => validateApiProxyPort(8080.5)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for port 0', () => {
    expect(() => validateApiProxyPort(0)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for port above 65535', () => {
    expect(() => validateApiProxyPort(65536)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for negative port', () => {
    expect(() => validateApiProxyPort(-1)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for NaN', () => {
    expect(() => validateApiProxyPort(NaN)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for dangerous port 22 (SSH)', () => {
    expect(() => validateApiProxyPort(22)).toThrow(/dangerous port/i);
  });

  it('throws for dangerous port 5432 (PostgreSQL)', () => {
    expect(() => validateApiProxyPort(5432)).toThrow(/dangerous port/i);
  });
});
