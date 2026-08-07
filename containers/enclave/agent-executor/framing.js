'use strict';

const {
  MAX_PRIVATE_REPO_LENGTH,
  PRIVATE_REPOSITORY_PATTERN,
  validateSchema,
} = require('../../bounded-execution/finite-disclosure');
const MAX_TASK_BYTES = 64 * 1024;

/**
 * Request validation for the MCP server's agent executor.
 *
 * The accepted surface is deliberately tiny. Any other `x-awf-*` header, any
 * duplicate header, and any unknown/forbidden request key is rejected — a
 * request can never express an image, command, executable, mount, environment,
 * endpoint, network, proxy, credential, timeout, resource limit, runtime, or
 * tool definition.
 */

const PAYLOAD_KEY = 'prompt';

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
  'profile', 'model', 'provider', 'temperature', 'maxTokens',
  'tool', 'tools', 'toolChoice', 'functions', 'systemPrompt', 'system', 'messages',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an assembled enclave-agent request against the fixed protocol.
 *
 * @returns `{ valid: true, request }` or `{ valid: false, errors }`. Errors are
 *   only ever written to the protected audit log, never returned to the caller.
 */
function validateEnclaveAgentRequest(raw, options = {}) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['request must be a JSON object'] };
  }

  const allowedKeys = ['privateRepo', 'schema', PAYLOAD_KEY];
  const forbidden = BASE_FORBIDDEN_REQUEST_KEYS.concat(['task']).filter(
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
  const prompt = raw[PAYLOAD_KEY];

  if (typeof privateRepo !== 'string') {
    errors.push('privateRepo must be a string');
  } else if (privateRepo.length > MAX_PRIVATE_REPO_LENGTH) {
    errors.push('privateRepo exceeds the maximum length');
  } else if (!PRIVATE_REPOSITORY_PATTERN.test(privateRepo)) {
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
  if (typeof prompt !== 'string') {
    errors.push(`${PAYLOAD_KEY} must be a string`);
  } else if (prompt.length === 0) {
    errors.push(`${PAYLOAD_KEY} must not be empty`);
  } else if (Buffer.byteLength(prompt, 'utf8') > taskLimit) {
    errors.push(`${PAYLOAD_KEY} exceeds the maximum size`);
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    request: { privateRepo, schema: schemaValidation.schema, prompt },
  };
}

module.exports = {
  MAX_TASK_BYTES,
  validateEnclaveAgentRequest,
};
