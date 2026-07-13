interface NetworkSetupMockFns {
  detectHostDnsServers: jest.Mock;
  detectUpstreamProxy: jest.Mock;
  parseDnsServers: jest.Mock;
  parseDnsOverHttps: jest.Mock;
}

export function setupNetworkConfigMocks(mocks: NetworkSetupMockFns): jest.SpyInstance {
  jest.clearAllMocks();

  const processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });

  mocks.detectHostDnsServers.mockReturnValue(['8.8.8.8']);
  mocks.detectUpstreamProxy.mockReturnValue(undefined);
  mocks.parseDnsServers.mockReturnValue(['1.1.1.1']);
  mocks.parseDnsOverHttps.mockReturnValue(undefined);

  return processExitSpy;
}
