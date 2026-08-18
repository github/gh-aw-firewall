import { parseDifcProxyHost, stripScheme, hostEnvTestHelpers } from './host-env';

const { subnetsOverlap } = hostEnvTestHelpers;

describe('stripScheme', () => {
  it('returns empty string for empty input', () => {
    expect(stripScheme('')).toBe('');
    expect(stripScheme('   ')).toBe('   '.trim());
  });

  it('strips https scheme and path', () => {
    expect(stripScheme('https://api.openai.com/v1/foo')).toBe('api.openai.com');
  });

  it('adds scheme when missing and extracts hostname', () => {
    expect(stripScheme('api.openai.com')).toBe('api.openai.com');
  });

  it('discards credentials and port', () => {
    expect(stripScheme('https://user:pass@example.com:8443/path')).toBe('example.com');
  });

  it('falls back to trimmed value on invalid URL', () => {
    // A value that still fails URL parsing even with https:// prefix
    expect(stripScheme('http://')).toBe('http://');
  });
});

describe('parseDifcProxyHost', () => {
  it('returns default host/port for empty value', () => {
    expect(parseDifcProxyHost('')).toEqual({ host: 'host.docker.internal', port: '18443' });
    expect(parseDifcProxyHost('   ')).toEqual({ host: 'host.docker.internal', port: '18443' });
  });

  it('parses plain host:port', () => {
    expect(parseDifcProxyHost('example.com:9000')).toEqual({ host: 'example.com', port: '9000' });
  });

  it('parses IPv6 bracketed notation', () => {
    expect(parseDifcProxyHost('[::1]:18443')).toEqual({ host: '::1', port: '18443' });
  });

  it('strips scheme prefix before parsing', () => {
    expect(parseDifcProxyHost('tcp://myhost:1234')).toEqual({ host: 'myhost', port: '1234' });
  });

  it('defaults port to 18443 when not provided', () => {
    expect(parseDifcProxyHost('myhost')).toEqual({ host: 'myhost', port: '18443' });
  });

  it('throws on invalid URL', () => {
    expect(() => parseDifcProxyHost('http://[invalid')).toThrow(/Invalid --difc-proxy-host value/);
  });

  it('throws on non-numeric port (invalid URL)', () => {
    expect(() => parseDifcProxyHost('host:abc')).toThrow(/Expected host:port format/);
  });

  it('throws when port is out of range (too low)', () => {
    expect(() => parseDifcProxyHost('host:0')).toThrow(/Must be between 1 and 65535/);
  });

  it('throws when port is out of range (too high, valid URL parse)', () => {
    expect(() => parseDifcProxyHost('host:99999')).toThrow(/Must be between 1 and 65535|Expected host:port format/);
  });
});

describe('subnetsOverlap (internal helper)', () => {
  it('returns true for identical subnets', () => {
    expect(subnetsOverlap('172.17.0.0/16', '172.17.0.0/16')).toBe(true);
  });

  it('returns true for overlapping subnets', () => {
    expect(subnetsOverlap('172.17.0.0/16', '172.17.1.0/24')).toBe(true);
  });

  it('returns false for non-overlapping subnets', () => {
    expect(subnetsOverlap('172.17.0.0/16', '172.18.0.0/16')).toBe(false);
  });

  it('returns false for adjacent but distinct subnets', () => {
    expect(subnetsOverlap('10.0.0.0/24', '10.0.1.0/24')).toBe(false);
  });
});
