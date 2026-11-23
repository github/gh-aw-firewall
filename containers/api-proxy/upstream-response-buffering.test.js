'use strict';

const { EventEmitter } = require('events');
const {
  shouldBuffer400,
  shouldBufferForFallback,
  shouldCaptureUpstreamError,
  createResponseCapture,
  shouldCaptureErrorBodyChunk,
  captureErrorBodyChunk,
  bufferUpstreamResponse,
} = require('./upstream-response-buffering');

describe('upstream response buffering policy', () => {
  const exhausted = {
    statusCode: 400, provider: 'openai', isRoutingClassifier: false,
    hasRetried: true, modelNotSupportedRetryCount: 2, canFallback: false,
  };

  test.each([
    ['Anthropic beta header', { provider: 'anthropic', hasRetried: false }],
    ['Copilot beta header', { provider: 'copilot', hasRetried: false }],
    ['Copilot catalogue retry', { provider: 'copilot', modelNotSupportedRetryCount: 1 }],
    ['Copilot endpoint retry', { provider: 'copilot', onModelEndpointBlockedRetry: () => true }],
    ['ordered fallback', { canFallback: true }],
  ])('buffers 400s for %s but never routing classifiers', (_name, options) => {
    expect(shouldBuffer400({ ...exhausted, ...options })).toBe(true);
    expect(shouldBuffer400({ ...exhausted, ...options, isRoutingClassifier: true })).toBe(false);
    expect(shouldBuffer400({ ...exhausted, ...options, statusCode: 401 })).toBe(false);
  });

  test.each([
    {},
    { provider: 'copilot' },
    { provider: 'anthropic', modelNotSupportedRetryCount: 0 },
    { provider: 'openai', hasRetried: false, onModelEndpointBlockedRetry: () => true },
  ])('does not buffer 400s without a remaining retry or fallback: %j', options => {
    expect(shouldBuffer400({ ...exhausted, ...options })).toBe(false);
  });

  test.each([199, 200, 299, 300, 400, 401, 403, 404, 429, 499, 500, 503, 599, 600])(
    'preserves status boundaries for %i', statusCode => {
      expect(shouldBufferForFallback({ statusCode, canFallback: true }))
        .toBe(statusCode === 404 || (statusCode >= 500 && statusCode <= 599));
      expect(shouldBufferForFallback({ statusCode, canFallback: false })).toBe(false);
      expect(shouldCaptureUpstreamError({ statusCode, isRoutingClassifier: false }))
        .toBe(statusCode < 200 || statusCode >= 300);
      expect(shouldCaptureUpstreamError({ statusCode, isRoutingClassifier: true })).toBe(false);
    },
  );
});

describe('upstream error capture', () => {
  const originalLimit = process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES;
  afterEach(() => {
    if (originalLimit === undefined) delete process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES;
    else process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES = originalLimit;
  });

  test.each([undefined, 'invalid', '0', '-1', '8'])('resolves capture limit %s per response', value => {
    if (value === undefined) delete process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES;
    else process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES = value;
    expect(createResponseCapture().maxErrorCaptureBytes).toBe(value === '8' ? 8 : 64 * 1024);
  });

  test('bounds capture across chunks without sharing response state', () => {
    process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES = '8';
    const capture = createResponseCapture();
    captureErrorBodyChunk(capture, Buffer.from('abc'));
    captureErrorBodyChunk(capture, Buffer.from('defghijk'));
    captureErrorBodyChunk(capture, Buffer.from('tail'));
    expect(capture.capturedErrorBytes).toBe(8);
    expect(Buffer.concat(capture.capturedErrorChunks).toString()).toBe('abcdefgh');
    expect(capture.errorBodyTruncated).toBe(true);
    expect(createResponseCapture()).toMatchObject({
      responseBytes: 0, capturedErrorBytes: 0, capturedErrorChunks: [], errorBodyTruncated: false,
    });
  });

  test('an exact-limit body is not truncated until more data arrives', () => {
    process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES = '3';
    const capture = createResponseCapture();
    captureErrorBodyChunk(capture, Buffer.from('abc'));
    expect(capture.errorBodyTruncated).toBe(false);
    captureErrorBodyChunk(capture, Buffer.from('d'));
    expect(capture.errorBodyTruncated).toBe(true);
    expect(capture.capturedErrorBytes).toBe(3);
    expect(shouldCaptureErrorBodyChunk(0, 0, 3)).toBe(false);
  });
});

describe('bounded fallback inspection', () => {
  function harness() {
    const proxyRes = new EventEmitter();
    Object.assign(proxyRes, {
      statusCode: 503, headers: { 'content-length': '65542' }, pipe: jest.fn(), pause: jest.fn(),
    });
    const res = new EventEmitter();
    Object.assign(res, { writeHead: jest.fn(), write: jest.fn(() => true) });
    const capture = createResponseCapture();
    const onBuffered = jest.fn();
    const onOversized = jest.fn();
    bufferUpstreamResponse(proxyRes, { res, requestId: 'local-id', capture, onBuffered, onOversized });
    return { proxyRes, res, capture, onBuffered, onOversized };
  }

  test('inspects bodies up to and including 64 KiB only after end', () => {
    const { proxyRes, res, capture, onBuffered, onOversized } = harness();
    const prefix = Buffer.alloc(65535, 'a');
    proxyRes.emit('data', prefix);
    proxyRes.emit('data', Buffer.from('b'));
    expect(onBuffered).not.toHaveBeenCalled();
    proxyRes.emit('end');
    expect(onBuffered).toHaveBeenCalledWith(Buffer.concat([prefix, Buffer.from('b')]));
    expect(capture.responseBytes).toBe(65536);
    expect(onOversized).not.toHaveBeenCalled();
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  test.each([0, 1, 2])('forwards overflow once (backpressure on write %i)', blockedWrite => {
    const { proxyRes, res, capture, onBuffered, onOversized } = harness();
    res.write.mockReturnValueOnce(blockedWrite !== 1).mockReturnValueOnce(blockedWrite !== 2);
    const prefix = Buffer.alloc(65536, 'a');
    const overflow = Buffer.from('b');
    proxyRes.emit('data', prefix);
    proxyRes.emit('data', overflow);
    expect(res.awfUpstreamResponse).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(503, {
      'content-length': '65542', 'x-request-id': 'local-id',
    });
    expect(res.write.mock.calls).toEqual([[prefix], [overflow]]);
    if (blockedWrite) {
      expect(proxyRes.pause).toHaveBeenCalledTimes(1);
      expect(proxyRes.pipe).not.toHaveBeenCalled();
      res.emit('drain');
    } else {
      expect(proxyRes.pause).not.toHaveBeenCalled();
    }
    expect(proxyRes.pipe).toHaveBeenCalledTimes(1);
    expect(proxyRes.pipe).toHaveBeenCalledWith(res);
    proxyRes.emit('data', Buffer.from('tail!'));
    proxyRes.emit('end');
    expect(capture.responseBytes).toBe(65542);
    expect(onBuffered).not.toHaveBeenCalled();
    expect(onOversized).toHaveBeenCalledTimes(1);
    expect(onOversized).toHaveBeenCalledWith(prefix);
  });
});
