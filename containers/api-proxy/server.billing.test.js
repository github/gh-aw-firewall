/**
 * Tests for API key validation and billing header extraction.
 *
 * Extracted from server.test.js during test-file refactoring.
 */

const https = require('https');
const { EventEmitter } = require('events');

const { validateApiKeys, keyValidationResults, resetKeyValidationState, extractBillingHeaders } = require('./server');

// ── Helpers for validateApiKeys tests ──────────────────────────────────────────

/**
 * Create a mock https.request implementation that responds with the given status code.
 */
function mockHttpsRequestWithStatus(statusCode) {
  return jest.spyOn(https, 'request').mockImplementation((options, callback) => {
    const req = new EventEmitter();
    req.write = jest.fn();
    req.end = jest.fn(() => {
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.resume = jest.fn();
        callback(res);
        setImmediate(() => res.emit('end'));
      });
    });
    req.destroy = jest.fn();
    return req;
  });
}

/**
 * Collect structured log lines emitted by logRequest() (written to process.stdout).
 */
function collectLogOutput() {
  const lines = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((data) => {
    try {
      lines.push(JSON.parse(data.toString()));
    } catch {
      // ignore non-JSON writes
    }
    return true;
  });
  return { lines, spy };
}

describe('validateApiKeys', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetKeyValidationState();
  });

  // ── OpenAI ─────────────────────────────────────────────────────────────────

  it('marks OpenAI valid when probe returns 200', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(200);
    await validateApiKeys({ openaiKey: 'sk-test', openaiTarget: 'api.openai.com' });
    expect(keyValidationResults.openai.status).toBe('valid');
    const log = lines.find(l => l.provider === 'openai' && l.status === 'valid');
    expect(log).toBeDefined();
  });

  it('marks OpenAI auth_rejected when probe returns 401', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(401);
    await validateApiKeys({ openaiKey: 'sk-bad', openaiTarget: 'api.openai.com' });
    expect(keyValidationResults.openai.status).toBe('auth_rejected');
    const failLog = lines.find(l => l.event === 'key_validation_failed' && l.provider === 'openai');
    expect(failLog).toBeDefined();
    expect(failLog.level).toBe('error');
  });

  it('skips OpenAI for custom API target', async () => {
    const { lines } = collectLogOutput();
    await validateApiKeys({ openaiKey: 'sk-test', openaiTarget: 'my-llm-router.internal' });
    expect(keyValidationResults.openai.status).toBe('skipped');
    const log = lines.find(l => l.provider === 'openai' && l.status === 'skipped');
    expect(log).toBeDefined();
  });

  it('does not validate OpenAI when key is not provided', async () => {
    collectLogOutput();
    const spy = jest.spyOn(https, 'request');
    await validateApiKeys({ openaiKey: undefined });
    expect(keyValidationResults.openai).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  // ── Anthropic ──────────────────────────────────────────────────────────────

  it('marks Anthropic valid when probe returns 400 (key valid, body incomplete)', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(400);
    await validateApiKeys({ anthropicKey: 'sk-ant-test', anthropicTarget: 'api.anthropic.com' });
    expect(keyValidationResults.anthropic.status).toBe('valid');
    const log = lines.find(l => l.provider === 'anthropic' && l.status === 'valid');
    expect(log).toBeDefined();
    expect(log.note).toContain('probe body rejected');
  });

  it('marks Anthropic auth_rejected when probe returns 401', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(401);
    await validateApiKeys({ anthropicKey: 'sk-ant-bad', anthropicTarget: 'api.anthropic.com' });
    expect(keyValidationResults.anthropic.status).toBe('auth_rejected');
    const failLog = lines.find(l => l.event === 'key_validation_failed' && l.provider === 'anthropic');
    expect(failLog).toBeDefined();
  });

  it('marks Anthropic auth_rejected when probe returns 403', async () => {
    mockHttpsRequestWithStatus(403);
    await validateApiKeys({ anthropicKey: 'sk-ant-bad', anthropicTarget: 'api.anthropic.com' });
    expect(keyValidationResults.anthropic.status).toBe('auth_rejected');
  });

  it('skips Anthropic for custom API target', async () => {
    const { lines } = collectLogOutput();
    await validateApiKeys({ anthropicKey: 'sk-ant-test', anthropicTarget: 'proxy.corp.internal' });
    expect(keyValidationResults.anthropic.status).toBe('skipped');
    const log = lines.find(l => l.provider === 'anthropic' && l.status === 'skipped');
    expect(log).toBeDefined();
  });

  // ── Copilot ────────────────────────────────────────────────────────────────

  it('marks Copilot valid when probe returns 200 with non-classic token', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(200);
    await validateApiKeys({
      copilotGithubToken: 'ghu_valid_token',
      copilotTarget: 'api.githubcopilot.com',
      copilotIntegrationId: 'copilot-developer-cli',
    });
    expect(keyValidationResults.copilot.status).toBe('valid');
    const log = lines.find(l => l.provider === 'copilot' && l.status === 'valid');
    expect(log).toBeDefined();
  });

  it('marks Copilot auth_rejected when probe returns 401', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(401);
    await validateApiKeys({
      copilotGithubToken: 'ghu_invalid',
      copilotTarget: 'api.githubcopilot.com',
      copilotIntegrationId: 'copilot-developer-cli',
    });
    expect(keyValidationResults.copilot.status).toBe('auth_rejected');
    const failLog = lines.find(l => l.event === 'key_validation_failed' && l.provider === 'copilot');
    expect(failLog).toBeDefined();
  });

  it('skips Copilot for custom API target', async () => {
    const { lines } = collectLogOutput();
    await validateApiKeys({
      copilotGithubToken: 'ghu_valid',
      copilotTarget: 'copilot-api.mycompany.ghe.com',
      copilotIntegrationId: 'copilot-developer-cli',
    });
    expect(keyValidationResults.copilot.status).toBe('skipped');
    const log = lines.find(l => l.provider === 'copilot' && l.status === 'skipped');
    expect(log).toBeDefined();
  });

  it('skips Copilot when only COPILOT_API_KEY is set (BYOK mode)', async () => {
    collectLogOutput();
    const spy = jest.spyOn(https, 'request');
    await validateApiKeys({
      copilotGithubToken: undefined,
      copilotApiKey: 'sk-byok-key',
      copilotTarget: 'api.githubcopilot.com',
    });
    expect(keyValidationResults.copilot.status).toBe('skipped');
    expect(keyValidationResults.copilot.message).toContain('COPILOT_API_KEY');
    expect(spy).not.toHaveBeenCalled();
  });

  // ── Gemini ─────────────────────────────────────────────────────────────────

  it('marks Gemini valid when probe returns 200', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(200);
    await validateApiKeys({ geminiKey: 'ai-test-key', geminiTarget: 'generativelanguage.googleapis.com' });
    expect(keyValidationResults.gemini.status).toBe('valid');
    const log = lines.find(l => l.provider === 'gemini' && l.status === 'valid');
    expect(log).toBeDefined();
  });

  it('marks Gemini auth_rejected when probe returns 403', async () => {
    mockHttpsRequestWithStatus(403);
    await validateApiKeys({ geminiKey: 'ai-bad-key', geminiTarget: 'generativelanguage.googleapis.com' });
    expect(keyValidationResults.gemini.status).toBe('auth_rejected');
  });

  it('skips Gemini for custom API target', async () => {
    const { lines } = collectLogOutput();
    await validateApiKeys({ geminiKey: 'ai-test', geminiTarget: 'my-vertex-endpoint.internal' });
    expect(keyValidationResults.gemini.status).toBe('skipped');
    const log = lines.find(l => l.provider === 'gemini' && l.status === 'skipped');
    expect(log).toBeDefined();
  });

  // ── Cross-cutting ──────────────────────────────────────────────────────────

  it('handles network_error when probe times out', async () => {
    collectLogOutput();
    jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      const req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn(); // never responds
      req.destroy = jest.fn((err) => {
        setImmediate(() => req.emit('error', err || new Error('socket hang up')));
      });
      // Simulate Node's built-in timeout: fire 'timeout' event after the requested delay
      if (options.timeout) {
        setTimeout(() => req.emit('timeout'), options.timeout);
      }
      return req;
    });
    await validateApiKeys({
      openaiKey: 'sk-test',
      openaiTarget: 'api.openai.com',
      timeoutMs: 50,
    });
    expect(keyValidationResults.openai.status).toBe('network_error');
  }, 5000);

  it('does not validate any provider when no keys are provided', async () => {
    collectLogOutput();
    const spy = jest.spyOn(https, 'request');
    await validateApiKeys({
      openaiKey: undefined,
      anthropicKey: undefined,
      copilotGithubToken: undefined,
      copilotApiKey: undefined,
      geminiKey: undefined,
    });
    expect(Object.keys(keyValidationResults)).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('extractBillingHeaders', () => {
  it('returns null when no billing headers present', () => {
    expect(extractBillingHeaders({ 'content-type': 'application/json' })).toBeNull();
  });

  it('extracts X-Quota-Snapshot-Premium-Chat header', () => {
    const headers = {
      'x-quota-snapshot-premium-chat': 'ent=50&ov=0.0&ovPerm=false&rem=48.5&rst=2025-12-15T23%3A59%3A59Z',
    };
    const result = extractBillingHeaders(headers);
    expect(result).not.toBeNull();
    expect(result['quota_premium-chat']).toEqual({
      ent: '50',
      ov: '0.0',
      ovPerm: 'false',
      rem: '48.5',
      rst: '2025-12-15T23:59:59Z',
    });
  });

  it('extracts multiple quota snapshot headers', () => {
    const headers = {
      'x-quota-snapshot-chat': 'ent=-1&ov=0.0&ovPerm=true&rem=0.0',
      'x-quota-snapshot-premium-chat': 'ent=50&ov=2.0&ovPerm=false&rem=40.0',
    };
    const result = extractBillingHeaders(headers);
    expect(result['quota_chat']).toEqual({ ent: '-1', ov: '0.0', ovPerm: 'true', rem: '0.0' });
    expect(result['quota_premium-chat']).toEqual({ ent: '50', ov: '2.0', ovPerm: 'false', rem: '40.0' });
  });

  it('extracts rate limit headers', () => {
    const headers = {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '95',
      'x-ratelimit-reset': '1700000000',
    };
    const result = extractBillingHeaders(headers);
    expect(result.rate_limit).toBe('100');
    expect(result.rate_remaining).toBe('95');
    expect(result.rate_reset).toBe('1700000000');
  });

  it('handles malformed quota snapshot gracefully', () => {
    const headers = {
      'x-quota-snapshot-premium-chat': 'not-valid-url-params=%%invalid',
    };
    // URLSearchParams is lenient — it won't throw on most strings
    const result = extractBillingHeaders(headers);
    expect(result).not.toBeNull();
  });
});
