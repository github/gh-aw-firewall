'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const { strictParseJson } = require('../../bounded-execution/finite-disclosure');

/**
 * Broker side of the broker-to-host enclave executor protocol, version 1
 * (ADR 0002).
 *
 * This is the broker-owned mirror of `src/enclave/host-executor-protocol.ts`.
 * The broker runs inside its own container image and cannot import AWF's
 * TypeScript sources, so the wire rules are restated here and pinned by
 * `src/enclave/host-executor-protocol.test.ts`, which drives this client
 * against the real host server over a Unix socket.
 *
 * The client can only express the closed request types and fields below. It
 * never sends a command, argv, path, mount, environment, network endpoint,
 * credential, image, model, runtime profile, resource limit, or timeout: the
 * host derives all of those from its own trusted run state.
 *
 * Not wired into the broker yet; Cloud Hypervisor enclave execution remains
 * fail-closed until the remaining ADR 0002 gates are implemented.
 */

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 8 * 1024;
const FRAME_HEADER_BYTES = 4;
const DEFAULT_TIMEOUT_MS = 10_000;

const ID_PATTERN = /^[0-9a-f]{16,64}$/;
const ENTRY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;

const EXECUTOR_KINDS = new Set(['script', 'agent']);
const STATES = new Set(['running', 'cancelling', 'terminal', 'settled']);
const OUTCOMES = new Set(['success', 'schema-failure', 'executor-failure', 'timeout', 'cancelled']);
const ERRORS = new Set(['denied', 'replayed', 'conflict', 'unknown-invocation', 'invalid-state', 'closed']);

const INVOKE_ARGUMENT_KEYS = new Set([
  'entryId', 'invocationId', 'executorKind', 'seedId', 'selector', 'payload', 'schemaHash', 'admissionId',
]);
const SUCCESS_RESPONSE_KEYS = new Set([
  'version', 'ok', 'requestId', 'invocationId', 'state', 'cancelGeneration', 'outcome', 'result', 'resultDigest',
]);
const FAILURE_RESPONSE_KEYS = new Set(['version', 'ok', 'requestId', 'error']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isWellFormedString(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertPattern(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Host executor request ${name} is invalid`);
  }
}

function readCapability(capabilityPath) {
  let fd;
  try {
    fd = fs.openSync(capabilityPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== 64) throw new Error('invalid capability file');
    const value = fs.readFileSync(fd, 'utf8');
    if (!CAPABILITY_PATTERN.test(value)) throw new Error('invalid capability file');
    return value;
  } catch {
    throw new Error('Host executor capability is unavailable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Strictly parses one response payload; returns `undefined` if it is not a valid v1 response. */
function parseHostExecutorResponse(payload, requestId) {
  if (!Buffer.isBuffer(payload) || payload.length === 0 || payload.length > MAX_RESPONSE_BYTES) return undefined;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
  } catch {
    return undefined;
  }
  if (!strictParseJson(text)) return undefined;
  const raw = JSON.parse(text);
  if (!isPlainObject(raw) || raw.version !== PROTOCOL_VERSION) return undefined;

  if (raw.ok === false) {
    if (!Object.keys(raw).every((key) => FAILURE_RESPONSE_KEYS.has(key))) return undefined;
    if (!ERRORS.has(raw.error)) return undefined;
    if (raw.requestId !== undefined && raw.requestId !== requestId) return undefined;
    return Object.freeze({ ...raw });
  }
  if (raw.ok !== true) return undefined;
  if (!Object.keys(raw).every((key) => SUCCESS_RESPONSE_KEYS.has(key))) return undefined;
  if (raw.requestId !== requestId) return undefined;
  if (typeof raw.invocationId !== 'string' || !ID_PATTERN.test(raw.invocationId)) return undefined;
  if (!STATES.has(raw.state)) return undefined;
  if (!Number.isSafeInteger(raw.cancelGeneration) || raw.cancelGeneration < 0) return undefined;
  if (raw.outcome !== undefined && !OUTCOMES.has(raw.outcome)) return undefined;
  if (raw.resultDigest !== undefined
      && (typeof raw.resultDigest !== 'string' || !SHA256_PATTERN.test(raw.resultDigest))) {
    return undefined;
  }
  const hasOutcome = hasOwn(raw, 'outcome');
  const hasResult = hasOwn(raw, 'result');
  const hasResultDigest = hasOwn(raw, 'resultDigest');
  if (raw.state === 'running' || raw.state === 'cancelling') {
    if (hasOutcome || hasResult || hasResultDigest) return undefined;
  } else {
    if (!hasOutcome || !hasResultDigest) return undefined;
    if (raw.state === 'settled' && hasResult) return undefined;
    if (raw.outcome === 'success') {
      if (raw.state === 'terminal' && (!hasResult || typeof raw.result !== 'string'
          || !isWellFormedString(raw.result) || Buffer.byteLength(raw.result, 'utf8') > MAX_RESULT_BYTES)) {
        return undefined;
      }
    } else if (hasResult) {
      return undefined;
    }
  }
  return Object.freeze({ ...raw });
}

function frame(payload) {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function exchange(socketPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    let received = 0;
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(new Error('Host executor request timed out')));
    socket.on('error', () => done(new Error('Host executor is unavailable')));
    socket.on('data', (chunk) => {
      received += chunk.length;
      if (received > FRAME_HEADER_BYTES + MAX_RESPONSE_BYTES) {
        done(new Error('Host executor response is oversized'));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length < FRAME_HEADER_BYTES) {
        done(new Error('Host executor response is truncated'));
        return;
      }
      const length = buffer.readUInt32BE(0);
      if (length > MAX_RESPONSE_BYTES || buffer.length !== FRAME_HEADER_BYTES + length) {
        done(new Error('Host executor response is malformed'));
        return;
      }
      done(undefined, buffer.subarray(FRAME_HEADER_BYTES));
    });
    socket.on('connect', () => socket.end(frame(payload)));
  });
}

/**
 * Creates a client bound to one run's socket and capability.
 *
 * @param {{ socketPath: string, capabilityPath: string, runId: string, timeoutMs?: number }} options
 */
function createHostExecutorClient(options) {
  const { socketPath, capabilityPath, runId } = options;
  assertPattern('runId', runId, ID_PATTERN);
  const capability = readCapability(capabilityPath);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  async function send(type, entryId, invocationId, fields) {
    if (typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)) {
      throw new Error('Host executor request entryId is invalid');
    }
    assertPattern('invocationId', invocationId, ID_PATTERN);
    const requestId = crypto.randomBytes(16).toString('hex');
    const request = {
      version: PROTOCOL_VERSION,
      type,
      requestId,
      runId,
      entryId,
      invocationId,
      capability,
      ...fields,
    };
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    if (payload.length > MAX_REQUEST_BYTES) throw new Error('Host executor request is oversized');
    const response = parseHostExecutorResponse(await exchange(socketPath, payload, timeoutMs), requestId);
    if (!response) throw new Error('Host executor response is malformed');
    if (response.ok && response.invocationId !== invocationId) {
      throw new Error('Host executor response is malformed');
    }
    return response;
  }

  return Object.freeze({
    async invoke(args) {
      if (!isPlainObject(args) || !Object.keys(args).every((key) => INVOKE_ARGUMENT_KEYS.has(key))) {
        throw new Error('Host executor invoke contains an unsupported field');
      }
      const { entryId, invocationId, executorKind, seedId, selector, payload, schemaHash, admissionId } = args;
      if (typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)) {
        throw new Error('Host executor request entryId is invalid');
      }
      if (!EXECUTOR_KINDS.has(executorKind)) throw new Error('Host executor request executorKind is invalid');
      if ((seedId === undefined) === (selector === undefined)) {
        throw new Error('Host executor invoke needs exactly one of seedId or selector');
      }
      if (seedId !== undefined) assertPattern('seedId', seedId, ID_PATTERN);
      if (selector !== undefined && (typeof selector !== 'string'
          || !/^[a-z0-9](?:[a-z0-9-]{0,38})\/(?!\.\.?$)(?!.*\.\.)[a-z0-9._-]{1,100}$/.test(selector))) {
        throw new Error('Host executor request selector is invalid');
      }
      if (typeof payload !== 'string' || payload.length === 0
          || !isWellFormedString(payload)
          || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new Error('Host executor request payload is invalid');
      }
      assertPattern('schemaHash', schemaHash, SHA256_PATTERN);
      assertPattern('admissionId', admissionId, ID_PATTERN);
      const fields = { executorKind, payload, schemaHash, admissionId };
      if (seedId !== undefined) fields.seedId = seedId;
      else fields.selector = selector;
      return send('invoke', entryId, invocationId, fields);
    },
    async cancel({ entryId, invocationId, cancelGeneration }) {
      if (!Number.isSafeInteger(cancelGeneration) || cancelGeneration < 1) {
        throw new Error('Host executor request cancelGeneration is invalid');
      }
      return send('cancel', entryId, invocationId, { cancelGeneration });
    },
    async settle({ entryId, invocationId, resultDigest }) {
      assertPattern('resultDigest', resultDigest, SHA256_PATTERN);
      return send('settle', entryId, invocationId, { resultDigest });
    },
    async status({ entryId, invocationId }) {
      return send('status', entryId, invocationId, {});
    },
  });
}

module.exports = {
  HOST_EXECUTOR_PROTOCOL_VERSION: PROTOCOL_VERSION,
  HOST_EXECUTOR_MAX_REQUEST_BYTES: MAX_REQUEST_BYTES,
  HOST_EXECUTOR_MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
  REQUEST_ID_PATTERN,
  createHostExecutorClient,
  parseHostExecutorResponse,
};
