const {
  _testing: {
    COPILOT_PLACEHOLDER_TOKEN,
    parseByokExtraHeaders,
    parseByokExtraBodyFields,
  },
} = require('./providers/copilot-byok');
const { createCopilotAdapter } = require('./providers/copilot');

const byokKey = 'sk-or-v1-abc123';
const githubToken = 'gho_oauth_token';
const bearerByokKey = ['Bearer', byokKey].join(' ');
const bearerGithubToken = ['Bearer', githubToken].join(' ');

describe('parseByokExtraHeaders', () => {
  it('returns empty object for undefined input', () => {
    expect(parseByokExtraHeaders(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseByokExtraHeaders('')).toEqual({});
  });

  it('returns empty object for whitespace-only string', () => {
    expect(parseByokExtraHeaders('   ')).toEqual({});
  });

  it('parses a valid JSON object of string headers', () => {
    const result = parseByokExtraHeaders('{"x-session-id":"sess-123","HTTP-Referer":"https://example.com"}');
    expect(result).toEqual({
      'x-session-id': 'sess-123',
      'HTTP-Referer': 'https://example.com',
    });
  });

  it('returns empty object and warns for invalid JSON', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseByokExtraHeaders('{not-valid-json}');
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    warnSpy.mockRestore();
  });

  it('returns empty object and warns when value is a JSON array (not object)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseByokExtraHeaders('["x-session-id","value"]');
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('expected a JSON object'));
    warnSpy.mockRestore();
  });

  it('returns empty object and warns when value is a JSON string (not object)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseByokExtraHeaders('"just-a-string"');
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('expected a JSON object'));
    warnSpy.mockRestore();
  });

  it('skips auth-critical header "authorization" with a warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseByokExtraHeaders('{"authorization":"******","x-session-id":"sess-1"}');
    expect(result).not.toHaveProperty('authorization');
    expect(result['x-session-id']).toBe('sess-1');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('auth-critical'));
    warnSpy.mockRestore();
  });

  it('skips auth-critical header "Authorization" (case-insensitive) with a warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseByokExtraHeaders('{"Authorization":"******"}');
    expect(result).not.toHaveProperty('Authorization');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('auth-critical'));
    warnSpy.mockRestore();
  });

  it('skips auth-critical header "x-api-key" with a warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseByokExtraHeaders('{"x-api-key":"leaked-key"}');
    expect(result).not.toHaveProperty('x-api-key');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('auth-critical'));
    warnSpy.mockRestore();
  });

  it('skips invalid HTTP header names with a warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseByokExtraHeaders('{"invalid header name":"value","x-valid":"ok"}');
    expect(result).not.toHaveProperty('invalid header name');
    expect(result['x-valid']).toBe('ok');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a valid HTTP header name'));
    warnSpy.mockRestore();
  });

  it('skips entries with non-string values with a warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseByokExtraHeaders('{"x-count":42,"x-session-id":"sess-1"}');
    expect(result).not.toHaveProperty('x-count');
    expect(result['x-session-id']).toBe('sess-1');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('must be a string'));
    warnSpy.mockRestore();
  });
});

describe('parseByokExtraBodyFields', () => {
  it('returns empty object for undefined input', () => {
    expect(parseByokExtraBodyFields(undefined)).toEqual({});
  });

  it('returns empty object for invalid JSON', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseByokExtraBodyFields('{bad-json}')).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    warnSpy.mockRestore();
  });

  it('parses a valid JSON string map', () => {
    expect(parseByokExtraBodyFields('{"session_id":"run-42","user_id":"octocat"}')).toEqual({
      session_id: 'run-42',
      user_id: 'octocat',
    });
  });

  it('skips entries with non-string values', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseByokExtraBodyFields('{"session_id":"run-42","attempt":1}');
    expect(result).toEqual({ session_id: 'run-42' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('must be a string'));
    warnSpy.mockRestore();
  });
});

describe('createCopilotAdapter — BYOK getAuthHeaders', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };
  const fakeModelsReq = { url: '/models', method: 'GET', headers: {} };

  it('injects Authorization: Bearer token from BYOK key for inference request', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: byokKey });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerByokKey);
  });

  it('injects Copilot-Integration-Id header for BYOK inference request', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: byokKey });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Copilot-Integration-Id']).toBe('agentic-workflows');
  });

  it('prevents double "Bearer " prefix when API key already contains "Bearer " prefix (BYOK bug fix)', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: bearerByokKey });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerByokKey);
    expect(headers['Authorization']).not.toContain(['Bearer', 'Bearer'].join(' '));
  });

  it('strips "Bearer " prefix case-insensitively from API key', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: `BEARER ${byokKey}` });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerByokKey);
  });

  it('uses COPILOT_GITHUB_TOKEN (not COPILOT_PROVIDER_API_KEY) for /models GET in BYOK+token mode', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: githubToken,
      COPILOT_PROVIDER_API_KEY: byokKey,
    });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe(bearerGithubToken);
  });

  it('uses COPILOT_PROVIDER_API_KEY (not COPILOT_GITHUB_TOKEN) for inference in BYOK+token mode', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: githubToken,
      COPILOT_PROVIDER_API_KEY: byokKey,
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerByokKey);
  });

  it('uses API key for /models GET when no COPILOT_GITHUB_TOKEN is set (BYOK-only mode)', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: byokKey });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe(bearerByokKey);
  });

  it('is enabled when only COPILOT_PROVIDER_API_KEY is set', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: byokKey });
    expect(adapter.isEnabled()).toBe(true);
  });

  it('is disabled when COPILOT_PROVIDER_API_KEY is the AWF placeholder and no COPILOT_GITHUB_TOKEN is set', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN });
    expect(adapter.isEnabled()).toBe(false);
  });

  it('is enabled when COPILOT_PROVIDER_API_KEY is the AWF placeholder but COPILOT_GITHUB_TOKEN is set', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'gho_real_token',
      COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN,
    });
    expect(adapter.isEnabled()).toBe(true);
  });

  it('uses COPILOT_GITHUB_TOKEN for inference when COPILOT_PROVIDER_API_KEY is the AWF placeholder', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'gho_real_token',
      COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN,
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(['Bearer', 'gho_real_token'].join(' '));
  });

  it('uses custom COPILOT_INTEGRATION_ID when set', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      COPILOT_INTEGRATION_ID: 'my-custom-integration',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Copilot-Integration-Id']).toBe('my-custom-integration');
  });

  it('uses COPILOT_API_BASE_PATH when configured', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      COPILOT_API_BASE_PATH: '/api/v1/',
    });
    expect(adapter.getBasePath()).toBe('/api/v1');
  });

  it('defaults to empty base path when COPILOT_API_BASE_PATH is not set', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: byokKey });
    expect(adapter.getBasePath()).toBe('');
  });
});

describe('createCopilotAdapter — AWF_BYOK_EXTRA_HEADERS injection', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };
  const fakeModelsReq = { url: '/models', method: 'GET', headers: {} };

  it('injects extra BYOK headers on inference request when BYOK API key is set', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"sess-42","HTTP-Referer":"https://example.com"}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['x-session-id']).toBe('sess-42');
    expect(headers['HTTP-Referer']).toBe('https://example.com');
  });

  it('does not override Authorization or Copilot-Integration-Id with extra headers', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_BYOK_EXTRA_HEADERS: '{"Authorization":"malicious","Copilot-Integration-Id":"evil","x-session-id":"sess-1"}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerByokKey);
    expect(headers['Copilot-Integration-Id']).toBe('agentic-workflows');
    expect(headers['x-session-id']).toBe('sess-1');
    warnSpy.mockRestore();
  });

  it('does NOT inject extra headers when only GitHub OAuth token is set (no BYOK key)', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: githubToken,
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"sess-42"}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['x-session-id']).toBeUndefined();
  });

  it('does NOT inject extra headers on /models GET when GitHub OAuth token is available', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: githubToken,
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"sess-42"}',
    });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe(bearerGithubToken);
    expect(headers['x-session-id']).toBeUndefined();
  });

  it('injects extra BYOK headers on /models GET when only BYOK API key is set (no GitHub token)', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"sess-42"}',
    });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['x-session-id']).toBe('sess-42');
  });

  it('does not inject extra headers when AWF_BYOK_EXTRA_HEADERS is not set', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: byokKey });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(Object.keys(headers)).toEqual(['Authorization', 'Copilot-Integration-Id']);
  });

  it('ignores invalid AWF_BYOK_EXTRA_HEADERS JSON and still authenticates normally', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_BYOK_EXTRA_HEADERS: '{bad-json}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerByokKey);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    warnSpy.mockRestore();
  });

  it('injects x-session-id header from AWF_PROVIDER_SESSION_ID by default in BYOK mode', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_PROVIDER_SESSION_ID: 'run-42',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['x-session-id']).toBe('run-42');
  });

  it('does not override explicit x-session-id header when AWF_PROVIDER_SESSION_ID is set', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_PROVIDER_SESSION_ID: 'run-default',
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"run-custom"}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['x-session-id']).toBe('run-custom');
  });

  it('does not add duplicate x-session-id when user set it with different casing', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_PROVIDER_SESSION_ID: 'run-default',
      AWF_BYOK_EXTRA_HEADERS: '{"X-Session-Id":"run-custom"}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['X-Session-Id']).toBe('run-custom');
    expect(headers['x-session-id']).toBeUndefined();
  });
});

describe('createCopilotAdapter — AWF_BYOK_EXTRA_BODY_FIELDS injection', () => {
  it('injects extra body fields in BYOK mode without overriding existing values', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_BYOK_EXTRA_BODY_FIELDS: '{"session_id":"run-42","user_id":"octocat"}',
    });
    const transform = adapter.getBodyTransform();
    const input = Buffer.from(JSON.stringify({ model: 'gpt-5.4', session_id: 'client-session', messages: [] }));
    const output = transform(input);
    expect(output).not.toBeNull();
    const parsed = JSON.parse(output.toString('utf8'));
    expect(parsed.session_id).toBe('client-session');
    expect(parsed.user_id).toBe('octocat');
  });

  it('injects default session_id body field from AWF_PROVIDER_SESSION_ID in BYOK mode', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: byokKey,
      AWF_PROVIDER_SESSION_ID: 'run-42',
    });
    const transform = adapter.getBodyTransform();
    const input = Buffer.from(JSON.stringify({ model: 'gpt-5.4', messages: [] }));
    const output = transform(input);
    expect(output).not.toBeNull();
    const parsed = JSON.parse(output.toString('utf8'));
    expect(parsed.session_id).toBe('run-42');
  });

  it('does not inject body fields when only GitHub OAuth token is configured', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: githubToken,
      AWF_BYOK_EXTRA_BODY_FIELDS: '{"session_id":"run-42"}',
    });
    const transform = adapter.getBodyTransform();
    const input = Buffer.from(JSON.stringify({ model: 'gpt-5.4', messages: [] }));
    const output = transform(input);
    expect(output).toBeNull();
  });
});
