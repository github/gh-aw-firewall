'use strict';

const {
  MAX_PRIVATE_REPO_LENGTH,
  MAX_SCHEMA_BYTES,
  BOUNDED_QUERY_REPO_PATTERN,
  strictParseJson,
  validateSchema,
} = require('./protocol');
const { MAX_TASK_BYTES } = require('./config');

/**
 * Wire framing and request validation for the agent → broker bounded-agent
 * request.
 *
 * Like bounded queries, the scalar/JSON fields travel as fixed headers and the
 * free-form payload (here the bounded task text) travels as the raw body, so
 * the POSIX-sh agent wrapper never has to emit JSON. The broker assembles the
 * canonical `{privateRepo, schema, task}` object itself and validates it
 * against the fixed protocol.
 *
 * The accepted surface is deliberately tiny. Any other `x-awf-*` header, any
 * duplicate header, and any unknown/forbidden request key is rejected — a
 * request can never express an image, command, executable, mount, environment,
 * endpoint, network, proxy, credential, timeout, resource limit, runtime, or
 * tool definition.
 */

/** Supported request framing version. */
const AGENT_PROTOCOL_VERSION = '1';

const VERSION_HEADER = 'x-awf-agent-version';
const REPO_HEADER = 'x-awf-repo';
const SCHEMA_HEADER = 'x-awf-schema-b64';

/** Every header the broker accepts. Anything else is a rejected control. */
const ALLOWED_AWF_HEADERS = new Set([VERSION_HEADER, REPO_HEADER, SCHEMA_HEADER]);

/** The complete set of keys a bounded-agent request may contain. */
const ALLOWED_REQUEST_KEYS = ['privateRepo', 'schema', 'task'];

/**
 * Every accepted spelling of the single free-form payload field.
 *
 * Exactly one of these is accepted per caller surface (`task` for the legacy
 * bounded-agent wrapper protocol, `prompt` for the unified enclave MCP tool);
 * the other is an explicitly forbidden control so a request can never smuggle
 * a second payload past the finite-disclosure charge.
 */
const PAYLOAD_KEYS = ['task', 'prompt'];

/**
 * Controls a request may never express.
 *
 * Redundant with the unknown-key rule below by construction; kept explicit so
 * an accidental future widening of the accepted key set fails a test instead of
 * silently granting a capability.
 */
const BASE_FORBIDDEN_REQUEST_KEYS = [
  'image', 'images', 'command', 'cmd', 'args', 'argv', 'entrypoint', 'executable',
  'interpreter', 'script', 'shell', 'mount', 'mounts', 'volume', 'volumes', 'bind',
  'path', 'paths', 'workdir', 'env', 'environment', 'endpoint', 'endpoints', 'baseUrl',
  'url', 'host', 'network', 'networks', 'dns', 'proxy', 'httpProxy', 'httpsProxy',
  'credential', 'credentials', 'apiKey', 'token', 'authorization', 'headers',
  'timeout', 'timeoutSeconds', 'deadline', 'memory', 'memoryLimit', 'cpu', 'cpuLimit',
  'pids', 'pidsLimit', 'tmpfs', 'ulimit', 'resources', 'runtime', 'backend', 'engine', 'sandbox',
  'profile', 'model', 'provider', 'temperature', 'maxTokens', 'maxModelRequests',
  'tool', 'tools', 'toolChoice', 'functions', 'systemPrompt', 'system', 'messages',
];

/** Forbidden controls for one caller surface: everything plus the other payload spelling. */
function forbiddenKeysFor(payloadKey) {
  return BASE_FORBIDDEN_REQUEST_KEYS.concat(PAYLOAD_KEYS.filter((key) => key !== payloadKey));
}

/** Forbidden controls for the legacy `task` wrapper surface. */
const FORBIDDEN_REQUEST_KEYS = forbiddenKeysFor('task');

/** Base64url alphabet only (no padding, no `+`/`/`). */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Generous ceiling on the encoded header length for a schema of at most `MAX_SCHEMA_BYTES`. */
const MAX_SCHEMA_HEADER_LENGTH = Math.ceil((MAX_SCHEMA_BYTES * 4) / 3) + 4;

/** A peer that stops sending a request body cannot pin a broker connection. */
const BODY_READ_TIMEOUT_MS = 5_000;

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
function buildRequestFromFrame(headers, rawHeaders, task) {
  const headerError = validateRawHeaders(rawHeaders);
  if (headerError) return { error: headerError };

  if (headers[VERSION_HEADER] !== AGENT_PROTOCOL_VERSION) {
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

  return { request: { privateRepo, schema: parsedSchema.value, task } };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an assembled bounded-agent request against the fixed protocol.
 *
 * @returns `{ valid: true, request }` or `{ valid: false, errors }`. Errors are
 *   only ever written to the protected audit log, never returned to the caller.
 */
function validateBoundedAgentRequest(raw, options = {}) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['request must be a JSON object'] };
  }

  // Trusted caller-surface selection, never request data. Exactly one payload
  // spelling is accepted; the others stay forbidden controls.
  const payloadKey = PAYLOAD_KEYS.includes(options.payloadKey) ? options.payloadKey : 'task';
  const allowedKeys = ['privateRepo', 'schema', payloadKey];
  const forbidden = forbiddenKeysFor(payloadKey).filter(
    (key) => Object.prototype.hasOwnProperty.call(raw, key),
  );
  for (const key of forbidden) {
    errors.push(`request may not specify "${key}"`);
  }
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key) && !forbidden.includes(key)) {
      errors.push(`unknown request key: "${key}"`);
    }
  }

  const { privateRepo, schema } = raw;
  const task = raw[payloadKey];

  if (typeof privateRepo !== 'string') {
    errors.push('privateRepo must be a string');
  } else if (privateRepo.length > MAX_PRIVATE_REPO_LENGTH) {
    errors.push('privateRepo exceeds the maximum length');
  } else if (!BOUNDED_QUERY_REPO_PATTERN.test(privateRepo)) {
    errors.push('privateRepo must be a bare owner/repo slug');
  }

  const schemaValidation = validateSchema(schema);
  if (!schemaValidation.valid) {
    errors.push(...schemaValidation.errors);
  }

  const configuredLimit = Number.isInteger(options.maxTaskBytes) && options.maxTaskBytes > 0
    ? options.maxTaskBytes
    : MAX_TASK_BYTES;
  const taskLimit = Math.min(configuredLimit, MAX_TASK_BYTES);
  if (typeof task !== 'string') {
    errors.push(`${payloadKey} must be a string`);
  } else if (task.length === 0) {
    errors.push(`${payloadKey} must not be empty`);
  } else if (Buffer.byteLength(task, 'utf8') > taskLimit) {
    errors.push(`${payloadKey} exceeds the maximum size`);
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    request: { privateRepo, schema: schemaValidation.schema, [payloadKey]: task },
  };
}

/**
 * Reads the request body, refusing anything above the hard task cap.
 *
 * The cap is enforced while streaming so an oversized body is never buffered.
 * The *configured* (possibly smaller) cap is applied by
 * {@link validateBoundedAgentRequest}.
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
      if (total > MAX_TASK_BYTES) {
        finish({ error: 'task exceeds maximum size' });
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(body)) {
        finish({ error: 'task is not valid UTF-8' });
        return;
      }
      finish({ task: text });
    });
    req.on('error', () => finish({ error: 'request stream error' }));
  });
}

module.exports = {
  AGENT_PROTOCOL_VERSION,
  ALLOWED_REQUEST_KEYS,
  MAX_TASK_BYTES,
  PAYLOAD_KEYS,
  BODY_READ_TIMEOUT_MS,
  FORBIDDEN_REQUEST_KEYS,
  forbiddenKeysFor,
  REPO_HEADER,
  SCHEMA_HEADER,
  VERSION_HEADER,
  buildRequestFromFrame,
  readBoundedBody,
  validateBoundedAgentRequest,
};
