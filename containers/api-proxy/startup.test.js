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

describe('bootPrimary routing lifecycle', () => {
  let handlers;
  let processOnSpy;
  let processExitSpy;

  beforeEach(() => {
    handlers = {};
    processOnSpy = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
      handlers[event] = handler;
      return process;
    });
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  function boot(routing, callOrder = []) {
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
    bootPrimary({
      registeredAdapters: [{
        name: 'copilot',
        port: 10002,
        alwaysBind: true,
        participatesInValidation: true,
        isEnabled: () => true,
        getTargetHost: () => 'api.githubcopilot.com',
      }],
      createProviderServer: () => server,
      validateApiKeys: jest.fn().mockImplementation(async () => {
        callOrder.push('validateApiKeys');
      }),
      fetchStartupModels: jest.fn().mockImplementation(async () => {
        callOrder.push('fetchStartupModels');
      }),
      writeModelsJson: jest.fn(),
      validateRequestedModel: jest.fn(),
      setKeyValidationComplete: jest.fn(),
      setModelFetchComplete: jest.fn(),
      closeLogStream: jest.fn().mockResolvedValue(undefined),
      otelShutdown: jest.fn().mockImplementation(async () => {
        callOrder.push('otelShutdown');
      }),
      logRequest: jest.fn(),
      HTTPS_PROXY: 'http://proxy:3128',
      routing,
    });
    return callOrder;
  }

  test('starts routing only after key validation and model discovery succeed', async () => {
    const callOrder = [];
    const routing = {
      start: jest.fn().mockImplementation(async () => {
        callOrder.push('routingStart');
      }),
      shutdown: jest.fn().mockResolvedValue(undefined),
      completeShutdown: jest.fn(),
    };

    boot(routing, callOrder);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(routing.start).toHaveBeenCalledTimes(1);
    expect(callOrder.indexOf('validateApiKeys')).toBeLessThan(callOrder.indexOf('routingStart'));
    expect(callOrder.indexOf('fetchStartupModels')).toBeLessThan(callOrder.indexOf('routingStart'));
  });

  test('drains routing before servers close and completes after telemetry shutdown', async () => {
    const callOrder = [];
    const routing = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockImplementation(async () => {
        callOrder.push('routingShutdown');
      }),
      completeShutdown: jest.fn().mockImplementation(() => {
        callOrder.push('routingComplete');
      }),
    };

    boot(routing, callOrder);
    await handlers.SIGTERM();

    expect(callOrder.indexOf('routingShutdown')).toBeLessThan(callOrder.indexOf('shutdownConnections'));
    expect(callOrder.indexOf('otelShutdown')).toBeLessThan(callOrder.indexOf('routingComplete'));
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  test('exits 78 when the routing completion record cannot be published', async () => {
    const routing = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      completeShutdown: jest.fn().mockImplementation(() => {
        throw new Error('publish failed');
      }),
    };

    boot(routing);
    await handlers.SIGTERM();

    expect(processExitSpy).toHaveBeenCalledWith(78);
    expect(processExitSpy).not.toHaveBeenCalledWith(0);
  });
});
