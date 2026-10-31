'use strict';

jest.mock('./providers', () => ({
  ...jest.requireActual('./providers'),
  createAllAdapters: jest.fn((...args) => jest.requireActual('./providers').createAllAdapters(...args)),
}));
jest.mock('./providers/token-broker', () => ({
  ...jest.requireActual('./providers/token-broker'),
  createTokenBrokerProvider: jest.fn(() => ({
    getToken: jest.fn().mockResolvedValue('broker-test-token'),
    shutdown: jest.fn(),
  })),
}));
jest.mock('./key-validation', () => ({
  ...jest.requireActual('./key-validation'),
  getRuntimeModels: () => [
    { id: 'gpt-5.3-codex', supportedEndpoints: ['/responses'] },
    { id: 'gpt-5.4-codex', supportedEndpoints: ['/responses', '/chat/completions'] },
    { id: 'gpt-5.5-chat', supportedEndpoints: ['/chat/completions'] },
  ],
}));

describe('production Copilot auto transform wiring', () => {
  const originalEnv = { ...process.env };
  let adapter;

  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('AWF_') || key.startsWith('COPILOT_')) delete process.env[key];
    }
    delete process.env.HTTPS_PROXY;
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    adapter?.shutdown?.();
    adapter = null;
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  function load(mode) {
    if (mode === 'broker') process.env.AWF_COPILOT_TOKEN_BROKER = 'true';
    else process.env.COPILOT_GITHUB_TOKEN = 'static-test-token';
    const server = require('./server');
    server.cachedModels.copilot = ['gpt-5.3-codex', 'gpt-5.4-codex', 'gpt-5.5-chat'];
    const { createAllAdapters } = require('./providers');
    adapter = createAllAdapters.mock.results.at(-1).value.find(item => item.name === 'copilot');
    return adapter.getBodyTransform();
  }

  test.each(['broker', 'static'].flatMap(mode =>
    ['auto', 'copilot/auto'].flatMap(model =>
      ['/responses', '/v1/responses', '/chat/completions', '/v1/chat/completions']
        .map(path => [mode, model, path]))))(
    '%s resolves %s for %s through the registered production adapter',
    async (mode, model, path) => {
      const transform = load(mode);
      const responses = path.endsWith('/responses');
      const body = {
        model,
        ...(responses ? { input: 'Hello', tools: [{ type: 'custom' }] } : {
          messages: [{ role: 'assistant', tool_calls: [{ id: 'call-1', type: null, function: { name: 'test', arguments: '{}' } }] }],
        }),
      };
      const req = { method: 'POST', url: `${path}?stream=true` };
      const transformed = await transform(Buffer.from(JSON.stringify(body)), req);
      const result = JSON.parse(transformed.toString());
      if (responses) {
        expect(result).toEqual({ ...body, model: 'gpt-5.4-codex' });
        expect(req.awfModelCandidates).toEqual(['gpt-5.4-codex', 'gpt-5.3-codex']);
      } else {
        if (model === 'auto') expect(result.model).toBeUndefined();
        else expect(result.model).toBe(model);
        expect(result.messages[0].tool_calls[0].type).toBe('function');
      }
    },
  );
});
