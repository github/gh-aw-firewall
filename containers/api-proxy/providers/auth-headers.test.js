'use strict';

const { bearerAuthHeaders, providerKeyHeaders, withCopilotIntegration } = require('./auth-headers');

describe('bearerAuthHeaders', () => {
  it('builds an Authorization: Bearer ... header', () => {
    expect(bearerAuthHeaders('my-token')).toEqual({ 'Authorization': 'Bearer my-token' });
  });

  it('merges extra headers alongside the Authorization header', () => {
    expect(bearerAuthHeaders('tok', { 'Copilot-Integration-Id': 'awf' })).toEqual({
      'Authorization': 'Bearer tok',
      'Copilot-Integration-Id': 'awf',
    });
  });

  it('does not mutate the extraHeaders argument', () => {
    const extra = { 'x-custom': 'val' };
    const result = bearerAuthHeaders('tok', extra);
    expect(result).toEqual({ 'Authorization': 'Bearer tok', 'x-custom': 'val' });
    expect(extra).toEqual({ 'x-custom': 'val' });
  });
});

describe('providerKeyHeaders', () => {
  it('builds a header using the given header name', () => {
    expect(providerKeyHeaders('x-goog-api-key', 'goog-key')).toEqual({ 'x-goog-api-key': 'goog-key' });
  });

  it('supports api-key (Azure BYOK) header name', () => {
    expect(providerKeyHeaders('api-key', 'az-key')).toEqual({ 'api-key': 'az-key' });
  });

  it('merges extra headers alongside the provider key header', () => {
    expect(providerKeyHeaders('x-api-key', 'anth-key', { 'anthropic-version': '2023-06-01' })).toEqual({
      'x-api-key': 'anth-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('does not mutate the extraHeaders argument', () => {
    const extra = { 'content-type': 'application/json' };
    providerKeyHeaders('x-api-key', 'k', extra);
    expect(extra).toEqual({ 'content-type': 'application/json' });
  });
});

describe('withCopilotIntegration', () => {
  it('adds Copilot-Integration-Id to an existing header object', () => {
    const base = { 'Authorization': 'Bearer static-tok' };
    expect(withCopilotIntegration(base, 'agentic-workflows')).toEqual({
      'Authorization': 'Bearer static-tok',
      'Copilot-Integration-Id': 'agentic-workflows',
    });
  });

  it('does not mutate the base headers argument', () => {
    const base = { 'Authorization': 'Bearer static-tok' };
    withCopilotIntegration(base, 'my-integration');
    expect(base).toEqual({ 'Authorization': 'Bearer static-tok' });
  });

  it('composes naturally with bearerAuthHeaders', () => {
    const headers = withCopilotIntegration(bearerAuthHeaders('my-tok'), 'awf');
    expect(headers).toEqual({
      'Authorization': 'Bearer my-tok',
      'Copilot-Integration-Id': 'awf',
    });
  });
});
