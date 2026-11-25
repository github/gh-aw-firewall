'use strict';

require('./test-helpers/token-tracker-setup');

const { EventEmitter } = require('events');
const { initHttpState, wireListeners } = require('./token-tracker-http-state');

function setup(compressed = false) {
  const proxyRes = new EventEmitter();
  const res = new EventEmitter();
  const decompressor = compressed ? new EventEmitter() : null;
  if (decompressor) {
    decompressor.write = jest.fn();
    decompressor.end = jest.fn();
  }
  const state = initHttpState({
    streaming: true,
    compressed,
    contentType: 'text/event-stream',
    contentEncoding: compressed ? 'gzip' : '(none)',
  });
  const onChunk = jest.fn();
  const onFinalize = jest.fn();
  wireListeners(proxyRes, decompressor, state, onChunk, onFinalize, res);
  return { proxyRes, res, decompressor, state, onChunk, onFinalize };
}

test.each([
  ['end', 'close', 'aborted'],
  ['aborted', 'close', 'end'],
  ['close', 'aborted', 'end'],
])('finalizes exactly once for upstream events %j, %j, %j', (...events) => {
  const { proxyRes, onFinalize, onChunk, state } = setup();
  proxyRes.emit('data', Buffer.from('data: test\n\n'));
  for (const event of events) proxyRes.emit(event);
  expect(state.totalBytes).toBe(12);
  expect(onChunk).toHaveBeenCalledWith('data: test\n\n');
  expect(onFinalize).toHaveBeenCalledTimes(1);
});

test('downstream close only finalizes streaming state with accumulated usage', () => {
  const { proxyRes, res, onFinalize, state } = setup();
  res.emit('close');
  expect(onFinalize).not.toHaveBeenCalled();
  state.streamingUsage = { input_tokens: 10, output_tokens: 5 };
  res.emit('close');
  proxyRes.emit('aborted');
  proxyRes.emit('end');
  expect(onFinalize).toHaveBeenCalledTimes(1);
});

test.each(['end', 'aborted', 'close'])('compressed %s waits for the decompressor to flush before finalizing', event => {
  const { proxyRes, decompressor, onFinalize, onChunk, state } = setup(true);
  const compressed = Buffer.from([1, 2, 3]);
  proxyRes.emit('data', compressed);
  expect(state.totalBytes).toBe(3);
  expect(decompressor.write).toHaveBeenCalledWith(compressed);
  expect(onChunk).not.toHaveBeenCalled();
  proxyRes.emit(event);
  proxyRes.emit('close');
  expect(decompressor.end).toHaveBeenCalledTimes(1);
  expect(onFinalize).not.toHaveBeenCalled();
  decompressor.emit('data', Buffer.from('decoded text'));
  expect(onChunk).toHaveBeenCalledWith('decoded text');
  decompressor.emit('end');
  proxyRes.emit('aborted');
  expect(onFinalize).toHaveBeenCalledTimes(1);
});

test('decompression errors on premature close finalize only once', () => {
  const { proxyRes, decompressor, onFinalize } = setup(true);
  proxyRes.emit('aborted');
  decompressor.emit('error', new Error('truncated compressed response'));
  decompressor.emit('end');
  proxyRes.emit('close');
  expect(onFinalize).toHaveBeenCalledTimes(1);
});
