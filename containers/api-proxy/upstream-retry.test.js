const { EventEmitter } = require('events');
const zlib = require('zlib');
const { handle400WithRetry } = require('./upstream-retry');
const { createLogUpstreamErrorResponse } = require('./upstream-log');
const { createRoutingObservation } = require('./routing-observation');

describe('upstream-retry', () => {
  function createBaseOptions() {
    return {
      provider: 'copilot',
      requestId: 'req-1',
      hasRetried: false,
      onRetry: jest.fn(),
      modelNotSupportedRetryCount: 0,
      maxModelNotSupportedRetries: 2,
      onModelNotSupportedRetry: jest.fn(),
      onModelEndpointBlockedRetry: jest.fn(() => false),
      completionCtx: {},
      authErrCtx: { req: { url: '/v1/chat/completions' } },
      initiatorSent: null,
      billingInfo: null,
      res: { writeHead: jest.fn(), end: jest.fn() },
      span: {},
      parseDeprecatedHeaderFromBody: jest.fn(() => null),
      learnAndStripDeprecatedHeaderValue: jest.fn(() => false),
      parseModelNotSupportedFromBody: jest.fn(() => false),
      parseModelEndpointBlockedFromBody: jest.fn(() => false),
      logRequest: jest.fn(),
      sanitizeForLog: (value) => value,
      logRequestCompletion: jest.fn(),
      logUpstreamAuthError: jest.fn(),
      logUpstreamErrorResponse: jest.fn(),
      otel: { endSpan: jest.fn() },
    };
  }

  test('triggers deprecated-header retry on first attempt', () => {
    const opts = createBaseOptions();
    opts.parseDeprecatedHeaderFromBody.mockReturnValue({
      header: 'anthropic-beta',
      value: 'deprecated-value',
    });
    opts.learnAndStripDeprecatedHeaderValue.mockReturnValue(true);
    const proxyRes = { statusCode: 400, headers: {} };

    const didRetry = handle400WithRetry(proxyRes, { 'anthropic-beta': 'deprecated-value' }, Buffer.from('{}'), opts);

    expect(didRetry).toBe(true);
    expect(opts.onRetry).toHaveBeenCalledWith({ 'anthropic-beta': 'deprecated-value' });
    expect(opts.res.writeHead).not.toHaveBeenCalled();
  });

  test('logs model_unavailable and forwards response when retry is exhausted', () => {
    const opts = createBaseOptions();
    opts.hasRetried = true;
    opts.modelNotSupportedRetryCount = 2;
    opts.parseModelNotSupportedFromBody.mockReturnValue(true);
    const proxyRes = {
      statusCode: 400,
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    };
    const responseBody = Buffer.from('{"error":"The requested model is not supported"}');

    const didRetry = handle400WithRetry(proxyRes, {}, responseBody, opts);

    expect(didRetry).toBe(false);
    expect(opts.logRequest).toHaveBeenCalledWith('error', 'model_unavailable', expect.objectContaining({
      request_id: 'req-1',
      retries_attempted: 2,
    }));
    expect(opts.logRequestCompletion).toHaveBeenCalledWith(400, responseBody.length, null, null, {});
    expect(opts.logUpstreamAuthError).toHaveBeenCalledWith(400, expect.objectContaining({ responseBody }));
    expect(opts.logUpstreamErrorResponse).toHaveBeenCalledWith(400, expect.objectContaining({
      responseHeaders: proxyRes.headers,
      responseBody,
    }));
    expect(opts.res.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
      'x-request-id': 'req-1',
      'content-length': String(responseBody.length),
    }));
    expect(opts.otel.endSpan).toHaveBeenCalledWith(opts.span, 400);
  });

  describe('endpoint-blocked fallback', () => {
    const endpointBlockedBody = Buffer.from(
      '{"error":{"message":"model \\"gpt-5.4-mini\\" is not accessible via the /chat/completions endpoint"}}'
    );

    test('calls onModelEndpointBlockedRetry when endpoint-blocked pattern matches', () => {
      const opts = createBaseOptions();
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      opts.onModelEndpointBlockedRetry.mockReturnValue(true);
      const proxyRes = { statusCode: 400, headers: {} };

      const didRetry = handle400WithRetry(proxyRes, {}, endpointBlockedBody, opts);

      expect(didRetry).toBe(true);
      expect(opts.onModelEndpointBlockedRetry).toHaveBeenCalled();
      expect(opts.logRequest).toHaveBeenCalledWith(
        'warn', 'model_endpoint_blocked_fallback', expect.objectContaining({ provider: 'copilot' })
      );
    });

    test('tries the same-model endpoint retry before a configured model fallback', () => {
      const opts = createBaseOptions();
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      opts.onWireApiEndpointRetry = jest.fn(() => true);
      opts.onModelFallback = jest.fn(() => true);
      expect(handle400WithRetry({ statusCode: 400, headers: {} }, {}, endpointBlockedBody, opts)).toBe(true);
      expect(opts.onWireApiEndpointRetry).toHaveBeenCalled();
      expect(opts.onModelEndpointBlockedRetry).not.toHaveBeenCalled();
      expect(opts.onModelFallback).not.toHaveBeenCalled();
    });

    test('allows an explicit model fallback when endpoint translation cannot preserve custom tools', () => {
      const opts = createBaseOptions();
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      opts.onWireApiEndpointRetry = jest.fn(() => {
        const { WireApiCompatibilityError } = require('./wire-api-compat');
        throw new WireApiCompatibilityError('tools[custom]');
      });
      opts.onModelEndpointBlockedRetry.mockReturnValue(true);
      expect(handle400WithRetry({ statusCode: 400, headers: {} }, {}, endpointBlockedBody, opts)).toBe(true);
      expect(opts.res.end).not.toHaveBeenCalled();
    });

    test('contains unexpected endpoint translation errors without exposing internal details', () => {
      const opts = createBaseOptions();
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      opts.onWireApiEndpointRetry = jest.fn(() => { throw new TypeError('internal detail'); });
      expect(handle400WithRetry({ statusCode: 400, headers: {} }, {}, endpointBlockedBody, opts)).toBe(false);
      const error = JSON.parse(opts.res.end.mock.calls[0][0].toString()).error;
      expect(error.code).toBe('unsupported_wire_api_feature');
      expect(error.message).toContain('choose a model supporting the requested endpoint');
      expect(error.message).not.toContain('internal detail');
    });

    test('falls through to forward response when onModelEndpointBlockedRetry returns false (no candidates)', () => {
      const opts = createBaseOptions();
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      opts.onModelEndpointBlockedRetry.mockReturnValue(false);
      const proxyRes = {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
      };

      const didRetry = handle400WithRetry(proxyRes, {}, endpointBlockedBody, opts);

      expect(didRetry).toBe(false);
      expect(opts.res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('does not trigger when provider is not copilot', () => {
      const opts = createBaseOptions();
      opts.provider = 'openai';
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      const proxyRes = {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
      };

      const didRetry = handle400WithRetry(proxyRes, {}, endpointBlockedBody, opts);

      expect(didRetry).toBe(false);
      expect(opts.onModelEndpointBlockedRetry).not.toHaveBeenCalled();
    });

    test('does not trigger when onModelEndpointBlockedRetry is not provided', () => {
      const opts = createBaseOptions();
      delete opts.onModelEndpointBlockedRetry;
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      const proxyRes = {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
      };

      const didRetry = handle400WithRetry(proxyRes, {}, endpointBlockedBody, opts);

      expect(didRetry).toBe(false);
    });
  });

  describe('AWF rewrite of an endpoint-blocked rejection', () => {
    // Shape used by the model-fallback-chain fixtures for a Copilot endpoint rejection.
    const UPSTREAM_BODY = '{"error":{"message":"model \\"gpt-5.4-mini\\" is not accessible via the /chat/completions endpoint","code":"unsupported_api_for_model"}}';
    const CODES = [
      ['model_endpoint_incompatible', undefined],
      ['unsupported_wire_api_feature', () => { throw new TypeError('internal detail'); }],
    ];

    function rewrite({ upstreamBody, headers = { 'content-type': 'application/json' }, onWireApiEndpointRetry }) {
      const records = [];
      const logRequest = jest.fn();
      const observation = createRoutingObservation({
        getSelection: () => ({ provider: 'copilot', choice: {}, wire_model: 'gpt-5.4-mini' }),
        recordFailure: jest.fn(),
        observer: { record: record => records.push(record) },
        generateRequestId: () => 'req-1',
      });
      const chunks = [];
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableFinished = false;
      res.writeHead = jest.fn(function(statusCode) { this.statusCode = statusCode; });
      res.write = jest.fn(chunk => { chunks.push(Buffer.from(chunk)); return true; });
      res.end = jest.fn(function(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        this.writableFinished = true;
        this.emit('finish');
      });
      const req = { method: 'POST', url: '/v1/chat/completions', headers: {} };
      observation.observeRequest(req, res, { name: 'copilot' });
      req.awfRouting.onUpstreamResponseHeaders(headers);
      const opts = {
        ...createBaseOptions(),
        authErrCtx: { requestId: 'req-1', provider: 'copilot', targetHost: 'api.githubcopilot.com', req },
        res,
        requestModel: 'gpt-5.4-mini',
        logUpstreamErrorResponse: createLogUpstreamErrorResponse({ logRequest, sanitizeForLog: value => value }),
      };
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      opts.onModelEndpointBlockedRetry.mockReturnValue(false);
      if (onWireApiEndpointRetry) opts.onWireApiEndpointRetry = jest.fn(onWireApiEndpointRetry);

      expect(handle400WithRetry({ statusCode: 400, headers }, {}, upstreamBody, opts)).toBe(false);
      const upstreamError = logRequest.mock.calls.find(([, event]) => event === 'upstream_error_response')[2];
      return { records, upstreamError, sent: Buffer.concat(chunks).toString('utf8') };
    }

    test.each(CODES)('records %s as AWF-originated and keeps provider fields in upstream-errors', (code, retry) => {
      const { records, upstreamError, sent } = rewrite({
        upstreamBody: Buffer.from(UPSTREAM_BODY), onWireApiEndpointRetry: retry,
      });

      const clientError = JSON.parse(sent).error;
      expect(clientError).toMatchObject({ code, type: 'invalid_request_error' });
      expect(upstreamError).toMatchObject({
        status: 400,
        response_transformed: true,
        error_code: 'unsupported_api_for_model',
      });
      expect(JSON.parse(upstreamError.response_body).error.code).toBe(code);
      expect(upstreamError).not.toHaveProperty('error_type');
      expect(records).toEqual([expect.objectContaining({
        outcome: 'failed',
        status: 400,
        error_code: code,
        error_type: 'invalid_request_error',
        error_source: 'awf',
      })]);
      expect(JSON.stringify(records[0])).not.toContain('not accessible');
    });

    test.each(CODES)('decodes the provider body and never attributes %s to the provider', (code, retry) => {
      const encoded = rewrite({
        upstreamBody: zlib.gzipSync(Buffer.from(UPSTREAM_BODY)),
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        onWireApiEndpointRetry: retry,
      });
      expect(encoded.upstreamError.error_code).toBe('unsupported_api_for_model');
      expect(encoded.records[0]).toMatchObject({ error_code: code, error_source: 'awf' });

      const withoutCode = rewrite({
        upstreamBody: Buffer.from('{"error":{"message":"model \\"gpt-5.4-mini\\" is not accessible via the /chat/completions endpoint"}}'),
        onWireApiEndpointRetry: retry,
      });
      expect(withoutCode.upstreamError).toMatchObject({ response_transformed: true });
      for (const key of ['error_code', 'error_type', 'error_param']) {
        expect(withoutCode.upstreamError).not.toHaveProperty(key);
      }
      expect(withoutCode.records[0]).toMatchObject({ error_code: code, error_source: 'awf' });
    });
  });
});
