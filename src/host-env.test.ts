// Tests for host-env.ts pure helper functions: subnetsOverlap (internal),
// stripScheme, and parseDifcProxyHost. These are re-exported (in part) via
// the docker-manager.ts barrel module.

import { stripScheme, parseDifcProxyHost, hostEnvTestHelpers } from './host-env';

describe('hostEnvTestHelpers.subnetsOverlap', () => {
  const { subnetsOverlap } = hostEnvTestHelpers;

  it('returns true for identical subnets', () => {
    expect(subnetsOverlap('172.17.0.0/16', '172.17.0.0/16')).toBe(true);
  });

  it('returns true for overlapping subnets with different masks', () => {
    expect(subnetsOverlap('172.17.0.0/16', '172.17.5.0/24')).toBe(true);
  });

  it('returns false for non-overlapping subnets', () => {
    expect(subnetsOverlap('172.17.0.0/16', '172.18.0.0/16')).toBe(false);
  });

  it('returns false for adjacent but disjoint subnets', () => {
    expect(subnetsOverlap('10.0.0.0/24', '10.0.1.0/24')).toBe(false);
  });

  it('returns true for a subnet fully contained in another', () => {
    expect(subnetsOverlap('192.168.0.0/16', '192.168.100.0/24')).toBe(true);
  });
});

describe('stripScheme', () => {
  it('returns empty string for empty input', () => {
    expect(stripScheme('')).toBe('');
  });

  it('returns trimmed empty string for whitespace-only input', () => {
    expect(stripScheme('   ')).toBe('');
  });

  it('strips https scheme and path from a URL', () => {
    expect(stripScheme('https://api.openai.com/v1/foo')).toBe('api.openai.com');
  });

  it('adds implicit scheme for bare hostnames', () => {
    expect(stripScheme('api.openai.com')).toBe('api.openai.com');
  });

  it('strips query and fragment', () => {
    expect(stripScheme('https://example.com/path?x=1#frag')).toBe('example.com');
  });

  it('strips credentials and port', () => {
    expect(stripScheme('https://user:pass@example.com:8443/path')).toBe('example.com');
  });

  it('trims surrounding whitespace before processing', () => {
    expect(stripScheme('  api.openai.com  ')).toBe('api.openai.com');
  });

  it('falls back to trimmed input when URL parsing fails', () => {
    // A value that looks like it has a scheme but is not a parseable URL.
    expect(stripScheme('http://')).toBe('http://');
  });
});

describe('parseDifcProxyHost', () => {
  it('returns default host/port for empty input', () => {
    expect(parseDifcProxyHost('')).toEqual({ host: 'host.docker.internal', port: '18443' });
  });

  it('returns default host/port for whitespace-only input', () => {
    expect(parseDifcProxyHost('   ')).toEqual({ host: 'host.docker.internal', port: '18443' });
  });

  it('parses plain host:port', () => {
    expect(parseDifcProxyHost('proxy.internal:9000')).toEqual({
      host: 'proxy.internal',
      port: '9000',
    });
  });

  it('defaults port to 18443 when omitted', () => {
    expect(parseDifcProxyHost('proxy.internal')).toEqual({
      host: 'proxy.internal',
      port: '18443',
    });
  });

  it('parses IPv6 bracketed notation with port', () => {
    expect(parseDifcProxyHost('[::1]:9999')).toEqual({ host: '::1', port: '9999' });
  });

  it('strips an existing scheme prefix before parsing', () => {
    expect(parseDifcProxyHost('tcp://proxy.internal:1234')).toEqual({
      host: 'proxy.internal',
      port: '1234',
    });
  });

  it('throws for a malformed value that cannot be parsed as a URL', () => {
    expect(() => parseDifcProxyHost('proxy.internal:70000')).toThrow(
      /Invalid --difc-proxy-host value/,
    );
  });

  it('throws for a port of zero', () => {
    expect(() => parseDifcProxyHost('proxy.internal:0')).toThrow(
      /Invalid --difc-proxy-host port/,
    );
  });

  it('trims whitespace before parsing', () => {
    expect(parseDifcProxyHost('  proxy.internal:9000  ')).toEqual({
      host: 'proxy.internal',
      port: '9000',
    });
  });
});
