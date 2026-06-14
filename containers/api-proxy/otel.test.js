'use strict';

/**
 * Unit tests for the api-proxy OTEL tracing module (otel.js).
 *
 * Strategy:
 *   - Isolate otel.js by controlling env vars before require().
 *   - Use a custom InMemoryExporter so tests assert on real spans
 *     without any network or file I/O.
 *   - Verify span attributes, events, status, parent linkage and
 *     the helper export functions.
 */

const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const { SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const { EventEmitter } = require('events');
const fs = require('fs');
const { loadOtelModule } = require('./test-helpers/otel-test-utils');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Load a fresh instance of otel.js with the given env overrides.
 * Clears the module cache so each call starts from a clean state.
 */
function loadOtel(envOverrides = {}) {
  return loadOtelModule(envOverrides);
}

/**
 * Load otel.js and swap the BatchSpanProcessor's exporter with an
 * InMemorySpanExporter so we can inspect finished spans.
 */
function loadOtelWithMemoryExporter(envOverrides = {}) {
  const otel = loadOtel(envOverrides);

  // Swap exporter via the provider's MultiSpanProcessor
  const memExporter = new InMemorySpanExporter();
  const provider = otel._provider || null;
  if (provider && provider.activeSpanProcessor) {
    // Replace all span processors with a simple synchronous one
    provider.activeSpanProcessor._spanProcessors = [
      new SimpleSpanProcessor(memExporter),
    ];
  }
  return { otel, memExporter };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('otel split modules', () => {
  test('otel-serialization exports expected helpers', () => {
    const serialization = require('./otel-serialization');
    expect(serialization.parseOtlpHeaders('X-Key=abc')).toEqual({ 'X-Key': 'abc' });
    expect(typeof serialization.buildResourceSpans).toBe('function');
  });

  test('otel-exporters exports expected classes', () => {
    const exporters = require('./otel-exporters');
    expect(typeof exporters.ProxyAwareOtlpExporter).toBe('function');
    expect(typeof exporters.FileSpanExporter).toBe('function');
  });
});

describe('otel — module initialisation', () => {
  test('isEnabled() returns true after normal load', () => {
    const otel = loadOtel();
    expect(otel.isEnabled()).toBe(true);
  });

  test('exports expected public functions', () => {
    const otel = loadOtel();
    expect(typeof otel.startRequestSpan).toBe('function');
    expect(typeof otel.setTokenAttributes).toBe('function');
    expect(typeof otel.endSpan).toBe('function');
    expect(typeof otel.endSpanError).toBe('function');
    expect(typeof otel.shutdown).toBe('function');
    expect(typeof otel.isEnabled).toBe('function');
  });
});

describe('otel — _parseOtlpHeaders', () => {
  test('parses single header', () => {
    const otel = loadOtel();
    expect(otel._parseOtlpHeaders('Authorization=******')).toEqual({
      Authorization: '******',
    });
  });

  test('parses multiple headers', () => {
    const otel = loadOtel();
    expect(otel._parseOtlpHeaders('X-Key=abc,X-Other=123')).toEqual({
      'X-Key': 'abc',
      'X-Other': '123',
    });
  });

  test('handles value with = in it', () => {
    const otel = loadOtel();
    expect(otel._parseOtlpHeaders('Authorization=abc==')).toEqual({
      Authorization: 'abc==',
    });
  });

  test('returns empty object for empty string', () => {
    const otel = loadOtel();
    expect(otel._parseOtlpHeaders('')).toEqual({});
  });

  test('skips malformed entries without =', () => {
    const otel = loadOtel();
    expect(otel._parseOtlpHeaders('noequals,X-Key=val')).toEqual({ 'X-Key': 'val' });
  });
});

describe('otel — startRequestSpan', () => {
  test('creates a span with expected attributes', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider:  'openai',
      method:    'POST',
      path:      '/v1/chat/completions',
      requestId: 'req-001',
    });
    span.end();

    await otel._provider.forceFlush();
    const spans = memExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);

    const s = spans[0];
    expect(s.name).toBe('api_proxy.openai.request');
    expect(s.kind).toBe(SpanKind.CLIENT);
    expect(s.attributes['http.request.method']).toBe('POST');
    expect(s.attributes['url.path']).toBe('/v1/chat/completions');
    expect(s.attributes['gen_ai.provider.name']).toBe('openai');
    expect(s.attributes['awf.request_id']).toBe('req-001');
    expect(s.attributes['gen_ai.operation.name']).toBe('chat');
    expect(s.attributes['gen_ai.request.stream']).toBe(true);
  });

  test('span name includes provider name', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider:  'anthropic',
      method:    'POST',
      path:      '/v1/messages',
      requestId: 'req-002',
    });
    span.end();

    await otel._provider.forceFlush();
    const spans = memExporter.getFinishedSpans();
    expect(spans[0].name).toBe('api_proxy.anthropic.request');
  });

  test('uses parent trace from env vars when valid', async () => {
    const traceId = 'aabbccddeeff00112233445566778899';
    const spanId  = 'aabbccddeeff0011';
    const { otel, memExporter } = loadOtelWithMemoryExporter({
      GITHUB_AW_OTEL_TRACE_ID:        traceId,
      GITHUB_AW_OTEL_PARENT_SPAN_ID:  spanId,
    });

    const span = otel.startRequestSpan({
      provider:  'copilot',
      method:    'POST',
      path:      '/v1/chat',
      requestId: 'req-003',
    });
    span.end();

    await otel._provider.forceFlush();
    const spans = memExporter.getFinishedSpans();
    expect(spans[0].spanContext().traceId).toBe(traceId);
    expect(spans[0].parentSpanId).toBe(spanId);
  });

  test('ignores invalid parent trace IDs', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter({
      GITHUB_AW_OTEL_TRACE_ID:       'not-valid-hex',
      GITHUB_AW_OTEL_PARENT_SPAN_ID: 'also-bad',
    });

    const span = otel.startRequestSpan({
      provider: 'openai', method: 'GET', path: '/v1/models', requestId: 'r',
    });
    span.end();

    await otel._provider.forceFlush();
    const spans = memExporter.getFinishedSpans();
    expect(spans[0].parentSpanId).toBeUndefined();
  });
});

describe('otel — setTokenAttributes', () => {
  test('sets gen_ai token attributes and emits gen_ai.usage event', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'openai', method: 'POST', path: '/v1/chat/completions', requestId: 'r1',
    });

    otel.setTokenAttributes(span, {
      provider:        'openai',
      model:           'gpt-4o',
      normalizedUsage: {
        input_tokens:       1000,
        output_tokens:      500,
        cache_read_tokens:  200,
        cache_write_tokens: 50,
      },
      streaming: false,
    });

    otel.endSpan(span, 200);

    await otel._provider.forceFlush();
    const spans = memExporter.getFinishedSpans();
    const s = spans[0];

    expect(s.attributes['gen_ai.response.model']).toBe('gpt-4o');
    expect(s.attributes['gen_ai.usage.input_tokens']).toBe(1000);
    expect(s.attributes['gen_ai.usage.output_tokens']).toBe(500);
    expect(s.attributes['awf.cached_read']).toBe('200');
    expect(s.attributes['awf.cached_write']).toBe('50');
    expect(s.attributes['gen_ai.request.stream']).toBe(false);

    const usageEvent = s.events.find(e => e.name === 'gen_ai.usage');
    expect(usageEvent).toBeDefined();
    expect(usageEvent.attributes['gen_ai.usage.input_tokens']).toBe(1000);
    expect(usageEvent.attributes['gen_ai.usage.output_tokens']).toBe(500);
    expect(usageEvent.attributes['awf.cached_read']).toBe('200');
    expect(usageEvent.attributes['awf.cached_write']).toBe('50');
  });

  test('does not set gen_ai.response.model when model is "unknown"', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'openai', method: 'POST', path: '/v1/chat/completions', requestId: 'r2',
    });
    otel.setTokenAttributes(span, {
      provider: 'openai', model: 'unknown',
      normalizedUsage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
      streaming: false,
    });
    otel.endSpan(span, 200);

    await otel._provider.forceFlush();
    const spans = memExporter.getFinishedSpans();
    expect(spans[0].attributes['gen_ai.response.model']).toBeUndefined();
  });

  test('is a no-op on a null span', () => {
    const otel = loadOtel();
    expect(() => otel.setTokenAttributes(null, {
      provider: 'openai', model: 'gpt-4', streaming: false,
      normalizedUsage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    })).not.toThrow();
  });
});

describe('otel — setBudgetAttributes', () => {
  test('sets AI credits and model unit attributes as strings', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'anthropic', method: 'POST', path: '/v1/messages', requestId: 'b1',
    });

    otel.setBudgetAttributes(span, {
      ai_credits_this_response: 0.042,
      ai_credits_total: 1.5,
      effective_tokens_this_response: 3500,
      effective_tokens_total: 85000,
      model_multiplier: 2.5,
    });

    otel.endSpan(span, 200);

    await otel._provider.forceFlush();
    const s = memExporter.getFinishedSpans()[0];

    expect(s.attributes['awf.ai_credits']).toBe('0.042');
    expect(s.attributes['awf.ai_credits_total']).toBe('1.5');
    expect(s.attributes['awf.model_units']).toBe('3500');
    expect(s.attributes['awf.model_units_total']).toBe('85000');
    expect(s.attributes['awf.model_multiplier']).toBe('2.5');
  });

  test('sets only ai_credits when model units are absent', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'openai', method: 'POST', path: '/v1/chat/completions', requestId: 'b2',
    });

    otel.setBudgetAttributes(span, {
      ai_credits_this_response: 0.01,
      ai_credits_total: 0.05,
    });

    otel.endSpan(span, 200);

    await otel._provider.forceFlush();
    const s = memExporter.getFinishedSpans()[0];

    expect(s.attributes['awf.ai_credits']).toBe('0.01');
    expect(s.attributes['awf.ai_credits_total']).toBe('0.05');
    expect(s.attributes['awf.model_units']).toBeUndefined();
    expect(s.attributes['awf.model_units_total']).toBeUndefined();
  });

  test('is a no-op when budgetResult is undefined', () => {
    const otel = loadOtel();
    expect(() => otel.setBudgetAttributes({}, undefined)).not.toThrow();
  });

  test('is a no-op on a null span', () => {
    const otel = loadOtel();
    expect(() => otel.setBudgetAttributes(null, { ai_credits_this_response: 1 })).not.toThrow();
  });
});

describe('otel — endSpan', () => {
  test('sets OK status for 2xx response', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'openai', method: 'POST', path: '/v1/chat/completions', requestId: 'r3',
    });
    otel.endSpan(span, 200);

    await otel._provider.forceFlush();
    const s = memExporter.getFinishedSpans()[0];
    expect(s.status.code).toBe(SpanStatusCode.OK);
    expect(s.attributes['http.response.status_code']).toBe(200);
  });

  test('sets ERROR status for 4xx response', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'openai', method: 'POST', path: '/v1/chat/completions', requestId: 'r4',
    });
    otel.endSpan(span, 401);

    await otel._provider.forceFlush();
    const s = memExporter.getFinishedSpans()[0];
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.attributes['http.response.status_code']).toBe(401);
  });

  test('sets ERROR status for 5xx response', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'openai', method: 'POST', path: '/v1/chat/completions', requestId: 'r5',
    });
    otel.endSpan(span, 502);

    await otel._provider.forceFlush();
    const s = memExporter.getFinishedSpans()[0];
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
  });

  test('is a no-op on null span', () => {
    const otel = loadOtel();
    expect(() => otel.endSpan(null, 200)).not.toThrow();
  });
});

describe('otel — endSpanError', () => {
  test('records exception and sets ERROR status', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'openai', method: 'POST', path: '/v1/chat/completions', requestId: 'r6',
    });
    const err = new Error('connection refused');
    otel.endSpanError(span, err, 502);

    await otel._provider.forceFlush();
    const s = memExporter.getFinishedSpans()[0];
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.status.message).toBe('connection refused');
    expect(s.attributes['http.response.status_code']).toBe(502);

    const exceptionEvent = s.events.find(e => e.name === 'exception');
    expect(exceptionEvent).toBeDefined();
  });

  test('works without a status code', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'openai', method: 'POST', path: '/v1/chat/completions', requestId: 'r7',
    });
    otel.endSpanError(span, new Error('timeout'));

    await otel._provider.forceFlush();
    const s = memExporter.getFinishedSpans()[0];
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.attributes['http.response.status_code']).toBeUndefined();
  });

  test('is a no-op on null span', () => {
    const otel = loadOtel();
    expect(() => otel.endSpanError(null, new Error('boom'))).not.toThrow();
  });
});

describe('otel — _buildResourceSpans serialization', () => {
  test('serializes span to OTLP/JSON shape', async () => {
    const { otel, memExporter } = loadOtelWithMemoryExporter();

    const span = otel.startRequestSpan({
      provider: 'anthropic', method: 'POST', path: '/v1/messages', requestId: 'r8',
    });
    otel.setTokenAttributes(span, {
      provider: 'anthropic', model: 'claude-opus-4',
      normalizedUsage: { input_tokens: 300, output_tokens: 150, cache_read_tokens: 0, cache_write_tokens: 0 },
      streaming: true,
    });
    otel.endSpan(span, 200);

    await otel._provider.forceFlush();
    const spans = memExporter.getFinishedSpans();

    // Build the OTLP envelope to test serialization
    const { Resource } = require('@opentelemetry/resources');
    const resource = new Resource({ 'service.name': 'test' });
    const envelope = otel._buildResourceSpans(spans, resource);

    expect(envelope).toHaveLength(1);
    const resourceSpan = envelope[0];
    expect(resourceSpan.resource).toBeDefined();
    expect(resourceSpan.scopeSpans).toHaveLength(1);

    const serializedSpan = resourceSpan.scopeSpans[0].spans[0];
    expect(typeof serializedSpan.traceId).toBe('string');
    expect(typeof serializedSpan.spanId).toBe('string');
    expect(typeof serializedSpan.startTimeUnixNano).toBe('string');
    expect(typeof serializedSpan.endTimeUnixNano).toBe('string');
    expect(serializedSpan.kind).toBe(3);  // CLIENT = SpanKind.CLIENT(2) + 1 offset = 3
    expect(serializedSpan.status.code).toBe(SpanStatusCode.OK);

    // Verify gen_ai.usage event is present
    const usageEvent = serializedSpan.events.find(e => e.name === 'gen_ai.usage');
    expect(usageEvent).toBeDefined();
    expect(usageEvent.attributes.find(a => a.key === 'gen_ai.usage.input_tokens')).toBeDefined();
  });
});

describe('otel — ProxyAwareOtlpExporter', () => {
  test('constructs without error when httpsProxy is null', () => {
    const { _ProxyAwareOtlpExporter } = loadOtel();
    const { Resource } = require('@opentelemetry/resources');
    expect(() => new _ProxyAwareOtlpExporter({
      url:        'https://otel.example.com:4318',
      headers:    {},
      httpsProxy: null,
      resource:   new Resource({}),
    })).not.toThrow();
  });

  test('appends /v1/traces to bare endpoint URL', () => {
    const { _ProxyAwareOtlpExporter } = loadOtel();
    const { Resource } = require('@opentelemetry/resources');
    const exp = new _ProxyAwareOtlpExporter({
      url:        'https://otel.example.com:4318',
      headers:    {},
      httpsProxy: null,
      resource:   new Resource({}),
    });
    expect(exp._parsedUrl.pathname).toBe('/v1/traces');
  });

  test('preserves /v1/traces when already present', () => {
    const { _ProxyAwareOtlpExporter } = loadOtel();
    const { Resource } = require('@opentelemetry/resources');
    const exp = new _ProxyAwareOtlpExporter({
      url:        'https://otel.example.com:4318/v1/traces',
      headers:    {},
      httpsProxy: null,
      resource:   new Resource({}),
    });
    expect(exp._parsedUrl.pathname).toBe('/v1/traces');
  });

  test('preserves query string when normalizing endpoint', () => {
    const { _ProxyAwareOtlpExporter } = loadOtel();
    const { Resource } = require('@opentelemetry/resources');
    const exp = new _ProxyAwareOtlpExporter({
      url:        'https://otel.example.com:4318?api-version=1',
      headers:    {},
      httpsProxy: null,
      resource:   new Resource({}),
    });
    expect(exp._parsedUrl.pathname).toBe('/v1/traces');
    expect(exp._parsedUrl.search).toBe('?api-version=1');
  });

  test('includes query string in export request path', (done) => {
    const { _ProxyAwareOtlpExporter } = loadOtel();
    const { Resource } = require('@opentelemetry/resources');
    const reqSpy = jest.spyOn(require('https'), 'request').mockImplementation((options, cb) => {
      try {
        expect(options.path).toBe('/v1/traces?api-version=1');
      } catch (err) {
        process.nextTick(() => done(err));
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit('end');
      });
      return {
        on: jest.fn(),
        setTimeout: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };
    });
    const exp = new _ProxyAwareOtlpExporter({
      url:        'https://otel.example.com:4318?api-version=1',
      headers:    {},
      httpsProxy: null,
      resource:   new Resource({}),
    });
    const span = {
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
      name: 'test',
      kind: 2,
      startTime: [1, 0],
      endTime: [1, 1],
      attributes: {},
      events: [],
      status: { code: 1 },
    };
    exp.export([span], (result) => {
      reqSpy.mockRestore();
      expect(result.code).toBe(0);
      done();
    });
  });

  test('returns failure when request creation throws synchronously', (done) => {
    const { _ProxyAwareOtlpExporter } = loadOtel();
    const { Resource } = require('@opentelemetry/resources');
    const reqSpy = jest.spyOn(require('https'), 'request').mockImplementation(() => {
      throw new Error('bad request options');
    });
    const exp = new _ProxyAwareOtlpExporter({
      url:        'https://otel.example.com:4318',
      headers:    {},
      httpsProxy: null,
      resource:   new Resource({}),
    });
    const span = {
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
      name: 'test',
      kind: 2,
      startTime: [1, 0],
      endTime: [1, 1],
      attributes: {},
      events: [],
      status: { code: 1 },
    };
    exp.export([span], (result) => {
      reqSpy.mockRestore();
      expect(result.code).toBe(1);
      expect(result.error).toBeInstanceOf(Error);
      done();
    });
  });

  test('calls resultCallback with code 0 for empty spans', (done) => {
    const { _ProxyAwareOtlpExporter } = loadOtel();
    const { Resource } = require('@opentelemetry/resources');
    const exp = new _ProxyAwareOtlpExporter({
      url: 'https://otel.example.com:4318', headers: {}, httpsProxy: null, resource: new Resource({}),
    });
    exp.export([], (result) => {
      expect(result.code).toBe(0);
      done();
    });
  });
});

describe('otel — FileSpanExporter', () => {
  test('export() writes timestamp/event/_schema in JSONL record', (done) => {
    const { _FileSpanExporter } = loadOtel({ AWF_VERSION: '1.2.3' });
    const writes = [];
    const mockStream = {
      write: jest.fn((chunk) => { writes.push(chunk); return true; }),
      on: jest.fn(),
    };
    const createWriteStreamSpy = jest.spyOn(fs, 'createWriteStream').mockReturnValue(mockStream);

    const exp = new _FileSpanExporter('/tmp/otel.jsonl');
    const span = {
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
      parentSpanId: null,
      name: 'test_span',
      kind: 2,
      startTime: [1700000000, 0],
      endTime: [1700000000, 1000000],
      attributes: {},
      events: [],
      status: { code: 1 },
    };

    exp.export([span], (result) => {
      createWriteStreamSpy.mockRestore();
      expect(result.code).toBe(0);
      expect(writes).toHaveLength(1);
      const parsed = JSON.parse(writes[0].trim());
      expect(parsed._schema).toBe('otel-span/v1.2.3');
      expect(parsed.event).toBe('otel_span');
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      done();
    });
  });

  test('export() calls resultCallback with code 0 (best-effort)', (done) => {
    const { _FileSpanExporter } = loadOtel();
    // Use a path that likely fails (directory doesn't exist)
    const exp = new _FileSpanExporter('/nonexistent-dir/otel.jsonl');
    exp.export([], (result) => {
      expect(result.code).toBe(0);
      done();
    });
  });

  test('shutdown() resolves even when stream was never opened', async () => {
    const { _FileSpanExporter } = loadOtel();
    const exp = new _FileSpanExporter('/nonexistent/path.jsonl');
    await expect(exp.shutdown()).resolves.toBeUndefined();
  });
});

describe('otel — shutdown', () => {
  test('shutdown() resolves without error', async () => {
    const otel = loadOtel();
    await expect(otel.shutdown()).resolves.toBeUndefined();
  });
});
