jest.mock('./token-persistence', () => ({
  auditTrack: jest.fn(),
  auditUpstreamErrorResponse: jest.fn(),
}));

const {
  createUpstreamResponseLogging,
  extractRequestModel,
  summarizeRequestTools,
} = require('./upstream-error-logging');
const { auditTrack, auditUpstreamErrorResponse } = require('./token-persistence');
const { rememberInjectedCredentials } = require('./credential-protection');

function createDependencies() {
  return {
    metrics: {},
    logRequest: jest.fn(),
    sanitizeForLog: value => String(value || ''),
    otel: { endSpanError: jest.fn() },
    handleRequestError: jest.fn(),
    applyMaxRunsInvocation: jest.fn(),
    applyPermissionDenied: jest.fn(),
  };
}

describe('upstream-error-logging', () => {
  beforeEach(() => jest.clearAllMocks());

  test('wires model-error suppression and permission-denied logging', () => {
    const deps = createDependencies();
    const { logUpstreamAuthError } = createUpstreamResponseLogging(deps);
    const context = {
      requestId: 'test-request', provider: 'copilot', targetHost: 'api.githubcopilot.com',
      req: { method: 'POST', url: '/chat/completions' },
      responseBody: Buffer.from('The requested model is not supported'),
    };

    logUpstreamAuthError(400, context);
    expect(deps.logRequest).not.toHaveBeenCalled();
    expect(deps.applyPermissionDenied).not.toHaveBeenCalled();

    logUpstreamAuthError(403, context);
    expect(deps.applyPermissionDenied).toHaveBeenCalledTimes(1);
    expect(deps.logRequest).toHaveBeenCalledWith('warn', 'upstream_auth_error', expect.objectContaining({
      request_id: 'test-request', status: 403,
    }));
  });

  test('sends sanitized error diagnostics to the dedicated audit writer', () => {
    const deps = createDependencies();
    const { logUpstreamErrorResponse } = createUpstreamResponseLogging(deps);

    logUpstreamErrorResponse(500, {
      requestId: 'test-request', provider: 'openai', targetHost: 'api.openai.com',
      req: { method: 'POST', url: '/v1/responses' },
      responseHeaders: { 'content-type': 'text/plain', 'set-cookie': 'session=private-value' },
      responseBody: Buffer.from('upstream failure token=private-value'),
    });

    const [, , fields] = deps.logRequest.mock.calls[0];
    expect(fields.response_body).toBe('upstream failure token=[REDACTED]');
    expect(fields.response_headers).toEqual({ 'content-type': 'text/plain' });
    expect(auditUpstreamErrorResponse).toHaveBeenCalledWith(fields);
    expect(auditTrack).not.toHaveBeenCalled();
    expect(JSON.stringify(fields)).not.toContain('private-value');
  });

  test.each([false, true])('redacts stream errors before telemetry and downstream handling (destroy available: %s)', canDestroy => {
    const deps = createDependencies();
    const { handleResponseStreamError } = createUpstreamResponseLogging(deps);
    const req = {
      awfUpstreamCancellation: { cancelled: false },
      awfEnclaveModelBudgetAttempt: { settleMissing: jest.fn() },
    };
    const credential = 'synthetic-stream-credential';
    rememberInjectedCredentials(req, { authorization: ['Bearer', credential].join(' ') });
    const error = new Error(`stream failed: ${credential}`);
    error.name = `Error-${credential}`;
    error.code = `CODE-${credential}`;
    const res = canDestroy ? { destroy: jest.fn() } : {};
    const span = {};
    const context = {
      req, res, span, requestId: 'test-request', provider: 'copilot',
      targetHost: 'api.githubcopilot.com', startTime: 123,
    };

    handleResponseStreamError(error, context);

    const [safeError, errorContext] = deps.handleRequestError.mock.calls[0];
    for (const field of ['message', 'name', 'code', 'stack']) {
      expect(safeError[field]).not.toContain(credential);
    }
    expect(safeError.message).toBe(`stream failed: ${'*'.repeat(credential.length)}`);
    expect(error.message).toContain(credential);
    expect(deps.otel.endSpanError).toHaveBeenCalledWith(span, safeError, 502);
    expect(req.awfUpstreamCancellation.finalized).toBe(true);
    expect(req.awfEnclaveModelBudgetAttempt.settleMissing).toHaveBeenCalledTimes(1);
    expect(errorContext).toMatchObject({
      req, res, requestId: 'test-request', provider: 'copilot',
      targetHost: 'api.githubcopilot.com', startTime: 123,
      statusCode: 502, clientMessage: 'Response stream error',
    });
    errorContext.onHeadersSent();
    if (canDestroy) expect(res.destroy).toHaveBeenCalledWith(safeError);
  });

  test('ignores cancelled stream errors before reporting or settling them', () => {
    const deps = createDependencies();
    const { handleResponseStreamError } = createUpstreamResponseLogging(deps);
    const req = {
      awfUpstreamCancellation: { cancelled: true },
      awfEnclaveModelBudgetAttempt: { settleMissing: jest.fn() },
    };

    handleResponseStreamError(new Error('cancelled stream'), { req });

    expect(deps.handleRequestError).not.toHaveBeenCalled();
    expect(deps.otel.endSpanError).not.toHaveBeenCalled();
    expect(req.awfEnclaveModelBudgetAttempt.settleMissing).not.toHaveBeenCalled();
    expect(req.awfUpstreamCancellation.finalized).toBeUndefined();
  });

  test.each([
    [undefined, null],
    [Buffer.alloc(0), null],
    [Buffer.from('not json'), null],
    [Buffer.from('null'), null],
    [Buffer.from('{"model":42}'), null],
    [Buffer.from('{"model":"test-model"}'), 'test-model'],
  ])('extracts request models without requiring a response handler (%j)', (body, expected) => {
    expect(extractRequestModel(body)).toBe(expected);
  });

  test('limits tool names without recording schemas, descriptions or messages', () => {
    const tools = Array.from({ length: 34 }, (_, index) => ({
      type: 'function',
      function: { name: ` tool-${index} `, description: 'private-description', parameters: { private: true } },
    }));
    tools.push(null, { name: ' ' });
    const body = Buffer.from(JSON.stringify({ tools, messages: ['private-message'] }));

    expect(summarizeRequestTools(body)).toEqual({
      tool_count: 36,
      tool_names: Array.from({ length: 32 }, (_, index) => `tool-${index}`),
      unnamed_tool_count: 2,
    });
  });
});
