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
});
