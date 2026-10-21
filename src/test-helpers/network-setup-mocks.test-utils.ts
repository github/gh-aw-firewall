import { logger } from '../logger';
import * as dnsResolver from '../dns-resolver';
import * as upstreamProxy from '../upstream-proxy';
import * as optionParsers from '../option-parsers';

export const mockedLogger = jest.mocked(logger);
export const mockedDnsResolver = jest.mocked(dnsResolver);
export const mockedUpstreamProxy = jest.mocked(upstreamProxy);
export const mockedOptionParsers = jest.mocked(optionParsers);

// Keep jest.mock() declarations in each suite so Jest hoists them before these imports.
export function useNetworkConfigMocks(): void {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    mockedDnsResolver.detectHostDnsServers.mockReturnValue(['8.8.8.8']);
    mockedUpstreamProxy.detectUpstreamProxy.mockReturnValue(undefined);
    mockedOptionParsers.parseDnsServers.mockReturnValue(['1.1.1.1']);
    mockedOptionParsers.parseDnsOverHttps.mockReturnValue(undefined);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });
}
