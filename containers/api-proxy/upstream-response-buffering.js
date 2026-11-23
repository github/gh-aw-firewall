'use strict';

/** Maximum number of times to retry a Copilot 400 "model not supported" response. */
const MAX_MODEL_NOT_SUPPORTED_RETRIES = 2;
const MAX_FALLBACK_INSPECTION_BYTES = 64 * 1024;

function shouldBuffer400({
  statusCode, provider, isRoutingClassifier, hasRetried,
  modelNotSupportedRetryCount, onModelEndpointBlockedRetry, canFallback,
}) {
  // Inspect 400s for deprecated beta headers, transient catalogue errors,
  // endpoint-blocked models, or the ordered model fallback chain.
  return !isRoutingClassifier && statusCode === 400 && (
    ((provider === 'anthropic' || provider === 'copilot') && !hasRetried) ||
    (provider === 'copilot' && modelNotSupportedRetryCount < MAX_MODEL_NOT_SUPPORTED_RETRIES) ||
    (provider === 'copilot' && !!onModelEndpointBlockedRetry) ||
    canFallback
  );
}

function shouldBufferForFallback({ statusCode, canFallback }) {
  // Buffer only when the original error could be swallowed by a model switch.
  return canFallback && (statusCode === 404 || (statusCode >= 500 && statusCode <= 599));
}

function shouldCaptureUpstreamError({ statusCode, isRoutingClassifier }) {
  return !isRoutingClassifier && (statusCode < 200 || statusCode >= 300);
}

function createResponseCapture() {
  const configuredLimit = Number.parseInt(process.env.AWF_MAX_ERROR_RESPONSE_CAPTURE_BYTES, 10);
  return {
    responseBytes: 0,
    capturedErrorBytes: 0,
    errorBodyTruncated: false,
    capturedErrorChunks: [],
    maxErrorCaptureBytes: configuredLimit > 0 ? configuredLimit : 64 * 1024,
  };
}

function shouldCaptureErrorBodyChunk(currentBytes, chunkLength, maxCaptureBytes) {
  return currentBytes < maxCaptureBytes && chunkLength > 0;
}

function captureErrorBodyChunk(capture, chunk) {
  if (!shouldCaptureErrorBodyChunk(capture.capturedErrorBytes, chunk.length, capture.maxErrorCaptureBytes)) {
    capture.errorBodyTruncated = true;
    return;
  }
  const remaining = capture.maxErrorCaptureBytes - capture.capturedErrorBytes;
  const toCapture = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  capture.capturedErrorChunks.push(toCapture);
  capture.capturedErrorBytes += toCapture.length;
  if (chunk.length > remaining) capture.errorBodyTruncated = true;
}

function forwardOversizedBufferedResponse(proxyRes, res, bufferedChunks, currentChunk, { requestId, onEnd }) {
  const responseBody = Buffer.concat(bufferedChunks);
  const resHeaders = { ...proxyRes.headers, 'x-request-id': requestId };
  res.awfUpstreamResponse = true;
  res.writeHead(proxyRes.statusCode, resHeaders);
  const canWritePrefix = res.write(responseBody);
  const canWriteChunk = res.write(currentChunk);
  if (canWritePrefix && canWriteChunk) {
    proxyRes.pipe(res);
  } else {
    proxyRes.pause();
    res.once('drain', () => proxyRes.pipe(res));
  }
  proxyRes.once('end', () => onEnd(responseBody));
}

function bufferUpstreamResponse(proxyRes, { res, requestId, capture, onBuffered, onOversized }) {
  const bufferedChunks = [];
  let bufferedBytes = 0;
  let fallbackBufferExceeded = false;
  proxyRes.on('data', (chunk) => {
    capture.responseBytes += chunk.length;
    if (fallbackBufferExceeded) return;
    if (bufferedBytes + chunk.length > MAX_FALLBACK_INSPECTION_BYTES) {
      fallbackBufferExceeded = true;
      forwardOversizedBufferedResponse(proxyRes, res, bufferedChunks, chunk, {
        requestId, onEnd: onOversized,
      });
      return;
    }
    bufferedChunks.push(chunk);
    bufferedBytes += chunk.length;
  });
  proxyRes.on('end', () => {
    if (!fallbackBufferExceeded) onBuffered(Buffer.concat(bufferedChunks));
  });
}

module.exports = {
  MAX_MODEL_NOT_SUPPORTED_RETRIES,
  shouldBuffer400,
  shouldBufferForFallback,
  shouldCaptureUpstreamError,
  createResponseCapture,
  shouldCaptureErrorBodyChunk,
  captureErrorBodyChunk,
  forwardOversizedBufferedResponse,
  bufferUpstreamResponse,
};
