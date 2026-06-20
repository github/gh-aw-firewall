import { parseDnsServers, parseDnsOverHttps, processLocalhostKeyword } from './dns-parsers';

describe('parseDnsServers', () => {
  it('parses a single valid IPv4 server', () => {
    expect(parseDnsServers('8.8.8.8')).toEqual(['8.8.8.8']);
  });

  it('parses multiple IPv4 servers', () => {
    expect(parseDnsServers('8.8.8.8,8.8.4.4')).toEqual(['8.8.8.8', '8.8.4.4']);
  });

  it('trims whitespace around server addresses', () => {
    expect(parseDnsServers(' 8.8.8.8 , 1.1.1.1 ')).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('throws when input is empty string', () => {
    expect(() => parseDnsServers('')).toThrow('At least one DNS server must be specified');
  });

  it('throws when all entries are blank after trimming', () => {
    expect(() => parseDnsServers('  ,  ')).toThrow('At least one DNS server must be specified');
  });

  it('throws on invalid IP address format', () => {
    expect(() => parseDnsServers('not-an-ip')).toThrow('Invalid DNS server IP address: not-an-ip');
  });

  it('throws on hostname instead of IP', () => {
    expect(() => parseDnsServers('dns.google')).toThrow('Invalid DNS server IP address: dns.google');
  });

  it('throws when second server is invalid', () => {
    expect(() => parseDnsServers('8.8.8.8,invalid')).toThrow('Invalid DNS server IP address: invalid');
  });

  it('accepts a valid IPv6 loopback address', () => {
    expect(parseDnsServers('::1')).toEqual(['::1']);
  });

  it('accepts a valid full IPv6 address', () => {
    expect(parseDnsServers('2001:4860:4860::8888')).toEqual(['2001:4860:4860::8888']);
  });

  it('accepts mixed IPv4 and IPv6 servers', () => {
    expect(parseDnsServers('8.8.8.8,::1')).toEqual(['8.8.8.8', '::1']);
  });
});

describe('parseDnsOverHttps', () => {
  it('returns undefined when value is undefined', () => {
    expect(parseDnsOverHttps(undefined)).toBeUndefined();
  });

  it('returns the default Google DoH URL when value is true', () => {
    const result = parseDnsOverHttps(true);
    expect(result).toEqual({ url: 'https://dns.google/dns-query' });
  });

  it('returns a custom https URL unchanged', () => {
    const result = parseDnsOverHttps('https://cloudflare-dns.com/dns-query');
    expect(result).toEqual({ url: 'https://cloudflare-dns.com/dns-query' });
  });

  it('returns an error for an http:// URL', () => {
    const result = parseDnsOverHttps('http://dns.example.com/dns-query');
    expect(result).toEqual({ error: '--dns-over-https resolver URL must start with https://' });
  });

  it('returns an error for a bare hostname', () => {
    const result = parseDnsOverHttps('dns.example.com');
    expect(result).toEqual({ error: '--dns-over-https resolver URL must start with https://' });
  });

  it('returns an error when value is false (falsy but not undefined)', () => {
    const result = parseDnsOverHttps(false);
    expect(result).toEqual({ error: '--dns-over-https resolver URL must start with https://' });
  });
});

describe('processLocalhostKeyword', () => {
  it('returns domains unchanged when localhost is not present', () => {
    const result = processLocalhostKeyword(['github.com', 'api.github.com'], false, undefined);
    expect(result.localhostDetected).toBe(false);
    expect(result.shouldEnableHostAccess).toBe(false);
    expect(result.allowedDomains).toEqual(['github.com', 'api.github.com']);
    expect(result.defaultPorts).toBeUndefined();
  });

  it('replaces bare localhost with host.docker.internal', () => {
    const result = processLocalhostKeyword(['localhost', 'github.com'], false, undefined);
    expect(result.localhostDetected).toBe(true);
    expect(result.allowedDomains).toContain('host.docker.internal');
    expect(result.allowedDomains).not.toContain('localhost');
    expect(result.allowedDomains).toContain('github.com');
  });

  it('preserves http:// protocol when replacing localhost', () => {
    const result = processLocalhostKeyword(['http://localhost'], false, undefined);
    expect(result.allowedDomains).toContain('http://host.docker.internal');
    expect(result.allowedDomains).not.toContain('http://localhost');
  });

  it('preserves https:// protocol when replacing localhost', () => {
    const result = processLocalhostKeyword(['https://localhost'], false, undefined);
    expect(result.allowedDomains).toContain('https://host.docker.internal');
  });

  it('sets shouldEnableHostAccess to true when enableHostAccess is false', () => {
    const result = processLocalhostKeyword(['localhost'], false, undefined);
    expect(result.shouldEnableHostAccess).toBe(true);
  });

  it('sets shouldEnableHostAccess to false when enableHostAccess is already true', () => {
    const result = processLocalhostKeyword(['localhost'], true, undefined);
    expect(result.shouldEnableHostAccess).toBe(false);
  });

  it('sets defaultPorts when allowHostPorts is undefined', () => {
    const result = processLocalhostKeyword(['localhost'], false, undefined);
    expect(result.defaultPorts).toBeDefined();
    expect(result.defaultPorts).toContain('3000');
    expect(result.defaultPorts).toContain('8080');
  });

  it('sets defaultPorts to undefined when allowHostPorts is already provided', () => {
    const result = processLocalhostKeyword(['localhost'], false, '8080,3000');
    expect(result.defaultPorts).toBeUndefined();
  });
});
