/**
 * Tests for stripRedundantModelPrefixInBody — the always-on (alias-config
 * independent) normalization that strips a redundant "<provider>/" prefix
 * from the "model" field of a request body. Harnesses such as Pi and Codex
 * use LiteLLM-style "provider/model" naming (e.g. "copilot/auto") even when
 * already talking directly to that provider's endpoint.
 */

const { stripRedundantModelPrefixInBody } = require('./model-body-rewriter');

describe('stripRedundantModelPrefixInBody', () => {
  it('strips a redundant "copilot/" prefix from the model field', () => {
    const body = Buffer.from(JSON.stringify({ model: 'copilot/auto', messages: [] }));
    const result = stripRedundantModelPrefixInBody(body, 'copilot');
    expect(result).not.toBeNull();
    expect(JSON.parse(result.toString('utf8'))).toEqual({ model: 'auto', messages: [] });
  });

  it('strips a redundant prefix for a concrete model name', () => {
    const body = Buffer.from(JSON.stringify({ model: 'copilot/gpt-5.3-codex' }));
    const result = stripRedundantModelPrefixInBody(body, 'copilot');
    expect(JSON.parse(result.toString('utf8')).model).toBe('gpt-5.3-codex');
  });

  it('returns null when the model has no redundant prefix', () => {
    const body = Buffer.from(JSON.stringify({ model: 'auto' }));
    expect(stripRedundantModelPrefixInBody(body, 'copilot')).toBeNull();
  });

  it('returns null when the prefix does not match the current provider', () => {
    const body = Buffer.from(JSON.stringify({ model: 'openai/gpt-4o' }));
    expect(stripRedundantModelPrefixInBody(body, 'copilot')).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(stripRedundantModelPrefixInBody(Buffer.alloc(0), 'copilot')).toBeNull();
    expect(stripRedundantModelPrefixInBody(null, 'copilot')).toBeNull();
  });

  it('returns null for a non-JSON body', () => {
    const body = Buffer.from('not json');
    expect(stripRedundantModelPrefixInBody(body, 'copilot')).toBeNull();
  });

  it('returns null when the body has no model field', () => {
    const body = Buffer.from(JSON.stringify({ messages: [] }));
    expect(stripRedundantModelPrefixInBody(body, 'copilot')).toBeNull();
  });
});
