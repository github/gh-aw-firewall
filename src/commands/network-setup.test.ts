import { resolveNetworkConfig } from './network-setup';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('../dns-resolver');
jest.mock('../upstream-proxy');
jest.mock('../option-parsers');

import {
  mockedLogger,
  mockedDnsResolver,
  mockedUpstreamProxy,
  mockedOptionParsers,
  useNetworkConfigMocks,
} from '../test-helpers/network-setup-mocks.test-utils';

describe('resolveNetworkConfig', () => {
  useNetworkConfigMocks();

  it('uses the shared network defaults and logger', () => {
    expect(resolveNetworkConfig({})).toEqual({
      dnsServers: ['8.8.8.8'],
      dnsServersExplicit: false,
      dnsOverHttps: undefined,
      upstreamProxy: undefined,
    });
    expect(mockedDnsResolver.detectHostDnsServers).toHaveBeenCalledWith(mockedLogger);
    expect(resolveNetworkConfig({ dnsServers: '1.1.1.1' }).dnsServers).toEqual(['1.1.1.1']);
  });

  it('auto-detects DNS servers when --dns-servers is not provided', () => {
    const result = resolveNetworkConfig({});
    expect(mockedDnsResolver.detectHostDnsServers).toHaveBeenCalled();
    expect(result.dnsServers).toEqual(['8.8.8.8']);
  });

  it('parses DNS servers from --dns-servers flag', () => {
    mockedOptionParsers.parseDnsServers.mockReturnValue(['1.1.1.1', '8.8.8.8']);
    const result = resolveNetworkConfig({ dnsServers: '1.1.1.1,8.8.8.8' });
    expect(mockedOptionParsers.parseDnsServers).toHaveBeenCalledWith('1.1.1.1,8.8.8.8');
    expect(result.dnsServers).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  it('exits when --dns-servers is invalid', () => {
    mockedOptionParsers.parseDnsServers.mockImplementation(() => {
      throw new Error('Invalid IP');
    });
    expect(() => resolveNetworkConfig({ dnsServers: 'not-an-ip' })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid DNS servers'));
  });

  it('returns undefined dnsOverHttps when --dns-over-https is not set', () => {
    mockedOptionParsers.parseDnsOverHttps.mockReturnValue(undefined);
    const result = resolveNetworkConfig({});
    expect(result.dnsOverHttps).toBeUndefined();
  });

  it('returns resolved DNS-over-HTTPS URL', () => {
    mockedOptionParsers.parseDnsOverHttps.mockReturnValue({ url: 'https://1.1.1.1/dns-query' });
    const result = resolveNetworkConfig({ dnsOverHttps: true });
    expect(result.dnsOverHttps).toBe('https://1.1.1.1/dns-query');
    expect(mockedLogger.info).toHaveBeenCalledWith(expect.stringContaining('DNS-over-HTTPS enabled'));
  });

  it('exits when --dns-over-https is invalid', () => {
    mockedOptionParsers.parseDnsOverHttps.mockReturnValue({ error: 'Bad DoH URL' });
    expect(() => resolveNetworkConfig({ dnsOverHttps: 'bad-url' })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith('Bad DoH URL');
  });

  it('auto-detects upstream proxy from environment', () => {
    mockedUpstreamProxy.detectUpstreamProxy.mockReturnValue({ host: 'proxy.corp', port: 3128 });
    const result = resolveNetworkConfig({});
    expect(result.upstreamProxy).toEqual({ host: 'proxy.corp', port: 3128 });
  });

  it('returns undefined upstreamProxy when none detected', () => {
    mockedUpstreamProxy.detectUpstreamProxy.mockReturnValue(undefined);
    const result = resolveNetworkConfig({});
    expect(result.upstreamProxy).toBeUndefined();
  });

  it('parses explicit --upstream-proxy flag', () => {
    mockedUpstreamProxy.parseProxyUrl.mockReturnValue({ host: 'proxy.example.com', port: 8080 });
    mockedUpstreamProxy.parseNoProxy.mockReturnValue([]);

    const origEnv = process.env;
    process.env = { ...origEnv, no_proxy: '' };
    try {
      const result = resolveNetworkConfig({ upstreamProxy: 'http://proxy.example.com:8080' });
      expect(result.upstreamProxy).toEqual({ host: 'proxy.example.com', port: 8080 });
      expect(mockedLogger.info).toHaveBeenCalledWith(expect.stringContaining('Upstream proxy (explicit)'));
    } finally {
      process.env = origEnv;
    }
  });

  it('includes noProxy when NO_PROXY env var is set', () => {
    mockedUpstreamProxy.parseProxyUrl.mockReturnValue({ host: 'proxy.example.com', port: 8080 });
    mockedUpstreamProxy.parseNoProxy.mockReturnValue(['localhost', '127.0.0.1']);

    const origEnv = process.env;
    process.env = { ...origEnv, NO_PROXY: 'localhost,127.0.0.1' };
    try {
      const result = resolveNetworkConfig({ upstreamProxy: 'http://proxy.example.com:8080' });
      expect(result.upstreamProxy).toEqual({
        host: 'proxy.example.com',
        port: 8080,
        noProxy: ['localhost', '127.0.0.1'],
      });
    } finally {
      process.env = origEnv;
    }
  });

  it('exits when --upstream-proxy is invalid', () => {
    mockedUpstreamProxy.parseProxyUrl.mockImplementation(() => {
      throw new Error('Invalid URL');
    });
    expect(() => resolveNetworkConfig({ upstreamProxy: 'not-a-url' })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid --upstream-proxy'));
  });

  it('exits when upstream proxy auto-detection fails', () => {
    mockedUpstreamProxy.detectUpstreamProxy.mockImplementation(() => {
      throw new Error('Detection error');
    });
    expect(() => resolveNetworkConfig({})).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Upstream proxy auto-detection failed'));
  });
});
