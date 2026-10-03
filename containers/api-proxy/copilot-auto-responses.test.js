'use strict';

let makeModelBodyTransform;

describe('Copilot Responses auto routing', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AWF_ALLOWED_MODELS;
    delete process.env.AWF_DISALLOWED_MODELS;
    jest.isolateModules(() => {
      ({ makeModelBodyTransform } = require('./model-config'));
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const models = {
    copilot: ['gpt-5.3-codex', 'gpt-5.4-codex', 'gpt-5.5-chat'],
  };
  const metadata = [
    { id: 'gpt-5.3-codex', supportedEndpoints: ['/responses'] },
    { id: 'gpt-5.4-codex', supportedEndpoints: ['/responses', '/chat/completions'] },
    { id: 'gpt-5.5-chat', supportedEndpoints: ['/chat/completions'] },
  ];

  function createTransform(overrides = {}) {
    return makeModelBodyTransform(
      'copilot',
      overrides.models || models,
      overrides.refresh || jest.fn(),
      () => new Set(['copilot']),
      overrides.getRuntimeModels || (() => metadata),
      overrides.isNativeCopilot ?? true,
    );
  }

  it('routes Responses auto to the highest-version inventory model compatible with Codex', async () => {
    const transform = createTransform();
    const req = { method: 'POST', url: '/v1/responses?stream=true' };
    const body = Buffer.from(JSON.stringify({
      model: 'copilot/auto',
      input: 'Hello',
      tools: [{ type: 'custom' }],
    }));

    const result = await transform(body, req);

    expect(JSON.parse(result.toString('utf8'))).toEqual({
      model: 'gpt-5.4-codex',
      input: 'Hello',
      tools: [{ type: 'custom' }],
    });
    expect(req.awfModelCandidates).toEqual(['gpt-5.4-codex', 'gpt-5.3-codex']);
  });

  it('skips a disabled higher-version Codex model', async () => {
    const transform = createTransform({
      getRuntimeModels: () => metadata.map(record => ({
        ...record,
        modelPickerEnabled: record.id !== 'gpt-5.4-codex',
      })),
    });
    const req = { method: 'POST', url: '/responses' };

    const result = await transform(Buffer.from('{"model":"auto"}'), req);

    expect(JSON.parse(result.toString('utf8')).model).toBe('gpt-5.3-codex');
    expect(req.awfModelCandidates).toEqual(['gpt-5.3-codex']);
  });

  it.each([
    ['AWF_ALLOWED_MODELS', ['copilot/gpt-5.3-codex']],
    ['AWF_DISALLOWED_MODELS', ['copilot/gpt-5.4-codex']],
  ])('routes auto using concrete-model policy from %s', async (key, patterns) => {
    process.env[key] = JSON.stringify(patterns);
    jest.isolateModules(() => {
      ({ makeModelBodyTransform } = require('./model-config'));
    });
    const refresh = jest.fn();
    const transform = createTransform({ refresh });
    const req = { method: 'POST', url: '/responses' };

    const result = await transform(Buffer.from('{"model":"copilot/auto"}'), req);

    expect(JSON.parse(result.toString('utf8')).model).toBe('gpt-5.3-codex');
    expect(req.awfModelCandidates).toEqual(['gpt-5.3-codex']);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['AWF_ALLOWED_MODELS', ['gpt-5.5-chat']],
    ['AWF_DISALLOWED_MODELS', ['*codex*']],
  ])('fails closed after one refresh when %s excludes all compatible models', async (key, patterns) => {
    process.env[key] = JSON.stringify(patterns);
    jest.isolateModules(() => {
      ({ makeModelBodyTransform } = require('./model-config'));
    });
    const refresh = jest.fn();
    const transform = createTransform({ refresh });

    await expect(transform(
      Buffer.from('{"model":"auto"}'),
      { method: 'POST', url: '/responses' },
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'copilot_auto_responses_model_unavailable',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('copilot');
  });

  it('fails closed when all compatible models are disabled', async () => {
    const refresh = jest.fn();
    const transform = createTransform({
      getRuntimeModels: () => metadata.map(record => ({ ...record, modelPickerEnabled: false })),
      refresh,
    });

    await expect(transform(
      Buffer.from('{"model":"auto"}'),
      { method: 'POST', url: '/responses' },
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'copilot_auto_responses_model_unavailable',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves Chat Completions auto unchanged', async () => {
    const transform = createTransform();
    const body = Buffer.from(JSON.stringify({ model: 'auto', messages: [] }));

    await expect(transform(body, { method: 'POST', url: '/chat/completions' })).resolves.toBeNull();
  });

  it('refreshes the Copilot inventory before reporting no compatible model', async () => {
    const refreshedModels = { copilot: ['gpt-4o'] };
    const refresh = jest.fn(async () => {
      refreshedModels.copilot = ['gpt-5.3-codex'];
    });
    const transform = createTransform({
      models: refreshedModels,
      getRuntimeModels: () => metadata,
      refresh,
    });
    const req = { method: 'POST', url: '/responses' };
    const result = await transform(Buffer.from('{"model":"auto"}'), req);

    expect(refresh).toHaveBeenCalledWith('copilot');
    expect(JSON.parse(result.toString('utf8')).model).toBe('gpt-5.3-codex');
  });

  it('fails explicitly when the inventory has no Codex-compatible Responses model', async () => {
    const transform = createTransform({
      models: { copilot: ['gpt-5.5-chat'] },
      refresh: jest.fn(),
    });

    await expect(transform(
      Buffer.from('{"model":"auto"}'),
      { method: 'POST', url: '/responses' },
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'copilot_auto_responses_model_unavailable',
    });
  });

  it('does not route auto for custom Copilot targets', async () => {
    const transform = createTransform({ isNativeCopilot: false });

    const result = transform
      ? await transform(Buffer.from('{"model":"auto"}'), { method: 'POST', url: '/responses' })
      : null;
    expect(result).toBeNull();
  });
});
