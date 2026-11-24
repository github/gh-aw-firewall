'use strict';

const {
  tokenAuthHeaders,
  bearerAuthHeaders,
  providerKeyHeaders,
  withCopilotIntegration,
  buildAuthHeaderFn,
  buildStaticAuthHeaderFn,
  validateAuthSchemeEnv,
} = require('./auth-headers');

describe('static auth schemes', () => {
  it.each(['Bearer', 'Basic', 'token', "custom!#$%&'*+-.^_`|~"])('accepts HTTP token scheme %s', scheme => {
    expect(validateAuthSchemeEnv('AWF_OPENAI_AUTH_SCHEME', scheme)).toBe(scheme);
  });
  it.each([['Bearer', 'extra'].join(' '), 'Bearer\r\nX-Header: injected', ' Bearer', 'Bearer ', 'Basic:', 'Béarér', '\t'])('rejects invalid scheme %p without echoing it', scheme => {
    expect(() => validateAuthSchemeEnv('AWF_OPENAI_AUTH_SCHEME', scheme)).toThrow('Invalid AWF_OPENAI_AUTH_SCHEME value: expected an HTTP authentication scheme token');
  });
  it.each([undefined, ''])('preserves defaults for scheme %p', scheme => {
    expect(validateAuthSchemeEnv('AWF_OPENAI_AUTH_SCHEME', scheme)).toBe('');
    expect(buildStaticAuthHeaderFn({ scheme })('key')).toEqual(bearerAuthHeaders('key'));
    expect(buildStaticAuthHeaderFn({ scheme, defaultHeaderName: 'x-api-key' })('key')).toEqual(providerKeyHeaders('x-api-key', 'key'));
  });
  it.each([undefined, 'x-workspace-key'])('uses explicit scheme with header %p and avoids double-prefixing case-insensitively', headerName => {
    const build = buildStaticAuthHeaderFn({ scheme: 'Basic', headerName, defaultHeaderName: 'x-api-key' });
    expect(build('synthetic-key')).toEqual({ [headerName || 'Authorization']: 'Basic synthetic-key' });
    expect(build('bAsIc synthetic-key')).toEqual({ [headerName || 'Authorization']: 'bAsIc synthetic-key' });
    expect(build('bAsIc\tsynthetic-key')).toEqual({ [headerName || 'Authorization']: 'bAsIc\tsynthetic-key' });
    expect(build('BasicOther synthetic-key')).toEqual({ [headerName || 'Authorization']: 'Basic BasicOther synthetic-key' });
  });
  it('rejects credential header injection without reflecting the key', () => {
    expect(() => buildStaticAuthHeaderFn({ scheme: 'Basic' })('synthetic-secret\r\nX-Evil: yes')).toThrow('Invalid static authentication credential: expected a safe HTTP header value');
  });
});

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

describe('tokenAuthHeaders', () => {
  it('builds an Authorization header using the given prefix and token', () => {
    expect(tokenAuthHeaders('token', 'gh-tok')).toEqual({ 'Authorization': 'token gh-tok' });
  });


  it('merges extra headers alongside the Authorization header', () => {
    expect(tokenAuthHeaders('token', 'gh-tok', { 'X-GitHub-Api-Version': '2026-07-01' })).toEqual({
      'X-GitHub-Api-Version': '2026-07-01',
      'Authorization': 'token gh-tok',
    });
  });

  it('does not mutate the extraHeaders argument', () => {
    const extra = { 'x-custom': 'val' };
    tokenAuthHeaders('token', 'gh-tok', extra);
    expect(extra).toEqual({ 'x-custom': 'val' });
  });

  it('is the basis for bearerAuthHeaders', () => {
    expect(bearerAuthHeaders('tok')).toEqual(tokenAuthHeaders('Bearer', 'tok'));
  });
});

describe('buildAuthHeaderFn', () => {
  it('defaults to an Authorization/Bearer-style header when no options are given', () => {
    const build = buildAuthHeaderFn();
    expect(build('tok')).toEqual(tokenAuthHeaders('Bearer', 'tok'));
  });

  it('uses the given prefix when headerName is not set', () => {
    const build = buildAuthHeaderFn({ prefix: 'token' });
    expect(build('gh-tok')).toEqual(tokenAuthHeaders('token', 'gh-tok'));
  });

  it('builds a provider key header when headerName is set, ignoring prefix', () => {
    const build = buildAuthHeaderFn({ headerName: 'api-key', prefix: 'token' });
    expect(build('az-key')).toEqual(providerKeyHeaders('api-key', 'az-key'));
  });

  it('merges extra headers alongside the built Authorization header', () => {
    const build = buildAuthHeaderFn({ prefix: 'token' });
    expect(build('gh-tok', { 'X-GitHub-Api-Version': '2026-07-01' })).toEqual(
      tokenAuthHeaders('token', 'gh-tok', { 'X-GitHub-Api-Version': '2026-07-01' })
    );
  });

  it('merges extra headers alongside the built provider key header', () => {
    const build = buildAuthHeaderFn({ headerName: 'x-goog-api-key' });
    expect(build('goog-key', { 'x-extra': 'v' })).toEqual(
      providerKeyHeaders('x-goog-api-key', 'goog-key', { 'x-extra': 'v' })
    );
  });
});
