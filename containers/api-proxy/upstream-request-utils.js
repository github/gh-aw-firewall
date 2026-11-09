'use strict';

const { protocolForPath } = require('./cross-provider-fallback');

function canonicalEndpoint(path) {
  const protocol = protocolForPath(path);
  return protocol === 'chat' ? '/chat/completions'
    : protocol === 'responses' ? '/responses'
      : protocol === 'messages' ? '/v1/messages' : null;
}

function rebuildBodyFramingHeaders(headers, bodyLength) {
  const reframedHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName !== 'content-length' && lowerName !== 'transfer-encoding') {
      reframedHeaders[name] = value;
    }
  }
  reframedHeaders['content-length'] = String(bodyLength);
  return reframedHeaders;
}

function getRequestCancellation(req, res) {
  if (req.awfUpstreamCancellation) return req.awfUpstreamCancellation;

  const controller = new AbortController();
  const externalSignal = req.awfRequestContext?.signal;
  const cancellation = {
    controller,
    cancelled: false,
    finalized: false,
    responseStarted: false,
    activeAttempt: null,
    onCancel: null,
    cancel() {
      if (cancellation.cancelled) return;
      cancellation.cancelled = true;
      cancellation.activeAttempt?.settleMissing();
      externalSignal?.removeEventListener('abort', cancellation.cancel);
      controller.abort();
      cancellation.onCancel?.();
    },
  };
  req.awfUpstreamCancellation = cancellation;

  if (res && typeof res.once === 'function') {
    res.once('close', () => {
      if (!res.writableFinished) cancellation.cancel();
    });
    if (externalSignal) {
      res.once('finish', () => externalSignal.removeEventListener('abort', cancellation.cancel));
    }
  }
  if (externalSignal) {
    if (externalSignal.aborted) cancellation.cancel();
    else externalSignal.addEventListener('abort', cancellation.cancel, { once: true });
  }
  if (res?.destroyed && !res.writableFinished) cancellation.cancel();
  return cancellation;
}

module.exports = {
  canonicalEndpoint,
  rebuildBodyFramingHeaders,
  getRequestCancellation,
};
