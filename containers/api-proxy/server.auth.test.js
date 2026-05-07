/**
 * Tests for auth & credential handling.
 *
 * Extracted from server.test.js lines 491–523, 886–1064.
 */

const { shouldStripHeader } = require('./proxy-utils');
const { resolveCopilotAuthToken, stripBearerPrefix, createCopilotAdapter } = require('./providers/copilot');

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

  it('should return COPILOT_API_KEY when only it is set', () => {
    expect(resolveCopilotAuthToken({ COPILOT_API_KEY: 'sk-byok-key' })).toBe('sk-byok-key');
  });

  it('should prefer COPILOT_GITHUB_TOKEN over COPILOT_API_KEY when both are set', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'gho_abc123',
      COPILOT_API_KEY: 'sk-byok-key',
    })).toBe('gho_abc123');
  });

  it('should return undefined when neither is set', () => {
    expect(resolveCopilotAuthToken({})).toBeUndefined();
  });

  it('should return undefined for empty strings', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: '', COPILOT_API_KEY: '' })).toBeUndefined();
  });

  it('should return undefined for whitespace-only values', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: '  ', COPILOT_API_KEY: '  \n' })).toBeUndefined();
  });

  it('should trim whitespace from token values', () => {
    expect(resolveCopilotAuthToken({ COPILOT_API_KEY: '  sk-byok-key  ' })).toBe('sk-byok-key');
  });

  it('should fall back to COPILOT_API_KEY when COPILOT_GITHUB_TOKEN is whitespace-only', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: '  ',
      COPILOT_API_KEY: 'sk-byok-key',
    })).toBe('sk-byok-key');
  });

  it('strips "Bearer " prefix from COPILOT_API_KEY when resolving', () => {
    expect(resolveCopilotAuthToken({ COPILOT_API_KEY: 'Bearer sk-or-v1-abc' })).toBe('sk-or-v1-abc');
  });

  it('strips "Bearer " prefix from COPILOT_GITHUB_TOKEN when resolving', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: 'Bearer gho_abc123' })).toBe('gho_abc123');
  });

  it('prefers stripped COPILOT_GITHUB_TOKEN over stripped COPILOT_API_KEY', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'Bearer gho_abc123',
      COPILOT_API_KEY: 'Bearer sk-byok-key',
    })).toBe('gho_abc123');
  });
});

// ── createCopilotAdapter — BYOK auth header format ───────────────────────────
//
// These tests guard against the "badly formatted Authorization header" bug in
// BYOK mode where the sidecar is configured with COPILOT_API_KEY (the real key
// held by the sidecar) and could produce "Authorization: Bearer Bearer <key>"
// if the COPILOT_API_KEY value already contained the "Bearer " prefix.
// They also verify that the header injected for inference requests is exactly
// "Bearer <key>" and that the Copilot-Integration-Id header is present.

describe('createCopilotAdapter — BYOK getAuthHeaders', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };
  const fakeModelsReq = { url: '/models', method: 'GET', headers: {} };

  it('injects Authorization: Bearer <key> for BYOK inference request', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('injects Copilot-Integration-Id header for BYOK inference request', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Copilot-Integration-Id']).toBe('copilot-developer-cli');
  });

  it('prevents double "Bearer " prefix when API key already contains "Bearer " prefix (BYOK bug fix)', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'Bearer sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
    expect(headers['Authorization']).not.toContain('Bearer Bearer');
  });

  it('strips "Bearer " prefix case-insensitively from API key', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'BEARER sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('uses COPILOT_GITHUB_TOKEN (not COPILOT_API_KEY) for /models GET in BYOK+token mode', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'gho_oauth_token',
      COPILOT_API_KEY: 'sk-or-v1-abc123',
    });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe('Bearer gho_oauth_token');
  });

  it('uses API key for /models GET when no GITHUB_TOKEN is set (BYOK-only mode)', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('is enabled when only COPILOT_API_KEY is set', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-or-v1-abc123' });
    expect(adapter.isEnabled()).toBe(true);
  });

  it('uses custom COPILOT_INTEGRATION_ID when set', () => {
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-or-v1-abc123',
      COPILOT_INTEGRATION_ID: 'my-custom-integration',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Copilot-Integration-Id']).toBe('my-custom-integration');
  });

  it('uses COPILOT_API_BASE_PATH when configured', () => {
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-or-v1-abc123',
      COPILOT_API_BASE_PATH: '/api/v1/',
    });
    expect(adapter.getBasePath()).toBe('/api/v1');
  });

  it('defaults to empty base path when COPILOT_API_BASE_PATH is not set', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-or-v1-abc123' });
    expect(adapter.getBasePath()).toBe('');
  });
});
