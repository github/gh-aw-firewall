'use strict';

const { bootPrimary } = require('./startup');

describe('bootPrimary shutdown', () => {
  let handlers;
  let processOnSpy;
  let processExitSpy;
  let originalShutdownTimeout;

  beforeEach(() => {
    handlers = {};
    processOnSpy = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
      handlers[event] = handler;
      return process;
    });
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    originalShutdownTimeout = process.env.AWF_API_PROXY_SHUTDOWN_TIMEOUT_MS;
    process.env.AWF_API_PROXY_SHUTDOWN_TIMEOUT_MS = '1000';
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    if (originalShutdownTimeout === undefined) {
      delete process.env.AWF_API_PROXY_SHUTDOWN_TIMEOUT_MS;
    } else {
      process.env.AWF_API_PROXY_SHUTDOWN_TIMEOUT_MS = originalShutdownTimeout;
    }
  });

  test('closes servers and flushes logs on SIGTERM before exiting', async () => {
    const oidcProvider = { initialize: jest.fn().mockResolvedValue(undefined), shutdown: jest.fn() };
    const awsOidcProvider = { initialize: jest.fn().mockResolvedValue(undefined), shutdown: jest.fn() };
    const server = {
      listen: jest.fn((port, host, cb) => cb()),
      close: jest.fn((cb) => cb()),
    };
    const closeLogStream = jest.fn().mockResolvedValue(undefined);
    const otelShutdown = jest.fn().mockResolvedValue(undefined);

    bootPrimary({
      registeredAdapters: [{
        name: 'openai',
        port: 10000,
        alwaysBind: true,
        participatesInValidation: false,
        isEnabled: () => true,
        getTargetHost: () => 'api.openai.com',
        getOidcProvider: () => oidcProvider,
        getAwsOidcProvider: () => awsOidcProvider,
      }],
      createProviderServer: () => server,
      validateApiKeys: jest.fn(),
      fetchStartupModels: jest.fn().mockResolvedValue(undefined),
      writeModelsJson: jest.fn(),
      validateRequestedModel: jest.fn(),
      setKeyValidationComplete: jest.fn(),
      setModelFetchComplete: jest.fn(),
      closeLogStream,
      otelShutdown,
      logRequest: jest.fn(),
      HTTPS_PROXY: 'http://proxy:3128',
    });

    await handlers.SIGTERM();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(oidcProvider.shutdown).toHaveBeenCalledTimes(1);
    expect(awsOidcProvider.shutdown).toHaveBeenCalledTimes(1);
    expect(closeLogStream).toHaveBeenCalledTimes(1);
    expect(otelShutdown).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });
});
