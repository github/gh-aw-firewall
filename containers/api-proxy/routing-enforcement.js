'use strict';

/**
 * Record a per-request admit/reject decision. Never throws: observability
 * must not change the routing decision or the live response.
 *
 * @param {{ record: (record: object) => void }} [observer]
 * @param {object} record
 */
function safeRecordDecision(observer, record) {
  try {
    observer?.record?.(Object.freeze({ stage: 'decision', ...record }));
  } catch {
    // Observability must not change the routing decision.
  }
}

/**
 * Enforce the controller's immutable selection at the primary HTTP boundary.
 * Observe terminal failures without changing native response bytes, and drain
 * admitted responses before the host reads final routing status.
 */
function createRoutingEnforcement({ getSelection, getFailure, recordFailure, observer }) {
  let draining = false;
  const active = new Set();
  const waiters = new Set();

  function trackResponse(res) {
    active.add(res);
    function complete() {
      active.delete(res);
      if (!res.writableFinished) {
        recordFailure('provider_unavailable');
      }
      if (active.size === 0) {
        for (const resolve of waiters) {
          resolve();
        }
        waiters.clear();
      }
    }
    res.once('finish', complete);
    res.once('close', () => {
      if (active.has(res)) {
        complete();
      }
    });
  }

  function mismatch() {
    recordFailure('model_routing_mismatch');
    const error = new Error('The request does not match the task model selection');
    error.code = 'model_routing_mismatch';
    error.statusCode = 403;
    error.type = 'model_routing_failed';
    error.retryable = false;
    return error;
  }

  function rejectionBody() {
    const error = mismatch();
    return JSON.stringify({
      error: {
        type: error.type,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    });
  }

  function reject(res) {
    const body = rejectionBody();
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(body);
    return true;
  }

  function observeFailure(res) {
    const originalWrite = res.write;
    const originalEnd = res.end;
    const chunks = [];
    let bytes = 0;
    function collect(chunk, encoding) {
      if (res.statusCode < 400 || !chunk || bytes > 16_384) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      bytes += buffer.length;
      if (bytes <= 16_384) {
        chunks.push(buffer);
      }
    }
    res.write = function(chunk, encoding, callback) {
      collect(chunk, encoding);
      return originalWrite.call(this, chunk, encoding, callback);
    };
    res.end = function(chunk, encoding, callback) {
      collect(chunk, encoding);
      if (res.statusCode >= 400) {
        let code;
        try {
          const error = bytes <= 16_384 ? JSON.parse(Buffer.concat(chunks).toString('utf8')).error : null;
          code = error?.code || error?.type;
        } catch {}
        recordNativeFailure(code);
      }
      return originalEnd.call(this, chunk, encoding, callback);
    };
  }

  function recordNativeFailure(code) {
    recordFailure(typeof code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : 'provider_unavailable');
  }

  return Object.freeze({
    /** Returns true when the request was screened out and the 403 response has been written. */
    screenRequest(req, res, adapter) {
      let pathname;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        safeRecordDecision(observer, { decision: 'reject', reason: 'invalid_url', method: req.method });
        return reject(res);
      }
      if (req.method === 'GET' && /^\/(?:v1\/)?models(?:\/[^/?]+)?$/.test(pathname)) {
        safeRecordDecision(observer, { decision: 'admit', reason: 'model_discovery_exempt', method: req.method, pathname });
        return false;
      }
      const selection = getSelection();
      const responses = /^\/(?:v1\/)?responses$/.test(pathname);
      const chat = /^\/(?:v1\/)?chat\/completions$/.test(pathname);
      const hasEffort = selection && Object.hasOwn(selection.choice, 'effort');
      const rejectReason =
        draining ? 'draining' :
        !selection ? 'no_selection' :
        getFailure() ? 'terminal_failure' :
        adapter.name !== 'copilot' ? 'foreign_adapter' :
        req.method !== 'POST' ? 'method_not_allowed' :
        (!responses && !chat) ? 'unsupported_endpoint' :
        responses !== hasEffort ? 'effort_endpoint_mismatch' :
        Object.keys(req.headers).some(name => /(?:^|[-_])(?:model|reasoning|effort)(?:$|[-_])/i.test(name)) ? 'header_override' :
        null;
      if (rejectReason) {
        safeRecordDecision(observer, { decision: 'reject', reason: rejectReason, method: req.method, pathname });
        return reject(res);
      }
      trackResponse(res);
      observeFailure(res);
      const onSseData = line => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event?.error || event?.type === 'response.failed' || event?.type === 'error') {
          const error = event.error || event.response?.error || event;
          recordNativeFailure(error.code || error.type);
        }
      };
      function rejectBody(reason) {
        safeRecordDecision(observer, { decision: 'reject', reason, method: req.method, pathname });
        throw mismatch();
      }
      const bodyTransform = body => {
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          rejectBody('body_invalid_json');
        }
        if (
          !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          parsed.model !== selection.wire_model || getFailure()
        ) {
          rejectBody('body_model_mismatch');
        }
        if (responses) {
          if (
            !parsed.reasoning || typeof parsed.reasoning !== 'object' || Array.isArray(parsed.reasoning) ||
            parsed.reasoning.effort !== selection.choice.effort || Object.hasOwn(parsed, 'reasoning_effort')
          ) {
            rejectBody('body_effort_mismatch');
          }
        } else if (Object.hasOwn(parsed, 'reasoning_effort') || Object.hasOwn(parsed, 'reasoning')) {
          rejectBody('body_effort_mismatch');
        }
        safeRecordDecision(observer, {
          decision: 'admit',
          reason: 'selected_model_pinned',
          method: req.method,
          pathname,
          selected_model: selection.choice.model,
          selected_effort: selection.choice.effort ?? null,
        });
        return body;
      };
      req.awfRouting = { bodyTransform, onSseData };
      return false;
    },
    async drain() {
      draining = true;
      if (active.size) {
        await new Promise(resolve => waiters.add(resolve));
      }
    },
    rejectUpgrade(socket) {
      safeRecordDecision(observer, { decision: 'reject', reason: 'upgrade_rejected' });
      const body = rejectionBody();
      socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.destroy();
    },
  });
}

module.exports = { createRoutingEnforcement };
