'use strict';

jest.mock('./model-discovery', () => ({
  ...jest.requireActual('./model-discovery'),
  fetchJson: jest.fn(),
  httpProbe: jest.fn(),
}));
jest.mock('./logging', () => ({ logRequest: jest.fn() }));

const discovery = require('./model-discovery');
const { logRequest } = require('./logging');
const validation = require('./key-validation');
const { createCopilotTokenBrokerAdapter } = require('./providers/copilot-token-broker');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function renewableAdapter() {
  return createCopilotTokenBrokerAdapter({}, {
    createTokenBrokerProvider: () => ({
      getToken: async () => 'renewable-test-credential',
      shutdown() {},
    }),
  });
}

describe('renewable startup key validation', () => {
  const originalMode = process.env.AWF_VALIDATE_KEYS;
  let exit;

  beforeEach(() => {
    jest.clearAllMocks();
    discovery.httpProbe.mockReset();
    discovery.fetchJson.mockReset();
    validation.resetKeyValidationState();
    validation.resetModelCacheState();
    process.env.AWF_VALIDATE_KEYS = 'strict';
    exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    exit.mockRestore();
    if (originalMode === undefined) delete process.env.AWF_VALIDATE_KEYS;
    else process.env.AWF_VALIDATE_KEYS = originalMode;
  });

  test.each([
    ['CONFIGURATION', 'inconclusive'],
    ['OIDC', 'inconclusive'],
    ['UNAUTHORIZED', 'auth_rejected'],
    ['UNSUPPORTED', 'inconclusive'],
    ['UNAVAILABLE', 'network_error'],
    ['MALFORMED_RESPONSE', 'inconclusive'],
  ].flatMap(([kind, status]) => [
    [kind, status, 'code'], [kind, status, 'brokerErrorCode'],
  ]))('preserves sanitized broker %s classification and strict policy via %s', async (kind, status, property) => {
    const code = `ERR_TOKEN_BROKER_${kind}`;
    const adapter = {
      name: 'copilot', renewableAuth: true,
      getValidationProbe: async () => {
        throw Object.assign(new Error('private-credential response body'), {
          code: 'token_broker_unavailable', [property]: code, detail: 'private-credential',
        });
      },
    };
    await validation.validateApiKeys([adapter]);
    expect(validation.keyValidationResults.copilot).toEqual({
      status, code, message: expect.stringContaining('Token broker'),
    });
    expect(validation.isKeyValidationComplete()).toBe(true);
    expect(discovery.httpProbe).not.toHaveBeenCalled();
    const diagnostics = JSON.stringify([validation.keyValidationResults, logRequest.mock.calls]);
    expect(diagnostics).not.toContain('private-credential');
    expect(diagnostics).not.toContain('Rotate the secret');
    expect(diagnostics).toContain('Check');
    if (kind === 'UNAUTHORIZED') expect(exit).toHaveBeenCalledWith(1);
    else expect(exit).not.toHaveBeenCalled();
    expect(logRequest).not.toHaveBeenCalledWith('info', 'key_validation', {
      message: 'All configured API keys validated successfully',
    });
  });

  test.each([
    ['ERR_TOKEN_BROKER_CONFIGURATION', 'inconclusive'],
    ['ERR_TOKEN_BROKER_OIDC', 'inconclusive'],
    ['ERR_TOKEN_BROKER_UNAUTHORIZED', 'auth_rejected'],
    ['ERR_TOKEN_BROKER_UNSUPPORTED', 'inconclusive'],
    ['ERR_TOKEN_BROKER_UNAVAILABLE', 'network_error'],
    ['ERR_TOKEN_BROKER_MALFORMED_RESPONSE', 'inconclusive'],
    ['ERR_TOKEN_BROKER_UNKNOWN-private-credential', 'network_error'],
  ])('actual adapter validation preserves sanitized acquisition classification for %s', async (code, status) => {
    const adapter = createCopilotTokenBrokerAdapter({}, {
      createTokenBrokerProvider: () => ({
        getToken: async () => { throw Object.assign(new Error('private-credential'), { code }); },
        shutdown() {},
      }),
    });
    await validation.validateApiKeys([adapter]);
    expect(validation.keyValidationResults.copilot).toEqual({
      status,
      code: code.includes('UNKNOWN') ? 'ERR_TOKEN_BROKER_UNAVAILABLE' : code,
      message: expect.stringContaining('Token broker'),
    });
    expect(adapter.isReady()).toBe(false);
    const diagnostics = JSON.stringify([validation.keyValidationResults, logRequest.mock.calls]);
    expect(diagnostics).not.toContain('private-credential');
    expect(diagnostics).not.toContain('Rotate the secret');
    if (status === 'auth_rejected') expect(exit).toHaveBeenCalledWith(1);
    else expect(exit).not.toHaveBeenCalled();
    adapter.shutdown();
  });

  test.each(['ERR_TOKEN_BROKER_UNKNOWN-private-credential', 'token_broker_unavailable', '__proto__', undefined]
    .flatMap(code => [[code, 'code'], [code, 'brokerErrorCode']]))(
    'does not leak or promote unknown broker code %s via %s to credential rejection', async (code, property) => {
      await validation.validateApiKeys([{
        name: 'copilot', renewableAuth: true,
        getValidationProbe: async () => { throw Object.assign(new Error('private-credential'), { [property]: code }); },
      }]);
      expect(validation.keyValidationResults.copilot).toEqual({
        status: 'network_error', code: 'ERR_TOKEN_BROKER_UNAVAILABLE',
        message: expect.stringContaining('Token broker is unavailable'),
      });
      expect(exit).not.toHaveBeenCalled();
      expect(JSON.stringify(logRequest.mock.calls)).not.toContain('private-credential');
      expect(JSON.stringify(logRequest.mock.calls)).not.toContain('Rotate the secret');
    }
  );

  test('retains static-secret strict rejection and rotation guidance', async () => {
    await validation.validateApiKeys([{
      name: 'openai', getValidationProbe: async () => { throw new Error('private-credential'); },
    }]);
    expect(validation.keyValidationResults.openai.status).toBe('auth_rejected');
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(logRequest.mock.calls)).toContain('Rotate the secret');
    expect(JSON.stringify(logRequest.mock.calls)).not.toContain('private-credential');
  });

  test.each([200, 400])('accepts renewable HTTP %s validation', async status => {
    const adapter = renewableAdapter();
    discovery.httpProbe.mockResolvedValue(status);
    await validation.validateApiKeys([adapter]);
    expect(validation.keyValidationResults.copilot.status).toBe('valid');
    expect(adapter.isReady()).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    adapter.shutdown();
  });

  test.each([401, 403])('late HTTP %s rejection revokes concurrently accepted renewable auth', async status => {
    const adapter = renewableAdapter();
    const probe = deferred();
    const started = deferred();
    discovery.httpProbe.mockImplementation(() => { started.resolve(); return probe.promise; });
    const validating = validation.validateApiKeys([adapter]);
    await started.promise;
    discovery.fetchJson.mockResolvedValue({ data: [{ id: 'gpt-4.1' }] });
    await validation.fetchStartupModels([adapter]);
    expect(adapter.isReady()).toBe(true);
    probe.resolve(status);
    await validating;
    expect(adapter.isReady()).toBe(false);
    expect(validation.keyValidationResults.copilot.status).toBe('auth_rejected');
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(logRequest.mock.calls)).not.toContain('Rotate the secret');
    adapter.shutdown();
  });

  test.each([
    [200, 'null'], [200, 'rejected'], [400, 'null'], [400, 'rejected'],
  ])('late inconclusive model %s/%s cannot erase successful probe readiness', async (status, outcome) => {
    const adapter = renewableAdapter();
    const models = deferred();
    const started = deferred();
    discovery.fetchJson.mockImplementation(() => { started.resolve(); return models.promise; });
    discovery.httpProbe.mockResolvedValue(status);
    const fetching = validation.fetchStartupModels([adapter]);
    await started.promise;
    await validation.validateApiKeys([adapter]);
    expect(adapter.isReady()).toBe(true);
    if (outcome === 'rejected') models.reject(new Error('private-credential'));
    else models.resolve(null);
    await fetching;
    expect(adapter.isReady()).toBe(true);
    expect(validation.isModelFetchComplete()).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    adapter.shutdown();
  });

  test.each([429, 500, 503, 'error'])('late transient probe %s cannot erase successful discovery readiness', async outcome => {
    const adapter = renewableAdapter();
    const probe = deferred();
    const started = deferred();
    discovery.httpProbe.mockImplementation(() => { started.resolve(); return probe.promise; });
    discovery.fetchJson.mockResolvedValue({ data: [{ id: 'gpt-4.1' }] });
    const validating = validation.validateApiKeys([adapter]);
    await started.promise;
    await validation.fetchStartupModels([adapter]);
    expect(adapter.isReady()).toBe(true);
    if (outcome === 'error') probe.reject(new Error('private-credential'));
    else probe.resolve(outcome);
    await validating;
    expect(adapter.isReady()).toBe(true);
    expect(validation.keyValidationResults.copilot.status).toBe(outcome === 'error' ? 'network_error' : 'inconclusive');
    expect(exit).not.toHaveBeenCalled();
    expect(JSON.stringify(logRequest.mock.calls)).not.toContain('private-credential');
    adapter.shutdown();
  });

  test.each(['models-null', 'models-error', 503, 'probe-error'])(
    'inconclusive %s alone cannot establish initial readiness', async outcome => {
      const adapter = renewableAdapter();
      if (outcome === 'models-null' || outcome === 'models-error') {
        if (outcome === 'models-error') discovery.fetchJson.mockRejectedValue(new Error('outage'));
        else discovery.fetchJson.mockResolvedValue(null);
        await validation.fetchStartupModels([adapter]);
      } else {
        if (outcome === 'probe-error') discovery.httpProbe.mockRejectedValue(new Error('outage'));
        else discovery.httpProbe.mockResolvedValue(outcome);
        await validation.validateApiKeys([adapter]);
      }
      expect(adapter.isReady()).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      adapter.shutdown();
    }
  );
});
