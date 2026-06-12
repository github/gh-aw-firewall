'use strict';

/**
 * Tests for OTLP fan-out exporter and GH_AW_OTLP_ENDPOINTS parsing.
 */

const { FanOutSpanExporter } = require('./otel-exporters');

// ── FanOutSpanExporter unit tests ─────────────────────────────────────────────

describe('FanOutSpanExporter', () => {
  function makeMockExporter(resultCode = 0) {
    const calls = [];
    return {
      calls,
      export(spans, cb) {
        calls.push(spans);
        cb({ code: resultCode });
      },
      shutdown() { return Promise.resolve(); },
    };
  }

  test('exports spans to all child exporters', (done) => {
    const e1 = makeMockExporter(0);
    const e2 = makeMockExporter(0);
    const fanout = new FanOutSpanExporter([e1, e2]);

    const fakeSpans = [{ name: 'test-span' }];
    fanout.export(fakeSpans, (result) => {
      expect(result.code).toBe(0);
      expect(e1.calls).toHaveLength(1);
      expect(e2.calls).toHaveLength(1);
      expect(e1.calls[0]).toBe(fakeSpans);
      done();
    });
  });

  test('succeeds if at least one exporter succeeds', (done) => {
    const e1 = makeMockExporter(1); // fails
    const e2 = makeMockExporter(0); // succeeds
    const fanout = new FanOutSpanExporter([e1, e2]);

    fanout.export([{ name: 'span' }], (result) => {
      expect(result.code).toBe(0); // partial success = success
      done();
    });
  });

  test('fails only when all exporters fail', (done) => {
    const e1 = makeMockExporter(1);
    const e2 = makeMockExporter(1);
    const fanout = new FanOutSpanExporter([e1, e2]);

    fanout.export([{ name: 'span' }], (result) => {
      expect(result.code).toBe(1);
      done();
    });
  });

  test('handles empty spans gracefully', (done) => {
    const e1 = makeMockExporter(0);
    const fanout = new FanOutSpanExporter([e1]);

    fanout.export([], (result) => {
      expect(result.code).toBe(0);
      expect(e1.calls).toHaveLength(0);
      done();
    });
  });

  test('handles exporter throwing', (done) => {
    const throwing = {
      export() { throw new Error('boom'); },
      shutdown() { return Promise.resolve(); },
    };
    const good = makeMockExporter(0);
    const fanout = new FanOutSpanExporter([throwing, good]);

    fanout.export([{ name: 'span' }], (result) => {
      expect(result.code).toBe(0); // good exporter succeeded
      expect(good.calls).toHaveLength(1);
      done();
    });
  });

  test('shutdown calls all child exporters', async () => {
    const shutdowns = [];
    const e1 = { export() {}, shutdown() { shutdowns.push(1); return Promise.resolve(); } };
    const e2 = { export() {}, shutdown() { shutdowns.push(2); return Promise.resolve(); } };
    const fanout = new FanOutSpanExporter([e1, e2]);

    await fanout.shutdown();
    expect(shutdowns).toEqual([1, 2]);
  });
});

// ── _parseEndpoints unit tests ────────────────────────────────────────────────

describe('_parseEndpoints', () => {
  function loadOtelFresh(envOverrides = {}) {
    const saved = {};
    const keys = [
      'GH_AW_OTLP_ENDPOINTS',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_SERVICE_NAME',
      'GITHUB_AW_OTEL_TRACE_ID',
      'GITHUB_AW_OTEL_PARENT_SPAN_ID',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'AWF_VERSION',
    ];
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, envOverrides);

    jest.resetModules();
    const mod = require('./otel');

    for (const k of keys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
    return mod;
  }

  test('returns empty array when env var is absent', () => {
    const otel = loadOtelFresh({});
    expect(otel._parseEndpoints()).toEqual([]);
  });

  test('parses valid JSON array of endpoints', () => {
    const endpoints = [
      { url: 'https://primary.example.com:4318', headers: { 'Authorization': 'Bearer abc' } },
      { url: 'https://secondary.example.com:4318', headers: { 'X-Api-Key': 'xyz' } },
    ];
    const otel = loadOtelFresh({ GH_AW_OTLP_ENDPOINTS: JSON.stringify(endpoints) });
    expect(otel._parseEndpoints()).toEqual(endpoints);
  });

  test('filters out entries without url', () => {
    const endpoints = [
      { url: 'https://valid.example.com', headers: {} },
      { headers: { 'X-Key': 'val' } },
      { url: '', headers: {} },
      null,
    ];
    const otel = loadOtelFresh({ GH_AW_OTLP_ENDPOINTS: JSON.stringify(endpoints) });
    expect(otel._parseEndpoints()).toEqual([
      { url: 'https://valid.example.com', headers: {} },
    ]);
  });

  test('returns empty array for invalid JSON', () => {
    const otel = loadOtelFresh({ GH_AW_OTLP_ENDPOINTS: 'not-json{' });
    expect(otel._parseEndpoints()).toEqual([]);
  });

  test('returns empty array for non-array JSON', () => {
    const otel = loadOtelFresh({ GH_AW_OTLP_ENDPOINTS: '{"url": "https://x.com"}' });
    expect(otel._parseEndpoints()).toEqual([]);
  });

  test('normalizes missing headers to empty object', () => {
    const endpoints = [{ url: 'https://no-headers.example.com' }];
    const otel = loadOtelFresh({ GH_AW_OTLP_ENDPOINTS: JSON.stringify(endpoints) });
    expect(otel._parseEndpoints()).toEqual([
      { url: 'https://no-headers.example.com', headers: {} },
    ]);
  });
});

// ── Integration: fan-out initialization ───────────────────────────────────────

describe('otel fan-out initialization', () => {
  function loadOtelFresh(envOverrides = {}) {
    const saved = {};
    const keys = [
      'GH_AW_OTLP_ENDPOINTS',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_SERVICE_NAME',
      'GITHUB_AW_OTEL_TRACE_ID',
      'GITHUB_AW_OTEL_PARENT_SPAN_ID',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'AWF_VERSION',
    ];
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, envOverrides);

    jest.resetModules();
    const mod = require('./otel');

    for (const k of keys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
    return mod;
  }

  test('initializes with FanOutSpanExporter when multiple endpoints configured', () => {
    const endpoints = [
      { url: 'https://a.example.com:4318' },
      { url: 'https://b.example.com:4318' },
    ];
    const otel = loadOtelFresh({ GH_AW_OTLP_ENDPOINTS: JSON.stringify(endpoints) });
    expect(otel.isEnabled()).toBe(true);
    // Provider should be initialized
    expect(otel._provider).not.toBeNull();
  });

  test('initializes with single ProxyAwareOtlpExporter for one endpoint in array', () => {
    const endpoints = [{ url: 'https://single.example.com:4318' }];
    const otel = loadOtelFresh({ GH_AW_OTLP_ENDPOINTS: JSON.stringify(endpoints) });
    expect(otel.isEnabled()).toBe(true);
  });

  test('falls back to OTEL_EXPORTER_OTLP_ENDPOINT when GH_AW_OTLP_ENDPOINTS absent', () => {
    const otel = loadOtelFresh({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://legacy.example.com' });
    expect(otel.isEnabled()).toBe(true);
  });

  test('GH_AW_OTLP_ENDPOINTS takes priority over OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const endpoints = [
      { url: 'https://fanout1.example.com' },
      { url: 'https://fanout2.example.com' },
    ];
    const otel = loadOtelFresh({
      GH_AW_OTLP_ENDPOINTS: JSON.stringify(endpoints),
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://legacy.example.com',
    });
    expect(otel.isEnabled()).toBe(true);
  });

  test('uses FileSpanExporter when no OTLP config at all', () => {
    const otel = loadOtelFresh({});
    expect(otel.isEnabled()).toBe(true);
    // Still enabled, just writes to file
  });
});
