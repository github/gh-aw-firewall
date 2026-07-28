'use strict';

const { MAX_SCRIPT_BYTES, OUTCOME_COUNT } = require('./protocol');

/**
 * Wire framing for the agent → broker request.
 *
 * The request is deliberately *not* caller-supplied JSON: the agent-facing
 * wrapper is a POSIX shell script, and asking it to emit correct JSON for
 * arbitrary script bytes would be both fragile and an unnecessary parser on
 * the untrusted path. Instead the three scalar fields travel as fixed headers
 * and the script travels as the raw body, and the broker assembles the
 * canonical request object itself.
 *
 * The assembled object is then validated by the shared protocol rules, so the
 * framing adds no new degrees of freedom.
 */

/** Supported request framing version. */
const PROBE_PROTOCOL_VERSION = '1';

const VERSION_HEADER = 'x-awf-probe-version';
const REPO_HEADER = 'x-awf-repo';
const OUTCOME_HEADERS = ['x-awf-outcome-1', 'x-awf-outcome-2', 'x-awf-outcome-3'];

/** Every header the broker accepts. Anything else is a rejected control. */
const ALLOWED_AWF_HEADERS = new Set([VERSION_HEADER, REPO_HEADER, ...OUTCOME_HEADERS]);

/**
 * Rejects duplicated or unexpected `x-awf-*` headers.
 *
 * Duplicates matter because Node joins repeated headers with `", "`, which
 * would silently synthesize a fourth outcome value out of two.
 */
function validateRawHeaders(rawHeaders) {
  const seen = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (!name.startsWith('x-awf-')) continue;
    if (!ALLOWED_AWF_HEADERS.has(name)) {
      return `unsupported request control header: ${name}`;
    }
    if (seen.has(name)) {
      return `duplicate request header: ${name}`;
    }
    seen.add(name);
  }
  return undefined;
}

/**
 * Assembles the canonical request object from a framed HTTP request.
 *
 * @returns `{ request }` on success or `{ error }` with a protected reason.
 */
function buildRequestFromFrame(headers, rawHeaders, script) {
  const headerError = validateRawHeaders(rawHeaders);
  if (headerError) return { error: headerError };

  if (headers[VERSION_HEADER] !== PROBE_PROTOCOL_VERSION) {
    return { error: 'unsupported or missing protocol version' };
  }

  const privateRepo = headers[REPO_HEADER];
  if (typeof privateRepo !== 'string') {
    return { error: 'missing repository selector' };
  }

  const outcomes = [];
  for (const header of OUTCOME_HEADERS) {
    const value = headers[header];
    if (typeof value !== 'string') {
      return { error: `missing outcome header: ${header}` };
    }
    outcomes.push(value);
  }
  if (outcomes.length !== OUTCOME_COUNT) {
    return { error: 'wrong number of outcomes' };
  }

  return { request: { privateRepo, outcomes, script } };
}

/**
 * Reads the request body, refusing anything above the script cap.
 *
 * The cap is enforced while streaming so an oversized body is never buffered.
 */
function readBoundedBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_SCRIPT_BYTES) {
        // Stop buffering immediately so an oversized body cannot exhaust
        // memory. The request is paused rather than destroyed so the caller
        // can still write the canonical error response; Node closes the
        // socket once that response is flushed.
        finish({ error: 'script exceeds maximum size' });
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(body)) {
        finish({ error: 'script is not valid UTF-8' });
        return;
      }
      finish({ script: text });
    });
    req.on('error', () => finish({ error: 'request stream error' }));
  });
}

module.exports = {
  PROBE_PROTOCOL_VERSION,
  VERSION_HEADER,
  REPO_HEADER,
  OUTCOME_HEADERS,
  buildRequestFromFrame,
  readBoundedBody,
};
