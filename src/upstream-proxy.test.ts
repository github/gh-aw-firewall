import { parseProxyUrl, parseNoProxy, detectUpstreamProxy, PROXY_ENV_VARS } from './upstream-proxy';

// Suppress logger output in tests
jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

describe('PROXY_ENV_VARS', () => {
  it('includes all standard proxy environment variable names', () => {
    expect(PROXY_ENV_VARS).toContain('HTTP_PROXY');
    expect(PROXY_ENV_VARS).toContain('HTTPS_PROXY');
    expect(PROXY_ENV_VARS).toContain('http_proxy');
    expect(PROXY_ENV_VARS).toContain('https_proxy');
    expect(PROXY_ENV_VARS).toContain('NO_PROXY');
    expect(PROXY_ENV_VARS).toContain('no_proxy');
    expect(PROXY_ENV_VARS).toContain('ALL_PROXY');
    expect(PROXY_ENV_VARS).toContain('all_proxy');
  });
});

describe('parseProxyUrl', () => {
  it('parses a standard HTTP proxy URL', () => {
    expect(parseProxyUrl('http://proxy.corp.com:3128')).toEqual({
      host: 'proxy.corp.com',
      port: 3128,
    });
  });

  it('defaults port to 3128 when omitted', () => {
    expect(parseProxyUrl('http://proxy.corp.com')).toEqual({
      host: 'proxy.corp.com',
      port: 3128,
    });
  });

  it('handles URL without scheme', () => {
    expect(parseProxyUrl('proxy.corp.com:8080')).toEqual({
      host: 'proxy.corp.com',
      port: 8080,
    });
  });

  it('handles bare hostname without scheme or port', () => {
    expect(parseProxyUrl('proxy.corp.com')).toEqual({
      host: 'proxy.corp.com',
      port: 3128,
    });
  });

  it('trims whitespace', () => {
    expect(parseProxyUrl('  http://proxy.corp.com:3128  ')).toEqual({
      host: 'proxy.corp.com',
      port: 3128,
    });
  });

  it('rejects empty URL', () => {
    expect(() => parseProxyUrl('')).toThrow('empty');
    expect(() => parseProxyUrl('  ')).toThrow('empty');
  });

  it('rejects URLs with credentials', () => {
    expect(() => parseProxyUrl('http://user:pass@proxy.corp.com:3128')).toThrow('credentials');
    expect(() => parseProxyUrl('http://user@proxy.corp.com:3128')).toThrow('credentials');
  });

  it('rejects HTTPS scheme', () => {
    expect(() => parseProxyUrl('https://proxy.corp.com:3128')).toThrow('unsupported scheme');
  });

  it('rejects loopback addresses', () => {
    expect(() => parseProxyUrl('http://localhost:3128')).toThrow('loopback');
    expect(() => parseProxyUrl('http://127.0.0.1:3128')).toThrow('loopback');
    expect(() => parseProxyUrl('http://0.0.0.0:3128')).toThrow('loopback');
  });

  it('rejects hostnames with squid.conf injection characters', () => {
    expect(() => parseProxyUrl('http://proxy host.com:3128')).toThrow();
    expect(() => parseProxyUrl("http://proxy'host.com:3128")).toThrow('invalid characters');
  });

  it('accepts valid IP addresses', () => {
    expect(parseProxyUrl('http://10.0.0.1:3128')).toEqual({
      host: '10.0.0.1',
      port: 3128,
    });
    expect(parseProxyUrl('http://192.168.1.1:8080')).toEqual({
      host: '192.168.1.1',
      port: 8080,
    });
  });
});

describe('parseNoProxy', () => {
  it('parses comma-separated domain suffixes', () => {
    expect(parseNoProxy('.corp.com,internal.example.com')).toEqual([
      '.corp.com',
      'internal.example.com',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseNoProxy('')).toEqual([]);
    expect(parseNoProxy('  ')).toEqual([]);
  });

  it('skips loopback entries', () => {
    expect(parseNoProxy('localhost,127.0.0.1,.corp.com')).toEqual(['.corp.com']);
  });

  it('skips wildcard *', () => {
    expect(parseNoProxy('*,.corp.com')).toEqual(['.corp.com']);
  });

  it('skips IP addresses', () => {
    expect(parseNoProxy('10.0.0.0/8,.corp.com,192.168.1.1')).toEqual(['.corp.com']);
  });

  it('skips IPv6 entries', () => {
    expect(parseNoProxy('::1,[::1],.corp.com')).toEqual(['.corp.com']);
  });

  it('skips entries with ports', () => {
    expect(parseNoProxy('host:8080,.corp.com')).toEqual(['.corp.com']);
  });

  it('skips entries with injection characters', () => {
    expect(parseNoProxy('.corp.com,bad domain.com')).toEqual(['.corp.com']);
  });

  it('handles whitespace around entries', () => {
    expect(parseNoProxy(' .corp.com , internal.example.com ')).toEqual([
      '.corp.com',
      'internal.example.com',
    ]);
  });
});

describe('detectUpstreamProxy', () => {
  it('returns undefined when no proxy env vars are set', () => {
    expect(detectUpstreamProxy({})).toBeUndefined();
  });

  it('detects from https_proxy', () => {
    const result = detectUpstreamProxy({
      https_proxy: 'http://proxy.corp.com:3128',
    });
    expect(result).toEqual({
      host: 'proxy.corp.com',
      port: 3128,
    });
  });

  it('detects from HTTPS_PROXY', () => {
    const result = detectUpstreamProxy({
      HTTPS_PROXY: 'http://proxy.corp.com:3128',
    });
    expect(result).toEqual({
      host: 'proxy.corp.com',
      port: 3128,
    });
  });

  it('prefers lowercase https_proxy over uppercase', () => {
    const result = detectUpstreamProxy({
      https_proxy: 'http://lowercase.corp.com:3128',
      HTTPS_PROXY: 'http://uppercase.corp.com:3128',
    });
    expect(result).toEqual({
      host: 'lowercase.corp.com',
      port: 3128,
    });
  });

  it('falls back to http_proxy when https_proxy is absent', () => {
    const result = detectUpstreamProxy({
      http_proxy: 'http://proxy.corp.com:8080',
    });
    expect(result).toEqual({
      host: 'proxy.corp.com',
      port: 8080,
    });
  });

  it('throws when http_proxy and https_proxy differ', () => {
    expect(() =>
      detectUpstreamProxy({
        http_proxy: 'http://proxy1.corp.com:3128',
        https_proxy: 'http://proxy2.corp.com:3128',
      })
    ).toThrow('different http_proxy and https_proxy');
  });

  it('succeeds when http_proxy and https_proxy are the same', () => {
    const result = detectUpstreamProxy({
      http_proxy: 'http://proxy.corp.com:3128',
      https_proxy: 'http://proxy.corp.com:3128',
    });
    expect(result).toEqual({
      host: 'proxy.corp.com',
      port: 3128,
    });
  });

  it('includes no_proxy domains', () => {
    const result = detectUpstreamProxy({
      https_proxy: 'http://proxy.corp.com:3128',
      no_proxy: 'localhost,.corp.com,internal.example.com',
    });
    expect(result).toEqual({
      host: 'proxy.corp.com',
      port: 3128,
      noProxy: ['.corp.com', 'internal.example.com'],
    });
  });

  it('omits noProxy when all entries are filtered out', () => {
    const result = detectUpstreamProxy({
      https_proxy: 'http://proxy.corp.com:3128',
      no_proxy: 'localhost,127.0.0.1',
    });
    expect(result).toEqual({
      host: 'proxy.corp.com',
      port: 3128,
    });
  });
});
