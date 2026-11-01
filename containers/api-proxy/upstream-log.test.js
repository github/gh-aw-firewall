const zlib = require('zlib');
const {
  createLogRequestCompletion,
  createLogUpstreamErrorResponse,
  createLogUpstreamAuthError,
  isInferenceRequest,
  _testing,
} = require('./upstream-log');

describe('upstream-log', () => {
  test('logRequestCompletion records metrics and invokes max-runs on inference POST', () => {
    const metrics = {
      statusClass: jest.fn(() => '2xx'),
      gaugeDec: jest.fn(),
      increment: jest.fn(),
      observe: jest.fn(),
    };
    const logRequest = jest.fn();
    const applyMaxRunsInvocation = jest.fn();
    const logRequestCompletion = createLogRequestCompletion({
      metrics,
      logRequest,
      sanitizeForLog: (value) => value,
      applyMaxRunsInvocation,
    });

    logRequestCompletion(200, 42, 'agent', { prompt_tokens: 10 }, {
      startTime: Date.now() - 5,
      provider: 'copilot',
      req: { method: 'POST', url: '/v1/chat/completions' },
      requestBytes: 12,
      targetHost: 'api.githubcopilot.com',
      requestId: 'req-1',
    });

    expect(metrics.gaugeDec).toHaveBeenCalledWith('active_requests', { provider: 'copilot' });
    expect(applyMaxRunsInvocation).toHaveBeenCalledTimes(1);
    expect(logRequest).toHaveBeenCalledWith('info', 'request_complete', expect.objectContaining({
      request_id: 'req-1',
      status: 200,
      x_initiator: 'agent',
    }));
  });

  test('logRequestCompletion does NOT invoke max-runs for GET /models', () => {
    const metrics = {
      statusClass: jest.fn(() => '2xx'),
      gaugeDec: jest.fn(),
      increment: jest.fn(),
      observe: jest.fn(),
    };
    const logRequest = jest.fn();
    const applyMaxRunsInvocation = jest.fn();
    const logRequestCompletion = createLogRequestCompletion({
      metrics,
      logRequest,
      sanitizeForLog: (value) => value,
      applyMaxRunsInvocation,
    });

    logRequestCompletion(200, 100, null, null, {
      startTime: Date.now() - 3,
      provider: 'openai',
      req: { method: 'GET', url: '/models' },
      requestBytes: 0,
      targetHost: 'api.openai.com',
      requestId: 'req-2',
    });

    expect(applyMaxRunsInvocation).not.toHaveBeenCalled();
  });

  test('logRequestCompletion does NOT invoke max-runs for non-inference POST', () => {
    const metrics = {
      statusClass: jest.fn(() => '2xx'),
      gaugeDec: jest.fn(),
      increment: jest.fn(),
      observe: jest.fn(),
    };
    const logRequest = jest.fn();
    const applyMaxRunsInvocation = jest.fn();
    const logRequestCompletion = createLogRequestCompletion({
      metrics,
      logRequest,
      sanitizeForLog: (value) => value,
      applyMaxRunsInvocation,
    });

    logRequestCompletion(200, 50, null, null, {
      startTime: Date.now() - 2,
      provider: 'openai',
      req: { method: 'POST', url: '/v1/embeddings' },
      requestBytes: 20,
      targetHost: 'api.openai.com',
      requestId: 'req-3',
    });

    expect(applyMaxRunsInvocation).not.toHaveBeenCalled();
  });

  describe('isInferenceRequest', () => {
    test.each([
      // OpenAI / Copilot / Anthropic paths
      ['POST', '/v1/chat/completions'],
      ['POST', '/chat/completions'],
      ['POST', '/v1/responses'],
      ['POST', '/responses'],
      ['POST', '/v1/decisions'],
      ['POST', '/decisions'],
      ['POST', '/openai/v1/decisions/?api-version=test'],
      ['POST', '/v1/messages'],
      // Gemini generateContent endpoints
      ['POST', '/v1beta/models/gemini-pro:generateContent'],
      ['POST', '/v1/models/gemini-2.0-flash:generateContent'],
      ['POST', '/v1beta/models/gemini-pro:streamGenerateContent'],
      // Normalization: trailing slash is stripped before matching
      ['POST', '/v1/chat/completions/'],
      // Normalization: fragment is stripped before matching
      ['POST', '/v1/chat/completions#section'],
    ])('returns true for %s %s', (method, url) => {
      expect(isInferenceRequest(method, url)).toBe(true);
    });

    test.each([
      // Non-inference GET endpoints
      ['GET', '/models'],
      ['GET', '/v1/models'],
      ['GET', '/v1beta/models'],
      // Non-inference POST endpoints
      ['POST', '/v1/embeddings'],
      // Wrong method for an inference path
      ['GET', '/v1/chat/completions'],
      // POST /models is not inference
      ['POST', '/models'],
      // Non-inference Gemini endpoint (model list, not generation)
      ['GET', '/v1beta/models/gemini-pro'],
      // Non-string inputs
      [null, '/v1/chat/completions'],
      ['POST', null],
      [undefined, '/v1/chat/completions'],
    ])('returns false for %s %s', (method, url) => {
      expect(isInferenceRequest(method, url)).toBe(false);
    });
  });

  test('logUpstreamAuthError suppresses 400 model-not-supported auth log noise', () => {
    const logRequest = jest.fn();
    const applyPermissionDenied = jest.fn();
    const logUpstreamAuthError = createLogUpstreamAuthError({
      logRequest,
      sanitizeForLog: (value) => value,
      applyPermissionDenied,
      parseModelNotSupportedFromBody: () => true,
    });

    logUpstreamAuthError(400, {
      requestId: 'req-1',
      provider: 'copilot',
      targetHost: 'api.githubcopilot.com',
      req: { url: '/v1/chat/completions' },
      responseBody: Buffer.from('The requested model is not supported'),
    });

    expect(logRequest).not.toHaveBeenCalled();
    expect(applyPermissionDenied).not.toHaveBeenCalled();
  });

  test('logUpstreamErrorResponse logs redacted body and sanitized headers', () => {
    const logRequest = jest.fn();
    const auditTrack = jest.fn();
    const logUpstreamErrorResponse = createLogUpstreamErrorResponse({
      logRequest,
      sanitizeForLog: (value, maxLen = 200) => String(value || '').slice(0, maxLen),
      auditTrack,
    });

    logUpstreamErrorResponse(400, {
      requestId: 'req-1',
      provider: 'copilot',
      targetHost: 'api.githubcopilot.com',
      req: { method: 'POST', url: '/v1/responses' },
      requestModel: 'gpt-5.4',
      transformed: false,
      responseHeaders: {
        'content-type': 'application/json',
        'x-request-id': 'upstream-123',
        authorization: '******',
        cookie: 'session=secret',
        'api-key': 'azure-secret',
      },
      responseBody: Buffer.from('{"error":"bad request","authorization":"******"}'),
      responseBodyBytes: 67,
      responseBodyTruncated: false,
    });

    expect(logRequest).toHaveBeenCalledWith('warn', 'upstream_error_response', expect.objectContaining({
      request_id: 'req-1',
      provider: 'copilot',
      model: 'gpt-5.4',
      status: 400,
      response_content_type: 'application/json',
      response_headers: expect.objectContaining({
        'content-type': 'application/json',
        'x-request-id': 'upstream-123',
      }),
      upstream_request_ids: { 'x-request-id': 'upstream-123' },
    }));
    const [, , fields] = logRequest.mock.calls[0];
    expect(fields.response_headers.authorization).toBeUndefined();
    expect(fields.response_headers.cookie).toBeUndefined();
    expect(fields.response_headers['api-key']).toBeUndefined();
    expect(fields.response_body).toContain('[REDACTED]');
    expect(auditTrack).toHaveBeenCalledWith('UPSTREAM_ERROR_RESPONSE', expect.any(Object));
  });

  // Recorded verbatim from github/gh-aw run 38327292581 (upstream-errors.jsonl).
  const COPILOT_INVALID_REASONING_EFFORT_BODY = '{"error":{"message":"output_config.effort \\"high\\" was provided, but model claude-haiku-4.5 does not support reasoning effort","code":"invalid_reasoning_effort"}}';
  const ERROR_FIELD_KEYS = ['error_code', 'error_type', 'error_param', 'error_source'];

  function logCopilotError(body, { contentType = 'text/plain; charset=utf-8', bytes } = {}) {
    const auditTrack = jest.fn();
    const sanitizeForLog = (value, maxLen = 200) => String(value || '').slice(0, maxLen);
    const logUpstreamErrorResponse = createLogUpstreamErrorResponse({
      logRequest: jest.fn(),
      sanitizeForLog,
      auditTrack,
    });
    const responseBody = Buffer.from(body);
    logUpstreamErrorResponse(400, {
      requestId: 'req-1',
      provider: 'copilot',
      targetHost: 'api.githubcopilot.com',
      req: { method: 'POST', url: '/v1/messages?beta=true' },
      requestModel: 'claude-haiku-4.5',
      transformed: false,
      responseHeaders: { 'content-type': contentType },
      responseBody,
      responseBodyBytes: bytes ?? responseBody.length,
    });
    expect(auditTrack).toHaveBeenCalledWith('UPSTREAM_ERROR_RESPONSE', expect.any(Object));
    const record = auditTrack.mock.calls[0][1];
    // The record main produces for the same input.
    const base = {
      request_id: 'req-1',
      provider: 'copilot',
      model: 'claude-haiku-4.5',
      method: 'POST',
      endpoint: '/v1/messages?beta=true',
      status: 400,
      upstream_host: 'api.githubcopilot.com',
      upstream_request_ids: {},
      response_content_type: contentType,
      response_headers: { 'content-type': contentType },
      response_streaming: false,
      response_transformed: false,
      ..._testing.buildResponseBodyLogFields({
        responseBody,
        responseBodyBytes: bytes ?? responseBody.length,
        sanitizeForLog,
      }),
    };
    return { record, base };
  }

  function withoutErrorFields(record) {
    return Object.fromEntries(Object.entries(record).filter(([key]) => !ERROR_FIELD_KEYS.includes(key)));
  }

  test('logUpstreamErrorResponse adds error_code from the recorded Copilot invalid_reasoning_effort 400', () => {
    const { record, base } = logCopilotError(COPILOT_INVALID_REASONING_EFFORT_BODY);
    expect(record).toEqual({ ...base, error_code: 'invalid_reasoning_effort' });
    expect(record.status).toBe(400);
    expect(record).not.toHaveProperty('error_type');
    expect(record).not.toHaveProperty('error_param');
  });

  test('logUpstreamErrorResponse adds no error fields for non-JSON, truncated, or non-identifier error bodies', () => {
    const envelope = JSON.parse(COPILOT_INVALID_REASONING_EFFORT_BODY);
    const cases = [
      () => logCopilotError('The requested model is not supported'),
      () => {
        const prev = process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES;
        process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES = String(COPILOT_INVALID_REASONING_EFFORT_BODY.length - 1);
        try {
          const result = logCopilotError(COPILOT_INVALID_REASONING_EFFORT_BODY);
          expect(result.record.response_body_truncated).toBe(true);
          return result;
        } finally {
          if (prev === undefined) delete process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES;
          else process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES = prev;
        }
      },
      () => logCopilotError(JSON.stringify({ error: { ...envelope.error, code: 'bad code with spaces' } })),
      () => logCopilotError(JSON.stringify({ error: { ...envelope.error, code: 'a'.repeat(65) } })),
      () => logCopilotError('{"error":"rate limited"}'),
    ];
    for (const run of cases) {
      const { record, base } = run();
      for (const key of ERROR_FIELD_KEYS) expect(record).not.toHaveProperty(key);
      expect(record).toEqual(base);
    }
  });

  test('logUpstreamErrorResponse never copies error.message into error fields', () => {
    const { record, base } = logCopilotError(COPILOT_INVALID_REASONING_EFFORT_BODY);
    const errorFields = Object.fromEntries(Object.entries(record).filter(([key]) => ERROR_FIELD_KEYS.includes(key)));
    expect(errorFields).toEqual({ error_code: 'invalid_reasoning_effort' });
    const serialized = JSON.stringify(errorFields);
    for (const fragment of ['output_config', '"high"', 'does not support', 'private error output']) {
      expect(serialized).not.toContain(fragment);
    }
    expect(record.response_body).toBe(COPILOT_INVALID_REASONING_EFFORT_BODY);
    expect(withoutErrorFields(record)).toEqual(base);
  });

  test('buildResponseBodyLogFields marks truncation explicitly', () => {
    const prev = process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES;
    process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES = '8';
    try {
      const fields = _testing.buildResponseBodyLogFields({
        responseBody: Buffer.from('0123456789'),
        responseBodyBytes: 10,
        sanitizeForLog: (value) => value,
      });
      expect(fields.response_body_truncated).toBe(true);
      expect(fields.response_body).toContain('[TRUNCATED 2 BYTES]');
      expect(fields.response_body_captured_bytes).toBe(8);
    } finally {
      if (prev === undefined) delete process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES;
      else process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES = prev;
    }
  });

  test('redacts canonical credential fields in error bodies', () => {
    const text = JSON.stringify({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      client_secret: 'client-secret',
    });

    const redacted = _testing.redactSecretsInText(text);

    expect(redacted).not.toContain('access-secret');
    expect(redacted).not.toContain('refresh-secret');
    expect(redacted).not.toContain('client-secret');
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  test('redacts safely decompressed compressed error bodies', () => {
    const fields = _testing.buildResponseBodyLogFields({
      responseBody: zlib.gzipSync(Buffer.from('{"access_token":"compressed-secret"}')),
      contentEncoding: 'gzip',
      sanitizeForLog: (value) => value,
    });

    expect(fields.response_body_content_encoding).toBe('utf8');
    expect(fields.response_body).toContain('[REDACTED]');
    expect(fields.response_body).not.toContain('compressed-secret');
  });

  test('omits compressed bodies with unsupported encodings', () => {
    const fields = _testing.buildResponseBodyLogFields({
      responseBody: Buffer.from('uninspectable'),
      contentEncoding: 'zstd',
      sanitizeForLog: (value) => value,
    });

    expect(fields.response_body_content_encoding).toBe('omitted');
    expect(fields.response_body).toContain('[OMITTED');
  });
});
