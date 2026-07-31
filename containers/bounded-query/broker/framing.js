'use strict';

const { MAX_SCHEMA_BYTES, MAX_SCRIPT_BYTES, strictParseJson } = require('./protocol');

/** A peer that stops sending a request body cannot pin a broker connection. */
const BODY_READ_TIMEOUT_MS = 5_000;

/**
 * Wire framing for the agent → broker request (protocol v2).
 *
 * The request is deliberately *not* caller-supplied JSON at the transport
 * level: the agent-facing wrapper is a POSIX shell script, and asking it to
 * emit correct JSON for arbitrary script bytes would be both fragile and an
 * unnecessary parser on the untrusted path. Instead the scalar/JSON fields
 * travel as fixed headers and the script travels as the raw body, and the
 * broker assembles the canonical `{privateRepo, schema, script}` request
 * object itself.
 *
 * The schema travels base64url-encoded in a header (not the body) because
 * HTTP header values are restricted to a printable-ASCII-ish subset, while a
 * `const`/`enum` schema literal may contain arbitrary non-control UTF-8. The
 * assembled object is then validated by the shared protocol rules
 * (`validateBoundedQueryRequest`), so this framing layer adds no new degrees
 * of freedom — it only assembles the object and enforces cheap size/shape
 * bounds before that shared validation runs.
 */

/** Supported request framing version. */
const QUERY_PROTOCOL_VERSION = '2';

const VERSION_HEADER = 'x-awf-query-version';
const REPO_HEADER = 'x-awf-repo';
const SCHEMA_HEADER = 'x-awf-schema-b64';

/** Every header the broker accepts. Anything else is a rejected control. */
const ALLOWED_AWF_HEADERS = new Set([VERSION_HEADER, REPO_HEADER, SCHEMA_HEADER]);

/** Base64url alphabet only (no padding, no `+`/`/`). */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Generous ceiling on the encoded header length for a schema of at most `MAX_SCHEMA_BYTES`. */
const MAX_SCHEMA_HEADER_LENGTH = Math.ceil((MAX_SCHEMA_BYTES * 4) / 3) + 4;

/**
 * Rejects duplicated or unexpected `x-awf-*` headers.
 *
 * Duplicates matter because Node joins repeated headers with `", "`, which
 * would silently corrupt a base64url value or a repo slug.
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

/** Decodes and UTF-8-validates the base64url schema header. */
function decodeSchemaHeader(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SCHEMA_HEADER_LENGTH) {
    return undefined;
  }
  if (!BASE64URL_PATTERN.test(value)) return undefined;

  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    return undefined;
  }
  const text = decoded.toString('utf8');
  // Reject anything that was not valid UTF-8 to begin with (round-trip check).
  if (!Buffer.from(text, 'utf8').equals(decoded)) return undefined;
  return text;
}

/**
 * Assembles the canonical request object from a framed HTTP request.
 *
 * @returns `{ request }` on success or `{ error }` with a protected reason.
 */
function buildRequestFromFrame(headers, rawHeaders, script) {
  const headerError = validateRawHeaders(rawHeaders);
  if (headerError) return { error: headerError };

  if (headers[VERSION_HEADER] !== QUERY_PROTOCOL_VERSION) {
    return { error: 'unsupported or missing protocol version' };
  }

  const privateRepo = headers[REPO_HEADER];
  if (typeof privateRepo !== 'string') {
    return { error: 'missing repository selector' };
  }

  const schemaText = decodeSchemaHeader(headers[SCHEMA_HEADER]);
  if (schemaText === undefined) {
    return { error: 'missing or malformed schema header' };
  }

  const parsedSchema = strictParseJson(schemaText);
  if (!parsedSchema) {
    return { error: 'schema header is not valid JSON' };
  }

  return { request: { privateRepo, schema: parsedSchema.value, script } };
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
    const timer = setTimeout(() => {
      req.pause();
      finish({ error: 'request body deadline exceeded' });
    }, BODY_READ_TIMEOUT_MS);
    timer.unref();

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
  QUERY_PROTOCOL_VERSION,
  VERSION_HEADER,
  REPO_HEADER,
  SCHEMA_HEADER,
  buildRequestFromFrame,
  readBoundedBody,
  BODY_READ_TIMEOUT_MS,
};
