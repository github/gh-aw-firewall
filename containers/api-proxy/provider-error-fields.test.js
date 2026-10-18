'use strict';

const { extractProviderErrorFields } = require('./provider-error-fields');

describe('extractProviderErrorFields', () => {
  it.each([
    ['OpenAI/Copilot envelope', { error: { code: 'c', type: 't', param: 'p', message: 'm' } },
      { error_code: 'c', error_type: 't', error_param: 'p' }],
    ['Anthropic envelope', { type: 'error', error: { type: 'overloaded_error', message: 'm' } },
      { error_type: 'overloaded_error' }],
    ['Responses response.failed', { type: 'response.failed', response: { error: { code: 'rate_limited' } } },
      { error_code: 'rate_limited' }],
    ['top-level SSE error event', { type: 'error', code: 'server_error', param: 'input' },
      { error_type: 'error', error_code: 'server_error', error_param: 'input' }],
  ])('extracts fields from a %s', (_name, value, expected) => {
    expect(extractProviderErrorFields(value)).toEqual(expected);
  });

  it.each([
    null, 'text', 42, [], {}, { error: 'rate limited' }, { error: [] },
    { error: { code: 42, type: null, param: 'has spaces' } },
    { error: { code: 'a'.repeat(65), type: '', param: 'semi;colon' } },
    { type: 'response.failed' },
  ])('returns {} without an identifier-shaped value (%j)', value => {
    expect(extractProviderErrorFields(value)).toEqual({});
  });

  it('accepts 64-character identifiers and never reads message', () => {
    const code = 'a'.repeat(64);
    expect(extractProviderErrorFields({ error: { code, message: 'valid_identifier' } })).toEqual({ error_code: code });
  });
});
