'use strict';

require('./test-helpers/token-tracker-setup');

jest.mock('./logging', () => ({ logRequest: jest.fn() }));
jest.mock('./token-persistence', () => ({
  ...jest.requireActual('./token-persistence'),
  auditTrack: jest.fn(),
  writeTokenUsage: jest.fn(),
  incrementTokenMetrics: jest.fn(),
}));

const { EventEmitter } = require('events');
const { trackTokenUsage } = require('./token-tracker-http');
const { auditTrack, writeTokenUsage, incrementTokenMetrics } = require('./token-persistence');
const { logRequest } = require('./logging');

const RUN_SSE = '/agent.v1.AgentService/RunSSE';

function trackResponse({ path = RUN_SSE, contentType = 'text/event-stream', contentEncoding, status = 200, body = '', ...opts } = {}) {
  const response = new EventEmitter();
  response.headers = { 'content-type': contentType };
  if (contentEncoding) response.headers['content-encoding'] = contentEncoding;
  response.statusCode = status;
  const onUsage = jest.fn();
  const onSpanEnd = jest.fn();
  trackTokenUsage(response, {
    requestId: 'shared-native-request',
    provider: 'openai',
    path,
    startTime: Date.now(),
    onUsage,
    onSpanEnd,
    ...opts,
  });
  const bytes = Buffer.from(body);
  response.emit('data', bytes.subarray(0, 7));
  response.emit('data', bytes.subarray(7));
  response.emit('end');
  response.emit('close');
  return { onUsage, onSpanEnd };
}

beforeEach(() => jest.clearAllMocks());

test('successful opaque native stream explicitly reports unsupported accounting without estimating tokens', () => {
  // Synthetic opaque data exercises routing, not a captured Cursor usage contract.
  const { onUsage, onSpanEnd } = trackResponse({ body: 'data: AAEC\n\n'.repeat(100) });
  expect(auditTrack).toHaveBeenLastCalledWith('TRACK_END', {
    rid: 'shared-native-request',
    result: 'unsupported_accounting',
    provider: 'openai',
    path: RUN_SSE,
    status: 200,
    streaming: true,
    protocol: 'cursor-runsse',
    reason: 'native_usage_contract_unverified',
  });
  expect(logRequest).toHaveBeenCalledWith('warn', 'token_track_unsupported_accounting',
    expect.objectContaining({ protocol: 'cursor-runsse', message: expect.stringContaining('does not mean zero cost') }));
  expect(writeTokenUsage).not.toHaveBeenCalled();
  expect(incrementTokenMetrics).not.toHaveBeenCalled();
  expect(onUsage).not.toHaveBeenCalled();
  expect(onSpanEnd).toHaveBeenCalledTimes(1);
  expect(onSpanEnd).toHaveBeenCalledWith(200);
  expect(auditTrack.mock.calls.filter(([event]) => event === 'TRACK_END')).toHaveLength(1);
});

test('BidiAppend sharing a request ID cannot overwrite the native stream accounting state', () => {
  trackResponse({ body: 'data: AAEC\n\n' });
  trackResponse({
    path: '/aiserver.v1.BidiService/BidiAppend',
    contentType: 'application/proto',
    body: '\x00\x01\x02',
  });
  const ends = auditTrack.mock.calls.filter(([event]) => event === 'TRACK_END').map(([, record]) => record);
  expect(ends).toHaveLength(2);
  expect(ends[0]).toMatchObject({ rid: 'shared-native-request', streaming: true, result: 'unsupported_accounting', path: RUN_SSE });
  expect(ends[1]).toMatchObject({ rid: 'shared-native-request', streaming: false, result: 'no_usage' });
  expect(writeTokenUsage).not.toHaveBeenCalled();
});

test('Connect-framed binary data advertised as text/event-stream is not treated as token usage', () => {
  // Synthetic five-byte Connect envelopes, not an authoritative usage fixture.
  const body = Buffer.from([0, 0, 0, 0, 2, 8, 1, 2, 0, 0, 0, 2, 123, 125]);
  const { onUsage } = trackResponse({ body });
  expect(auditTrack).toHaveBeenLastCalledWith('TRACK_END',
    expect.objectContaining({ result: 'unsupported_accounting', protocol: 'cursor-runsse' }));
  expect(writeTokenUsage).not.toHaveBeenCalled();
  expect(onUsage).not.toHaveBeenCalled();
});

test.each(['', 'data: [DONE]\n\n', 'data: {"unknownUsage":{"tokens":123}}\n\n'])(
  'missing native usage reports unsupported accounting (%j)', (body) => {
    trackResponse({ body, path: `${RUN_SSE}?request=example` });
    expect(auditTrack).toHaveBeenLastCalledWith('TRACK_END',
      expect.objectContaining({ result: 'unsupported_accounting', path: RUN_SSE }));
    expect(writeTokenUsage).not.toHaveBeenCalled();
  },
);

test.each([
  { path: '/v1/chat/completions' },
  { contentType: 'application/proto' },
  { path: `${RUN_SSE}Other` },
])('unrelated missing usage retains no_usage (%j)', (opts) => {
  trackResponse(opts);
  expect(auditTrack).toHaveBeenLastCalledWith('TRACK_END', expect.objectContaining({ result: 'no_usage' }));
  expect(logRequest).not.toHaveBeenCalledWith('warn', 'token_track_unsupported_accounting', expect.anything());
});

test('successful native streams with unsupported encoding report unsupported accounting without a token record', () => {
  trackResponse({ contentEncoding: 'zstd', body: 'opaque compressed bytes' });
  expect(auditTrack).toHaveBeenCalledWith('TRACK_SKIP_ENCODING', {
    rid: 'shared-native-request',
    ce: 'zstd',
  });
  expect(auditTrack).toHaveBeenLastCalledWith('TRACK_END', {
    rid: 'shared-native-request',
    result: 'unsupported_accounting',
    provider: 'openai',
    path: RUN_SSE,
    status: 200,
    streaming: true,
    protocol: 'cursor-runsse',
    reason: 'unsupported_content_encoding_zstd',
    content_encoding: 'zstd',
  });
  expect(logRequest).toHaveBeenCalledWith('warn', 'token_track_unsupported_accounting',
    expect.objectContaining({
      protocol: 'cursor-runsse',
      reason: 'unsupported_content_encoding_zstd',
      content_encoding: 'zstd',
    }));
  expect(writeTokenUsage).not.toHaveBeenCalled();
  expect(incrementTokenMetrics).not.toHaveBeenCalled();
});

test('unsuccessful native responses retain skip_status', () => {
  trackResponse({ status: 401 });
  expect(auditTrack).toHaveBeenLastCalledWith('TRACK_END', expect.objectContaining({ result: 'skip_status', status: 401 }));
  expect(writeTokenUsage).not.toHaveBeenCalled();
});

test.each([
  ['openai', [{ model: 'gpt-4o', usage: { prompt_tokens: 12, completion_tokens: 7 } }], 'gpt-4o'],
  ['anthropic', [
    { type: 'message_start', message: { model: 'claude-sonnet-4', usage: { input_tokens: 12 } } },
    { type: 'message_delta', usage: { output_tokens: 7 } },
  ], 'claude-sonnet-4'],
  ['gemini', [{ modelVersion: 'gemini-2.5-pro', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 } }], 'gemini-2.5-pro'],
])('recognized %s usage still reaches accounting even on the native route', (provider, events, model) => {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const { onUsage } = trackResponse({ provider, body });
  expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ input_tokens: 12, output_tokens: 7 }), model);
  expect(writeTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ provider, model, input_tokens: 12, output_tokens: 7 }));
  expect(auditTrack).toHaveBeenLastCalledWith('TRACK_END', expect.objectContaining({ result: 'ok' }));
});
