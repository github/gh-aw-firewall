/**
 * Tests for auth & credential handling.
 *
 * Extracted from server.test.js lines 491–523, 886–1064.
 */

const { shouldStripHeader } = require('./proxy-utils');
const {
  _testing: {
    resolveCopilotAuthToken,
    resolveApiKey,
    stripBearerPrefix,
    COPILOT_PLACEHOLDER_TOKEN,
    parseByokExtraHeaders,
    parseByokExtraBodyFields,
  },
  createCopilotAdapter,
} = require('./providers/copilot');
const { createAnthropicAdapter } = require('./providers/anthropic');
const { sanitizeNullToolCallTypes } = require('./body-transform');

describe('shouldStripHeader', () => {
  it('should strip authorization header', () => {
    expect(shouldStripHeader('authorization')).toBe(true);
    expect(shouldStripHeader('Authorization')).toBe(true);
  });

  it('should strip x-api-key header', () => {
    expect(shouldStripHeader('x-api-key')).toBe(true);
    expect(shouldStripHeader('X-Api-Key')).toBe(true);
  });

  it('should strip x-goog-api-key header (Gemini placeholder must be stripped)', () => {
    expect(shouldStripHeader('x-goog-api-key')).toBe(true);
    expect(shouldStripHeader('X-Goog-Api-Key')).toBe(true);
  });

  it('should strip proxy-authorization header', () => {
    expect(shouldStripHeader('proxy-authorization')).toBe(true);
  });

  it('should strip x-forwarded-* headers', () => {
    expect(shouldStripHeader('x-forwarded-for')).toBe(true);
    expect(shouldStripHeader('x-forwarded-host')).toBe(true);
  });

  it('should not strip content-type header', () => {
    expect(shouldStripHeader('content-type')).toBe(false);
  });

  it('should not strip anthropic-version header', () => {
    expect(shouldStripHeader('anthropic-version')).toBe(false);
  });
});

describe('stripBearerPrefix', () => {
  it('strips "Bearer " prefix from a token value', () => {
    expect(stripBearerPrefix('Bearer sk-or-v1-abc')).toBe('sk-or-v1-abc');
  });

  it('strips "Bearer " prefix case-insensitively', () => {
    expect(stripBearerPrefix('bearer sk-or-v1-abc')).toBe('sk-or-v1-abc');
    expect(stripBearerPrefix('BEARER sk-or-v1-abc')).toBe('sk-or-v1-abc');
  });

  it('strips "token " prefix case-insensitively', () => {
    expect(stripBearerPrefix('token sk-or-v1-abc')).toBe('sk-or-v1-abc');
    expect(stripBearerPrefix('TOKEN sk-or-v1-abc')).toBe('sk-or-v1-abc');
  });

  it('strips leading whitespace before "Bearer "', () => {
    expect(stripBearerPrefix('  Bearer sk-or-v1-abc')).toBe('sk-or-v1-abc');
  });

  it('returns value unchanged when no "Bearer " prefix is present', () => {
    expect(stripBearerPrefix('sk-or-v1-abc')).toBe('sk-or-v1-abc');
    expect(stripBearerPrefix('gho_abc123')).toBe('gho_abc123');
  });

  it('does not strip "Bearer" without a following space', () => {
    expect(stripBearerPrefix('BearerToken123')).toBe('BearerToken123');
  });

  it('returns undefined when value is only "Bearer " (nothing after prefix)', () => {
    expect(stripBearerPrefix('Bearer ')).toBeUndefined();
    expect(stripBearerPrefix('Bearer   ')).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only input', () => {
    expect(stripBearerPrefix('')).toBeUndefined();
    expect(stripBearerPrefix('   ')).toBeUndefined();
    expect(stripBearerPrefix(undefined)).toBeUndefined();
  });

  it('trims surrounding whitespace from the token', () => {
    expect(stripBearerPrefix('  sk-or-v1-abc  ')).toBe('sk-or-v1-abc');
  });
});

describe('resolveCopilotAuthToken', () => {
  it('should return COPILOT_GITHUB_TOKEN when only it is set', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: 'gho_abc123' })).toBe('gho_abc123');
  });

  it('should return COPILOT_PROVIDER_API_KEY when only it is set', () => {
    expect(resolveCopilotAuthToken({ COPILOT_PROVIDER_API_KEY: 'sk-byok-key' })).toBe('sk-byok-key');
  });

  it('should prefer COPILOT_PROVIDER_API_KEY over COPILOT_GITHUB_TOKEN when both are set', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'gho_abc123',
      COPILOT_PROVIDER_API_KEY: 'sk-byok-key',
    })).toBe('sk-byok-key');
  });

  it('should return undefined when neither is set', () => {
    expect(resolveCopilotAuthToken({})).toBeUndefined();
  });

  it('should return undefined for empty strings', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: '', COPILOT_PROVIDER_API_KEY: '' })).toBeUndefined();
  });

  it('should return undefined for whitespace-only values', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: '  ', COPILOT_PROVIDER_API_KEY: '  \n' })).toBeUndefined();
  });

  it('should trim whitespace from token values', () => {
    expect(resolveCopilotAuthToken({ COPILOT_PROVIDER_API_KEY: '  sk-byok-key  ' })).toBe('sk-byok-key');
  });

  it('should use COPILOT_PROVIDER_API_KEY when COPILOT_GITHUB_TOKEN is whitespace-only', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: '  ',
      COPILOT_PROVIDER_API_KEY: 'sk-byok-key',
    })).toBe('sk-byok-key');
  });

  it('should fall back to COPILOT_GITHUB_TOKEN when COPILOT_PROVIDER_API_KEY is whitespace-only', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'gho_abc123',
      COPILOT_PROVIDER_API_KEY: '  ',
    })).toBe('gho_abc123');
  });

  it('strips "Bearer " prefix from COPILOT_PROVIDER_API_KEY when resolving', () => {
    expect(resolveCopilotAuthToken({ COPILOT_PROVIDER_API_KEY: 'Bearer sk-or-v1-abc' })).toBe('sk-or-v1-abc');
  });

  it('strips "Bearer " prefix from COPILOT_GITHUB_TOKEN when resolving', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: 'Bearer gho_abc123' })).toBe('gho_abc123');
  });

  it('prefers stripped COPILOT_PROVIDER_API_KEY over stripped COPILOT_GITHUB_TOKEN', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'Bearer gho_abc123',
      COPILOT_PROVIDER_API_KEY: 'Bearer sk-byok-key',
    })).toBe('sk-byok-key');
  });

  it('treats AWF placeholder COPILOT_PROVIDER_API_KEY as absent when no COPILOT_GITHUB_TOKEN is set', () => {
    expect(resolveCopilotAuthToken({ COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN })).toBeUndefined();
  });

  it('uses COPILOT_GITHUB_TOKEN when COPILOT_PROVIDER_API_KEY is the AWF placeholder', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'gho_real_token',
      COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN,
    })).toBe('gho_real_token');
  });
});

describe('resolveApiKey', () => {
  it('returns the API key when it is a real credential', () => {
    expect(resolveApiKey({ COPILOT_PROVIDER_API_KEY: 'sk-byok-key' })).toBe('sk-byok-key');
  });

  it('returns undefined when COPILOT_PROVIDER_API_KEY is the AWF placeholder', () => {
    expect(resolveApiKey({ COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN })).toBeUndefined();
  });

  it('returns undefined when COPILOT_PROVIDER_API_KEY is not set', () => {
    expect(resolveApiKey({})).toBeUndefined();
  });
});

describe('sanitizeNullToolCallTypes (via copilot body transform)', () => {
  it('normalizes null tool_call type to "function" in outgoing message history', () => {
    const input = Buffer.from(JSON.stringify({
      model: 'gpt-5.4',
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: null,
              function: { name: 'edit', arguments: '{"path":"a.txt"}' },
            },
          ],
        },
      ],
    }));

    const result = sanitizeNullToolCallTypes(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.messages[0].tool_calls[0].type).toBe('function');
  });

  it('returns null when no tool_call type normalization is needed', () => {
    const input = Buffer.from(JSON.stringify({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'edit', arguments: '{}' },
            },
          ],
        },
      ],
    }));

    expect(sanitizeNullToolCallTypes(input)).toBeNull();
  });
});

// ── createCopilotAdapter — BYOK auth header format ───────────────────────────
//
// These tests guard against the "badly formatted Authorization header" bug in
// BYOK mode where the sidecar is configured with COPILOT_PROVIDER_API_KEY (the real key
// held by the sidecar) and could produce "Authorization: Bearer Bearer <key>"
// if the COPILOT_PROVIDER_API_KEY value already contained the "Bearer " prefix.
// They also verify that the header injected for inference requests is exactly
// "Bearer <key>" and that the Copilot-Integration-Id header is present.

describe('createCopilotAdapter — BYOK getAuthHeaders', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };
  const fakeModelsReq = { url: '/models', method: 'GET', headers: {} };

  it('injects Authorization: Bearer <key> for BYOK inference request', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('injects Copilot-Integration-Id header for BYOK inference request', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Copilot-Integration-Id']).toBe('copilot-developer-cli');
  });

  it('prevents double "Bearer " prefix when API key already contains "Bearer " prefix (BYOK bug fix)', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: 'Bearer sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
    expect(headers['Authorization']).not.toContain('Bearer Bearer');
  });

  it('strips "Bearer " prefix case-insensitively from API key', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: 'BEARER sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('uses COPILOT_GITHUB_TOKEN (not COPILOT_PROVIDER_API_KEY) for /models GET in BYOK+token mode', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'gho_oauth_token',
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
    });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe('Bearer gho_oauth_token');
  });

  it('uses COPILOT_PROVIDER_API_KEY (not COPILOT_GITHUB_TOKEN) for inference in BYOK+token mode', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'gho_oauth_token',
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('uses API key for /models GET when no COPILOT_GITHUB_TOKEN is set (BYOK-only mode)', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('is enabled when only COPILOT_PROVIDER_API_KEY is set', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123' });
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
    expect(headers['Authorization']).toBe('Bearer gho_real_token');
  });

  it('uses custom COPILOT_INTEGRATION_ID when set', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
      COPILOT_INTEGRATION_ID: 'my-custom-integration',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Copilot-Integration-Id']).toBe('my-custom-integration');
  });

  it('uses COPILOT_API_BASE_PATH when configured', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
      COPILOT_API_BASE_PATH: '/api/v1/',
    });
    expect(adapter.getBasePath()).toBe('/api/v1');
  });

  it('defaults to empty base path when COPILOT_API_BASE_PATH is not set', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123' });
    expect(adapter.getBasePath()).toBe('');
  });
});

// ── parseByokExtraHeaders ─────────────────────────────────────────────────────

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

// ── parseByokExtraBodyFields ──────────────────────────────────────────────────

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

// ── createCopilotAdapter — AWF_BYOK_EXTRA_HEADERS injection ──────────────────

describe('createCopilotAdapter — AWF_BYOK_EXTRA_HEADERS injection', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };
  const fakeModelsReq = { url: '/models', method: 'GET', headers: {} };

  it('injects extra BYOK headers on inference request when BYOK API key is set', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"sess-42","HTTP-Referer":"https://example.com"}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['x-session-id']).toBe('sess-42');
    expect(headers['HTTP-Referer']).toBe('https://example.com');
  });

  it('does not override Authorization or Copilot-Integration-Id with extra headers', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
      AWF_BYOK_EXTRA_HEADERS: '{"Authorization":"malicious","Copilot-Integration-Id":"evil","x-session-id":"sess-1"}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
    expect(headers['Copilot-Integration-Id']).toBe('copilot-developer-cli');
    expect(headers['x-session-id']).toBe('sess-1');
    warnSpy.mockRestore();
  });

  it('does NOT inject extra headers when only GitHub OAuth token is set (no BYOK key)', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'gho_oauth_token',
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"sess-42"}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['x-session-id']).toBeUndefined();
  });

  it('does NOT inject extra headers on /models GET when GitHub OAuth token is available', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'gho_oauth_token',
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"sess-42"}',
    });
    // /models GET with GitHub token goes to GitHub Copilot — extra headers must not be sent there
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe('Bearer gho_oauth_token');
    expect(headers['x-session-id']).toBeUndefined();
  });

  it('injects extra BYOK headers on /models GET when only BYOK API key is set (no GitHub token)', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"sess-42"}',
    });
    // Without a GitHub token, /models GET uses the BYOK key and goes to the BYOK provider
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['x-session-id']).toBe('sess-42');
  });

  it('does not inject extra headers when AWF_BYOK_EXTRA_HEADERS is not set', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(Object.keys(headers)).toEqual(['Authorization', 'Copilot-Integration-Id']);
  });

  it('ignores invalid AWF_BYOK_EXTRA_HEADERS JSON and still authenticates normally', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
      AWF_BYOK_EXTRA_HEADERS: '{bad-json}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    warnSpy.mockRestore();
  });

  it('injects x-session-id header from AWF_PROVIDER_SESSION_ID by default in BYOK mode', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
      AWF_PROVIDER_SESSION_ID: 'run-42',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['x-session-id']).toBe('run-42');
  });

  it('does not override explicit x-session-id header when AWF_PROVIDER_SESSION_ID is set', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
      AWF_PROVIDER_SESSION_ID: 'run-default',
      AWF_BYOK_EXTRA_HEADERS: '{"x-session-id":"run-custom"}',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['x-session-id']).toBe('run-custom');
  });

  it('does not add duplicate x-session-id when user set it with different casing', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
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
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
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
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
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
      COPILOT_GITHUB_TOKEN: 'gho_oauth_token',
      AWF_BYOK_EXTRA_BODY_FIELDS: '{"session_id":"run-42"}',
    });
    const transform = adapter.getBodyTransform();
    const input = Buffer.from(JSON.stringify({ model: 'gpt-5.4', messages: [] }));
    const output = transform(input);
    expect(output).toBeNull();
  });
});

describe('createAnthropicAdapter — OIDC getAuthHeaders', () => {
  const fakeReq = { url: '/v1/messages', method: 'POST', headers: {} };

  it('injects Authorization header instead of x-api-key in Anthropic OIDC mode', () => {
    const adapter = createAnthropicAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
      AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid-test',
      AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
    });

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'sk-ant-oat01-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      Authorization: ['Bearer', 'sk-ant-oat01-token'].join(' '),
      'anthropic-version': '2023-06-01',
    });
    expect(headers['x-api-key']).toBeUndefined();

    provider.shutdown();
  });

  it('returns empty auth headers when Anthropic OIDC token is not yet available', () => {
    const adapter = createAnthropicAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
      AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid-test',
      AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
    });

    expect(adapter.getAuthHeaders(fakeReq)).toEqual({});
    adapter.getOidcProvider().shutdown();
  });

  it('passes AWF_AUTH_ANTHROPIC_TOKEN_URL to Anthropic OIDC provider', () => {
    const adapter = createAnthropicAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
      AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid-test',
      AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
      AWF_AUTH_ANTHROPIC_TOKEN_URL: 'https://anthropic.internal.example/v1/oauth/token',
    });

    expect(adapter.getOidcProvider()._tokenEndpoint).toBe('https://anthropic.internal.example/v1/oauth/token');
    adapter.getOidcProvider().shutdown();
  });
});
