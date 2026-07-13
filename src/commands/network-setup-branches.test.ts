/**
 * Targeted branch-coverage tests for src/commands/network-setup.ts:
 *
 * - resolveNetworkConfig: no_proxy env is set with content (line 58-59)
 * - resolveNetworkConfig: parseDnsServers throws non-Error (line 33)
 * - resolveNetworkConfig: detectUpstreamProxy throws non-Error (lines 63-71)
 */

// Mock only the deps, not the module under test
jest.mock('../logger', () => jest.requireActual('../test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('../dns-resolver');
jest.mock('../upstream-proxy');
jest.mock('../option-parsers');

import { resolveNetworkConfig } from './network-setup';
import { logger } from '../logger';
import * as dnsResolver from '../dns-resolver';
import * as upstreamProxy from '../upstream-proxy';
import * as optionParsers from '../option-parsers';
import { setupNetworkConfigMocks } from '../test-helpers/network-setup-mocks.test-utils';

const mockedNetworkLogger = logger as jest.Mocked<typeof logger>;
const mockedDnsResolver = dnsResolver as jest.Mocked<typeof dnsResolver>;
const mockedUpstreamProxy = upstreamProxy as jest.Mocked<typeof upstreamProxy>;
const mockedOptionParsers = optionParsers as jest.Mocked<typeof optionParsers>;

describe('resolveNetworkConfig – uncovered branches', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    processExitSpy = setupNetworkConfigMocks({
      detectHostDnsServers: mockedDnsResolver.detectHostDnsServers as jest.Mock,
      detectUpstreamProxy: mockedUpstreamProxy.detectUpstreamProxy as jest.Mock,
      parseDnsServers: mockedOptionParsers.parseDnsServers as jest.Mock,
      parseDnsOverHttps: mockedOptionParsers.parseDnsOverHttps as jest.Mock,
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('includes non-Error string in message when parseDnsServers throws a non-Error (line 33)', () => {
    (mockedOptionParsers.parseDnsServers as jest.Mock).mockImplementation(() => {
      throw 'bad input string';
    });

    expect(() => resolveNetworkConfig({ dnsServers: 'bad' })).toThrow('process.exit called');
    expect(mockedNetworkLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('bad input string')
    );
  });

  it('sets noProxy when no_proxy env var is set and non-empty (lines 58-60)', () => {
    mockedUpstreamProxy.parseProxyUrl.mockReturnValue({ host: 'proxy.corp', port: 8080 });
    mockedUpstreamProxy.parseNoProxy.mockReturnValue(['internal.corp', '10.0.0.0/8']);

    const origEnv = process.env;
    process.env = { ...origEnv, no_proxy: 'internal.corp,10.0.0.0/8', NO_PROXY: '' };
    try {
      const result = resolveNetworkConfig({ upstreamProxy: 'http://proxy.corp:8080' });
      expect(result.upstreamProxy).toEqual({
        host: 'proxy.corp',
        port: 8080,
        noProxy: ['internal.corp', '10.0.0.0/8'],
      });
      expect(mockedUpstreamProxy.parseNoProxy).toHaveBeenCalledWith('internal.corp,10.0.0.0/8');
    } finally {
      process.env = origEnv;
    }
  });

  it('includes non-Error string in message when detectUpstreamProxy throws a non-Error (lines 68-72)', () => {
    mockedUpstreamProxy.detectUpstreamProxy.mockImplementation(() => {
      throw 'env detection failure';
    });

    expect(() => resolveNetworkConfig({})).toThrow('process.exit called');
    expect(mockedNetworkLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('env detection failure')
    );
  });

  it('includes non-Error string in message when parseProxyUrl throws a non-Error (lines 63-64)', () => {
    mockedUpstreamProxy.parseProxyUrl.mockImplementation(() => {
      throw 'malformed proxy url';
    });

    expect(() => resolveNetworkConfig({ upstreamProxy: 'garbage' })).toThrow('process.exit called');
    expect(mockedNetworkLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('malformed proxy url')
    );
  });
});
