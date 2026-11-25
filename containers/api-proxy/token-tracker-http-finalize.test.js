'use strict';

require('./test-helpers/token-tracker-setup');

jest.mock('./logging', () => ({ logRequest: jest.fn() }));
jest.mock('./token-persistence', () => ({
  ...jest.requireActual('./token-persistence'),
  auditTrack: jest.fn(),
  diag: jest.fn(),
  writeTokenUsage: jest.fn(),
  incrementTokenMetrics: jest.fn(),
}));

const { EventEmitter } = require('events');
const tracker = require('./token-tracker-http');
const { finalizeHttpTracking } = require('./token-tracker-http-finalize');
const { auditTrack, writeTokenUsage, incrementTokenMetrics, diag } = require('./token-persistence');
const { logRequest } = require('./logging');

function makeState(overrides = {}) {
  return {
    streaming: true,
    compressed: false,
    contentType: 'text/event-stream',
    contentEncoding: '(none)',
    chunks: [],
    totalBytes: 123,
    bufferedBytes: 0,
    overflow: false,
    streamingUsage: {},
    streamingModel: null,
    observedCacheReadTokens: 0,
    partialLine: '',
    ...overrides,
  };
}

function makeOpts(overrides = {}) {
  return {
    requestId: 'finalize-regression',
    provider: 'openai',
    path: '/v1/chat/completions',
    startTime: Date.now() - 100,
    metrics: {},
    onUsage: jest.fn(() => ({ ai_credits_this_response: 0.1, ai_credits_total: 0.2 })),
    onUsageMissing: jest.fn(),
    onSpanEnd: jest.fn(),
    ...overrides,
  };
}

function expectBefore(first, second) {
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
}

beforeEach(() => jest.clearAllMocks());

test('preserves the HTTP tracker public API', () => {
  expect(Object.keys(tracker).sort()).toEqual([
    'trackTokenUsage',
    'createChunkHandler',
    'finalizeHttpTracking',
    'extractUsageFromTrackedState',
    'buildAndWriteTokenRecord',
    'hasCompleteModelUsage',
  ].sort());
  for (const exported of Object.values(tracker)) expect(typeof exported).toBe('function');
  expect(tracker.finalizeHttpTracking).toBe(finalizeHttpTracking);
  expect(tracker.createChunkHandler).toBe(require('./token-tracker-http-state').createChunkHandler);
  expect(tracker.extractUsageFromTrackedState).toBe(require('./token-usage-extraction').extractUsageFromTrackedState);
});

test.each([
  ['complete', { input_tokens: 10, output_tokens: 5 }, false],
  ['partial', { input_tokens: 10 }, true],
])('%s usage preserves enforcement, metrics, persistence, and span ordering', (_, usage, missing) => {
  const opts = makeOpts({ requestModel: 'request-model' });
  finalizeHttpTracking(makeState({ streamingUsage: usage }), { statusCode: 200 }, opts);

  expect(opts.onUsage).toHaveBeenCalledTimes(1);
  expect(opts.onUsage).toHaveBeenCalledWith(
    expect.objectContaining({ input_tokens: 10, output_tokens: usage.output_tokens || 0 }),
    'request-model',
  );
  expect(opts.onUsageMissing).toHaveBeenCalledTimes(missing ? 1 : 0);
  if (missing) expectBefore(opts.onUsageMissing, opts.onUsage);
  expectBefore(opts.onUsage, incrementTokenMetrics);
  expectBefore(incrementTokenMetrics, writeTokenUsage);
  expectBefore(writeTokenUsage, opts.onSpanEnd);
  expect(opts.onSpanEnd).toHaveBeenCalledTimes(1);
  expect(opts.onSpanEnd).toHaveBeenCalledWith(200);
  expect(writeTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
    model: 'request-model',
    ai_credits_this_response: 0.1,
    ai_credits_total: 0.2,
  }));
  expect(auditTrack).toHaveBeenCalledTimes(1);
  expect(auditTrack).toHaveBeenCalledWith('TRACK_END', expect.objectContaining({ result: 'ok' }));
});

test.each([
  ['non-2xx', {}, { statusCode: 503 }, {}, 'skip_status', true],
  ['missing usage', {}, { statusCode: 200 }, {}, 'no_usage', false],
  ['buffer overflow', { streaming: false, overflow: true }, { statusCode: 200 }, {}, 'no_usage', false],
  ['Cursor native usage', {}, { statusCode: 200 }, { path: '/agent.v1.AgentService/RunSSE?test=1' }, 'unsupported_accounting', true],
])('%s preserves missing-usage notification order and terminal audit', (_, state, response, overrides, result, missingFirst) => {
  const opts = makeOpts(overrides);
  finalizeHttpTracking(makeState(state), response, opts);

  expect(opts.onUsage).not.toHaveBeenCalled();
  expect(incrementTokenMetrics).not.toHaveBeenCalled();
  expect(writeTokenUsage).not.toHaveBeenCalled();
  expect(opts.onUsageMissing).toHaveBeenCalledTimes(1);
  expect(opts.onSpanEnd).toHaveBeenCalledTimes(1);
  expect(opts.onSpanEnd).toHaveBeenCalledWith(response.statusCode);
  expectBefore(...(missingFirst ? [opts.onUsageMissing, opts.onSpanEnd] : [opts.onSpanEnd, opts.onUsageMissing]));
  expect(auditTrack).toHaveBeenCalledTimes(1);
  expect(auditTrack).toHaveBeenCalledWith('TRACK_END', expect.objectContaining({ result }));
});

test.each([
  ['non-2xx', {}, 401, {}],
  ['missing usage', {}, 200, {}],
  ['Cursor native usage', {}, 200, { path: '/agent.v1.AgentService/RunSSE' }],
  ['partial usage', { streamingUsage: { input_tokens: 10 } }, 200, {}],
])('throwing missing-usage observers do not interrupt %s finalization', (_, state, statusCode, overrides) => {
  const opts = makeOpts({
    ...overrides,
    onUsageMissing: jest.fn(() => { throw new Error('observer failure'); }),
  });
  expect(() => finalizeHttpTracking(makeState(state), { statusCode }, opts)).not.toThrow();
  expect(opts.onUsageMissing).toHaveBeenCalledTimes(1);
  expect(opts.onSpanEnd).toHaveBeenCalledTimes(1);
});

test('throwing budget observers do not suppress metrics, persistence, or span completion', () => {
  const opts = makeOpts({ onUsage: jest.fn(() => { throw new Error('budget observer failure'); }) });
  finalizeHttpTracking(makeState({ streamingUsage: { input_tokens: 10, output_tokens: 5 } }), { statusCode: 200 }, opts);
  expectBefore(opts.onUsage, incrementTokenMetrics);
  expectBefore(incrementTokenMetrics, writeTokenUsage);
  expectBefore(writeTokenUsage, opts.onSpanEnd);
  expect(writeTokenUsage.mock.calls[0][0]).not.toHaveProperty('ai_credits_total');
});

test('cache-read rollup warning is emitted before accounting', () => {
  const opts = makeOpts();
  finalizeHttpTracking(makeState({
    streamingUsage: { input_tokens: 10, output_tokens: 5 },
    observedCacheReadTokens: 50,
  }), { statusCode: 200 }, opts);
  expect(logRequest).toHaveBeenCalledWith('warn', 'token_cache_read_rollup_mismatch',
    expect.objectContaining({ observed_cache_read_tokens: 50, rolled_up_cache_read_tokens: 0 }));
  const warningOrder = diag.mock.invocationCallOrder[diag.mock.calls.findIndex(([event]) => event === 'CACHE_READ_ROLLUP_MISMATCH')];
  expect(warningOrder).toBeLessThan(opts.onUsage.mock.invocationCallOrder[0]);
});

test('span callback exceptions retain their propagation behavior', () => {
  const failure = new Error('span observer failure');
  const opts = makeOpts({ onSpanEnd: jest.fn(() => { throw failure; }) });
  expect(() => finalizeHttpTracking(makeState(), { statusCode: 200 }, opts)).toThrow(failure);
  expect(opts.onUsageMissing).not.toHaveBeenCalled();
});

test('unsupported encoding preserves inspection, missing-usage, span, and Cursor audit ordering', () => {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = { 'content-type': 'text/event-stream', 'content-encoding': 'zstd' };
  const opts = makeOpts({
    path: '/agent.v1.AgentService/RunSSE',
    onSseInspectionStart: jest.fn(),
    onSseInspectionComplete: jest.fn(),
  });
  tracker.trackTokenUsage(response, opts);
  expectBefore(opts.onSseInspectionStart, opts.onSseInspectionComplete);
  expectBefore(opts.onSseInspectionComplete, opts.onUsageMissing);
  expectBefore(opts.onUsageMissing, opts.onSpanEnd);
  expect(opts.onUsageMissing).toHaveBeenCalledTimes(1);
  expect(opts.onSpanEnd).toHaveBeenCalledTimes(1);
  expect(opts.onSseInspectionComplete).toHaveBeenCalledTimes(1);
  expect(auditTrack.mock.calls.map(([event]) => event)).toEqual(['TRACK_START', 'TRACK_SKIP_ENCODING', 'TRACK_END']);
  expect(auditTrack).toHaveBeenLastCalledWith('TRACK_END', expect.objectContaining({
    result: 'unsupported_accounting',
    reason: 'unsupported_content_encoding_zstd',
    content_encoding: 'zstd',
  }));
  expect(writeTokenUsage).not.toHaveBeenCalled();
  expect(incrementTokenMetrics).not.toHaveBeenCalled();
});
