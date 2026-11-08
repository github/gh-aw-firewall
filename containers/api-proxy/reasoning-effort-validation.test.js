'use strict';

const { clearRuntimeModels, replaceRuntimeModels } = require('./runtime-model-catalog');
const { validateReasoningEffort } = require('./reasoning-effort-validation');

describe('validateReasoningEffort', () => {
  afterEach(() => clearRuntimeModels());

  it.each([
    ['/v1/chat/completions', { reasoning_effort: 'short' }, 'reasoning_effort'],
    ['/v1/responses', { reasoning: { effort: 'short' } }, 'reasoning.effort'],
    ['/v1/messages', { output_config: { effort: 'short' } }, 'output_config.effort'],
  ])('rejects an unsupported effort on %s', (url, effort, field) => {
    replaceRuntimeModels('copilot', [{
      id: 'gpt-5-mini',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    }]);

    expect(() => validateReasoningEffort(
      Buffer.from(JSON.stringify({ model: 'gpt-5-mini', ...effort })),
      'copilot',
      url,
    )).toThrow(expect.objectContaining({
      statusCode: 400,
      code: 'unsupported_reasoning_effort',
      message: `${field} "short" is not supported by model gpt-5-mini; supported values: [low medium high]`,
    }));
  });

  it.each([
    ['/v1/chat/completions', { reasoning_effort: 'high' }],
    ['/v1/responses', { reasoning: { effort: 'high' } }],
    ['/v1/messages', { output_config: { effort: 'high' } }],
  ])('accepts an advertised effort on %s', (url, effort) => {
    replaceRuntimeModels('copilot', [{
      id: 'gpt-5-mini',
      capabilities: { supports: { reasoning_effort: ['low', 'medium', 'high'] } },
    }]);

    expect(() => validateReasoningEffort(
      Buffer.from(JSON.stringify({ model: 'gpt-5-mini', ...effort })),
      'copilot',
      url,
    )).not.toThrow();
  });

  it('does not reject requests when model effort capabilities are unavailable', () => {
    replaceRuntimeModels('copilot', [{ id: 'gpt-5-mini' }]);

    expect(() => validateReasoningEffort(
      Buffer.from(JSON.stringify({ model: 'gpt-5-mini', reasoning_effort: 'short' })),
      'copilot',
      '/v1/chat/completions',
    )).not.toThrow();
  });

  it.each([
    ['/v1/chat/completions/?trace=1', 'reasoning_effort'],
    ['/v1/responses/', 'reasoning.effort'],
    ['/v1/messages?trace=1', 'output_config.effort'],
  ])('preserves omitted and non-string field semantics on %s', (url, field) => {
    const catalog = { copilot: [{ id: 'exact-test', supportedReasoningEfforts: ['none', 'max'] }] };
    for (const value of [undefined, null, 3, {}, 'none', 'max']) {
      const parsed = { model: 'exact-test' };
      if (field === 'reasoning_effort') parsed.reasoning_effort = value;
      else {
        const [parent, child] = field.split('.');
        parsed[parent] = { [child]: value };
      }
      const body = Buffer.from(JSON.stringify(parsed));
      const original = Buffer.from(body);
      expect(() => validateReasoningEffort(body, 'copilot', url, catalog)).not.toThrow();
      expect(body).toEqual(original);
    }
  });

  it.each([
    ['/chat/completions', { reasoning_effort: 'future' }, 'reasoning_effort'],
    ['/responses', { reasoning: { effort: 'future' } }, 'reasoning.effort'],
    ['/messages', { output_config: { effort: 'future' } }, 'output_config.effort'],
  ])('rejects unsupported future efforts with the unchanged error envelope on %s', (url, fields, field) => {
    expect(() => validateReasoningEffort(Buffer.from(JSON.stringify({ model: 'exact-test', ...fields })),
      'copilot', url, { copilot: [{ id: 'exact-test', supportedReasoningEfforts: [] }] }))
      .toThrow(expect.objectContaining({
        statusCode: 400, type: 'invalid_request_error', code: 'unsupported_reasoning_effort',
        message: `${field} "future" is not supported by model exact-test; supported values: []`,
      }));
  });

  it('uses active maintained native evidence but still passes genuinely unknown support through', () => {
    expect(() => validateReasoningEffort(Buffer.from(JSON.stringify({
      model: 'gpt-5.4', reasoning_effort: 'max',
    })), 'openai', '/chat/completions', {}))
      .toThrow(expect.objectContaining({ code: 'unsupported_reasoning_effort' }));
    expect(() => validateReasoningEffort(Buffer.from(JSON.stringify({
      model: 'gpt-5.4-mini', reasoning_effort: 'future',
    })), 'openai', '/chat/completions', {})).not.toThrow();
  });

  it.each(['', '?effort=high', '/opaque', '../opaque'])('preserves opaque model pass-through: %s', model => {
    expect(() => validateReasoningEffort(Buffer.from(JSON.stringify({
      model, reasoning_effort: 'future',
    })), 'openai', '/chat/completions', {})).not.toThrow();
  });
});
