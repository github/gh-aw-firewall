'use strict';

const { makeModelBodyTransform } = require('./model-config');

describe('Copilot Responses auto routing', () => {
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
