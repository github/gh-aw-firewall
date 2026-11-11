'use strict';

const { Transform, PassThrough, pipeline } = require('stream');
const zlib = require('zlib');

const credentials = new WeakMap();
const headerCredentials = new WeakMap();
const patternCache = new WeakMap();
const maskCache = new WeakMap();
const PUBLIC_INJECTED_HEADERS = new Set([
  'anthropic-version', 'anthropic-beta', 'copilot-integration-id', 'x-github-api-version',
]);

function markCredentialHeaders(headers, values) {
  headerCredentials.set(headers, values.filter(value => typeof value === 'string' && value.length > 0));
  return headers;
}

function getHeaderCredentials(headers) {
  return headerCredentials.get(headers) || [];
}

function rememberInjectedCredentials(req, headers) {
  let values = credentials.get(req);
  if (!values) credentials.set(req, values = new Set());
  const marked = getHeaderCredentials(headers);
  for (const value of marked) values.add(value);
  for (const [name, value] of Object.entries(headers || {})) {
    if (PUBLIC_INJECTED_HEADERS.has(name.toLowerCase())) continue;
    if (marked.length && name.toLowerCase() !== 'authorization') continue;
    if (typeof value !== 'string' || !value) continue;
    values.add(value);
    if (name.toLowerCase() === 'authorization') {
      const token = value.replace(/^(?:Bearer|token)\s+/i, '');
      values.add(token);
      if (value.startsWith('AWS4-HMAC-SHA256 ')) {
        const accessKey = /Credential=([^/,\s]+)/.exec(value)?.[1];
        const signature = /Signature=([^,\s]+)/.exec(value)?.[1];
        if (accessKey) values.add(accessKey);
        if (signature) values.add(signature);
      }
    }
  }
}

function credentialPatterns(req) {
  const size = credentials.get(req)?.size || 0;
  const cached = patternCache.get(req);
  if (cached?.size === size) return cached.patterns;
  const values = new Set();
  for (const value of credentials.get(req) || []) {
    values.add(value);
    values.add(JSON.stringify(value).slice(1, -1));
  }
  const patterns = [...values]
    .map(value => Buffer.from(value))
    .sort((a, b) => b.length - a.length);
  patternCache.set(req, { size, patterns });
  return patterns;
}

function maskByte(patterns) {
  if (maskCache.has(patterns)) return maskCache.get(patterns);
  for (const byte of [0x2a, 0x23, 0x7e, ...Array.from({ length: 94 }, (_, i) => i + 33)]) {
    if (byte !== 0x22 && byte !== 0x5c && patterns.every(pattern => !pattern.includes(byte))) {
      maskCache.set(patterns, byte);
      return byte;
    }
  }
  throw new Error('Upstream credential cannot be safely masked');
}

function maskCredentialPrefix(req, input, final = false) {
  const patterns = credentialPatterns(req);
  const replacement = maskByte(patterns);
  let end = input.length;
  for (const pattern of patterns) {
    let pos = 0;
    while ((pos = input.indexOf(pattern, pos)) !== -1) {
      // Retain original bytes that may complete a longer credential.
      if (!final && pos >= end) break;
      input.fill(replacement, pos, pos + pattern.length);
      pos += pattern.length;
    }
    if (final) continue;
    for (let length = Math.min(pattern.length - 1, input.length); length > 0; length--) {
      if (input.subarray(input.length - length).equals(pattern.subarray(0, length))) {
        end = Math.min(end, input.length - length);
        break;
      }
    }
  }
  return end;
}

function redactCredentialText(req, value) {
  if (typeof value !== 'string') return value;
  const patterns = credentialPatterns(req);
  if (!patterns.some(pattern => value.includes(pattern.toString()))) return value;
  const replacement = String.fromCharCode(maskByte(patterns));
  for (const pattern of patterns) {
    value = value.split(pattern.toString()).join(replacement.repeat(pattern.length));
  }
  return value;
}

function redactCredentialError(req, error) {
  const safe = new Error(redactCredentialText(req, error.message));
  safe.name = redactCredentialText(req, error.name);
  safe.code = redactCredentialText(req, error.code);
  safe.stack = redactCredentialText(req, error.stack);
  return safe;
}

function protectResponseHeaders(req, headers) {
  const protectedHeaders = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (redactCredentialText(req, name) !== name) continue;
    protectedHeaders[name] = Array.isArray(value)
      ? value.map(item => redactCredentialText(req, item))
      : redactCredentialText(req, value);
  }
  return protectedHeaders;
}

/**
 * Hold only a suffix that could complete a credential in the next chunk.
 * Same-byte-length masking preserves JSON syntax and identity response framing.
 */
function createCredentialTransform(req) {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const input = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
        const end = maskCredentialPrefix(req, input);
        if (end) this.push(input.subarray(0, end));
        pending = Buffer.from(input.subarray(end));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        if (pending.length) {
          maskCredentialPrefix(req, pending, true);
          this.push(pending);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

function protectUpstreamResponse(source, req) {
  if (!credentials.get(req)?.size) return source;
  const headers = protectResponseHeaders(req, source.headers);
  const hasBody = req.method !== 'HEAD' && ![204, 205, 304].includes(source.statusCode);
  const encodings = hasBody ? String(headers['content-encoding'] || 'identity')
    .split(',').map(value => value.trim().toLowerCase()).filter(value => value !== 'identity') : [];
  const codecs = {
    gzip: [zlib.createGunzip, () => zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH })],
    deflate: [zlib.createInflate, () => zlib.createDeflate({ flush: zlib.constants.Z_SYNC_FLUSH })],
    br: [zlib.createBrotliDecompress, () => zlib.createBrotliCompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH })],
  };
  if (encodings.some(encoding => !codecs[encoding])) {
    throw new Error('Unsupported upstream response content encoding');
  }
  const transforms = [
    ...encodings.slice().reverse().map(encoding => codecs[encoding][0]()),
    createCredentialTransform(req),
    ...encodings.map(encoding => codecs[encoding][1]()),
  ];
  if (encodings.length) {
    delete headers['content-length'];
    delete headers['transfer-encoding'];
  }
  // Integrity metadata describes the original representation, not a masked one.
  for (const name of ['etag', 'content-md5', 'digest', 'content-digest', 'repr-digest']) delete headers[name];
  const output = new PassThrough();
  output.statusCode = source.statusCode;
  output.headers = headers;
  // The response handler owns the output's error event and client error response.
  pipeline(source, ...transforms, output, () => {});
  return output;
}

module.exports = {
  rememberInjectedCredentials,
  markCredentialHeaders,
  getHeaderCredentials,
  redactCredentialText,
  redactCredentialError,
  protectResponseHeaders,
  createCredentialTransform,
  maskCredentialPrefix,
  protectUpstreamResponse,
};
