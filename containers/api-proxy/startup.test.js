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
    const callOrder = [];
    const oidcProvider = { initialize: jest.fn().mockResolvedValue(undefined), shutdown: jest.fn() };
    const awsOidcProvider = { initialize: jest.fn().mockResolvedValue(undefined), shutdown: jest.fn() };
    const server = {
      listen: jest.fn((port, host, cb) => cb()),
      shutdownConnections: jest.fn().mockImplementation(async () => {
        callOrder.push('shutdownConnections');
      }),
      close: jest.fn((cb) => {
        callOrder.push('close');
        cb();
      }),
    };
    oidcProvider.shutdown.mockImplementation(() => {
      callOrder.push('oidcShutdown');
    });
    awsOidcProvider.shutdown.mockImplementation(() => {
      callOrder.push('awsOidcShutdown');
    });
    const closeLogStream = jest.fn().mockImplementation(async () => {
      callOrder.push('closeLogStream');
    });
    const otelShutdown = jest.fn().mockImplementation(async () => {
      callOrder.push('otelShutdown');
    });
    processExitSpy.mockImplementation((code) => {
      callOrder.push(`exit:${code}`);
      return undefined;
    });

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
    expect(server.shutdownConnections).toHaveBeenCalledTimes(1);
    expect(oidcProvider.shutdown).toHaveBeenCalledTimes(1);
    expect(awsOidcProvider.shutdown).toHaveBeenCalledTimes(1);
    expect(closeLogStream).toHaveBeenCalledTimes(1);
    expect(otelShutdown).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(callOrder.indexOf('shutdownConnections')).toBeLessThan(callOrder.indexOf('close'));
    expect(callOrder.indexOf('close')).toBeLessThan(callOrder.indexOf('closeLogStream'));
    expect(callOrder.indexOf('closeLogStream')).toBeLessThan(callOrder.indexOf('otelShutdown'));
    expect(callOrder.indexOf('otelShutdown')).toBeLessThan(callOrder.indexOf('exit:0'));
  });
});
