/**
 * Broker-to-host enclave executor protocol, version 1 (ADR 0002).
 *
 * This module is the host-owned half of the wire contract between the
 * AWF-owned `enclave-mcp-server` broker and the AWF host enclave executor.
 * The broker-side mirror lives in
 * `containers/enclave/mcp-server/host-executor-client.js` and is pinned to this
 * module by `host-executor-protocol.test.ts`, which drives the real client
 * against the real host server over a Unix socket.
 *
 * ## Shape
 *
 * One request is one length-prefixed frame on a fresh Unix-socket connection:
 * a 4-byte big-endian length followed by that many bytes of UTF-8 JSON. The
 * host answers with exactly one frame in the same encoding and closes the
 * connection. There is no streaming, no multiplexing, and no second request
 * per connection.
 *
 * Every request is a single JSON object with exactly the fields listed for its
 * `type` in {@link REQUEST_FIELDS}; unknown fields, duplicate keys, invalid
 * UTF-8, unsupported versions, and unknown types are rejected. There is
 * deliberately no field that can express a command, argv, executable,
 * entrypoint, path, mount, environment variable, network endpoint,
 * credential, image, model, runtime profile, resource limit, UID/GID,
 * timeout, or output limit: the host derives every such setting from its own
 * trusted run state.
 *
 * ## Authentication
 *
 * Every request carries a per-run capability (256 random bits, lowercase hex)
 * that the host generates and compares in constant time. Authorization never
 * depends on a source address, container identity, socket location, or
 * runtime; filesystem modes on the socket and capability file are defense in
 * depth only.
 *
 * ## Failure behavior
 *
 * Every failure is answered with a bounded, canonical, redacted response.
 * Anything rejected before the capability is verified — framing, size,
 * encoding, JSON, authentication, version, type, or schema — produces the
 * identical `denied` response, so an unauthenticated peer learns nothing about
 * which check failed. No rejected request has any execution side effect.
 */

import * as crypto from 'crypto';
import { TextDecoder } from 'util';
import { strictParseJson } from '../bounded-execution/strict-json-parser';
import { CANONICAL_DYNAMIC_REPOSITORY_PATTERN } from '../types/enclave-options';

/** Exact-match protocol version. There is no downgrade or feature probing. */
export const HOST_EXECUTOR_PROTOCOL_VERSION = 1;

/** Largest accepted request frame payload, in bytes. */
export const HOST_EXECUTOR_MAX_REQUEST_BYTES = 512 * 1024;

/** Largest response frame payload the host will ever emit, in bytes. */
export const HOST_EXECUTOR_MAX_RESPONSE_BYTES = 64 * 1024;

/** Largest script/task payload, in UTF-8 bytes. */
export const HOST_EXECUTOR_MAX_PAYLOAD_BYTES = 64 * 1024;

/** Largest bounded result an invocation may return, in UTF-8 bytes. */
export const HOST_EXECUTOR_MAX_RESULT_BYTES = 8 * 1024;

/** Largest canonical dynamic selector, in characters. */
export const HOST_EXECUTOR_MAX_SELECTOR_LENGTH = 256;

/** Size of the big-endian frame length prefix. */
export const HOST_EXECUTOR_FRAME_HEADER_BYTES = 4;

/** Capability length in bytes (hex-encoded on the wire). */
export const HOST_EXECUTOR_CAPABILITY_BYTES = 32;

/** 128-bit random request identifier, lowercase hex. */
export const HOST_EXECUTOR_REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Broker-generated run, invocation, seed, and admission identifiers. */
export const HOST_EXECUTOR_ID_PATTERN = /^[0-9a-f]{16,64}$/;

/** Stable enclave-entry identifier from the trusted run catalog. */
export const HOST_EXECUTOR_ENTRY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

/** Lowercase hex SHA-256 (schema hash, result digest). */
export const HOST_EXECUTOR_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;

export const HOST_EXECUTOR_REQUEST_TYPES = Object.freeze(['invoke', 'cancel', 'settle', 'status'] as const);
export type HostExecutorRequestType = typeof HOST_EXECUTOR_REQUEST_TYPES[number];

export const HOST_EXECUTOR_KINDS = Object.freeze(['script', 'agent'] as const);
export type HostExecutorKind = typeof HOST_EXECUTOR_KINDS[number];

/** Terminal outcomes a settled invocation can report. */
export const HOST_EXECUTOR_OUTCOMES = Object.freeze([
  'success',
  'schema-failure',
  'executor-failure',
  'timeout',
  'cancelled',
] as const);
export type HostExecutorOutcome = typeof HOST_EXECUTOR_OUTCOMES[number];

/** Invocation lifecycle states visible to the broker. */
export const HOST_EXECUTOR_STATES = Object.freeze(['running', 'cancelling', 'terminal', 'settled'] as const);
export type HostExecutorState = typeof HOST_EXECUTOR_STATES[number];

/** Closed set of canonical failure codes. */
export const HOST_EXECUTOR_ERRORS = Object.freeze([
  /** Anything rejected before or during authentication/validation, or a policy denial. */
  'denied',
  /** A `requestId` or cancellation generation that was already used. */
  'replayed',
  /** An invocation or settlement that contradicts the recorded immutable request. */
  'conflict',
  /** The invocation is not known to this run. */
  'unknown-invocation',
  /** The request is not valid in the invocation's current lifecycle state. */
  'invalid-state',
  /** Admissions are closed for this run. */
  'closed',
] as const);
export type HostExecutorError = typeof HOST_EXECUTOR_ERRORS[number];

const COMMON_FIELDS = ['version', 'type', 'requestId', 'runId', 'entryId', 'invocationId', 'capability'] as const;

/** Exact field set accepted for each request type. Nothing else is allowed. */
export const REQUEST_FIELDS: Readonly<Record<HostExecutorRequestType, readonly string[]>> = Object.freeze({
  invoke: Object.freeze([
    ...COMMON_FIELDS,
    'executorKind',
    'seedId',
    'selector',
    'payload',
    'schemaHash',
    'admissionId',
  ]),
  cancel: Object.freeze([...COMMON_FIELDS, 'cancelGeneration']),
  settle: Object.freeze([...COMMON_FIELDS, 'resultDigest']),
  status: Object.freeze([...COMMON_FIELDS]),
});

/** Fields that are optional within {@link REQUEST_FIELDS} (invoke: exactly one of these). */
const OPTIONAL_INVOKE_FIELDS = new Set(['seedId', 'selector']);

interface HostExecutorRequestBase {
  version: typeof HOST_EXECUTOR_PROTOCOL_VERSION;
  requestId: string;
  runId: string;
  entryId: string;
  invocationId: string;
}

export interface HostExecutorInvokeRequest extends HostExecutorRequestBase {
  type: 'invoke';
  executorKind: HostExecutorKind;
  /** Static seed ID from the trusted catalog. Mutually exclusive with `selector`. */
  seedId?: string;
  /** Canonical dynamic selector. Mutually exclusive with `seedId`. */
  selector?: string;
  /** Bounded script (script executor) or task (agent executor) text. */
  payload: string;
  schemaHash: string;
  admissionId: string;
}

export interface HostExecutorCancelRequest extends HostExecutorRequestBase {
  type: 'cancel';
  cancelGeneration: number;
}

export interface HostExecutorSettleRequest extends HostExecutorRequestBase {
  type: 'settle';
  resultDigest: string;
}

export interface HostExecutorStatusRequest extends HostExecutorRequestBase {
  type: 'status';
}

/** An authenticated, schema-valid request. The capability is never retained. */
export type HostExecutorRequest =
  | HostExecutorInvokeRequest
  | HostExecutorCancelRequest
  | HostExecutorSettleRequest
  | HostExecutorStatusRequest;

export interface HostExecutorInvocationView {
  state: HostExecutorState;
  cancelGeneration: number;
  outcome?: HostExecutorOutcome;
  result?: string;
  resultDigest?: string;
}

export type HostExecutorResponse =
  | ({
    version: typeof HOST_EXECUTOR_PROTOCOL_VERSION;
    ok: true;
    requestId: string;
    invocationId: string;
  } & HostExecutorInvocationView)
  | {
    version: typeof HOST_EXECUTOR_PROTOCOL_VERSION;
    ok: false;
    requestId?: string;
    error: HostExecutorError;
  };

export type HostExecutorDecodeResult =
  | { ok: true; request: HostExecutorRequest }
  | { ok: false };

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Rejects unpaired UTF-16 surrogates, which cannot round-trip as UTF-8. */
function isWellFormedString(value: string): boolean {
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

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Generates a fresh per-run capability. */
export function generateHostExecutorCapability(): Buffer {
  return crypto.randomBytes(HOST_EXECUTOR_CAPABILITY_BYTES);
}

/**
 * Compares a wire capability to the run capability in constant time with
 * respect to the capability contents.
 */
export function capabilityMatches(expected: Buffer, presented: unknown): boolean {
  if (expected.length !== HOST_EXECUTOR_CAPABILITY_BYTES) return false;
  if (typeof presented !== 'string' || !CAPABILITY_PATTERN.test(presented)) return false;
  const candidate = Buffer.from(presented, 'hex');
  try {
    return crypto.timingSafeEqual(candidate, expected);
  } finally {
    candidate.fill(0);
  }
}

/**
 * Decodes and validates one request frame payload.
 *
 * Validation order is size → UTF-8 → strict JSON (no duplicate keys, no
 * trailing data) → capability → version → type → closed field set → field
 * values. Every failure returns the same `{ ok: false }` so the caller emits
 * the single canonical `denied` response.
 */
export function decodeHostExecutorRequest(
  payload: Buffer,
  context: { capability: Buffer; runId: string },
): HostExecutorDecodeResult {
  const denied: HostExecutorDecodeResult = { ok: false };
  if (payload.length === 0 || payload.length > HOST_EXECUTOR_MAX_REQUEST_BYTES) return denied;

  let text: string;
  try {
    text = utf8Decoder.decode(payload);
  } catch {
    return denied;
  }

  // The strict parser rejects duplicate keys and trailing data; `JSON.parse`
  // then produces the value with own-property semantics, so a `__proto__`
  // key surfaces as an ordinary (and therefore unknown) field instead of
  // altering the prototype.
  if (!strictParseJson(text)) return denied;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return denied;
  }
  if (!isPlainObject(raw)) return denied;

  if (!capabilityMatches(context.capability, raw.capability)) return denied;

  if (raw.version !== HOST_EXECUTOR_PROTOCOL_VERSION) return denied;
  const type = raw.type;
  if (typeof type !== 'string' || !(HOST_EXECUTOR_REQUEST_TYPES as readonly string[]).includes(type)) {
    return denied;
  }
  const allowed = REQUEST_FIELDS[type as HostExecutorRequestType];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return denied;
  }
  for (const key of allowed) {
    if (!hasOwn(raw, key) && !(type === 'invoke' && OPTIONAL_INVOKE_FIELDS.has(key))) return denied;
  }

  const { requestId, runId, entryId, invocationId } = raw;
  if (typeof requestId !== 'string' || !HOST_EXECUTOR_REQUEST_ID_PATTERN.test(requestId)) return denied;
  if (typeof runId !== 'string' || !HOST_EXECUTOR_ID_PATTERN.test(runId)) return denied;
  if (runId !== context.runId) return denied;
  if (typeof entryId !== 'string' || !HOST_EXECUTOR_ENTRY_ID_PATTERN.test(entryId)) return denied;
  if (typeof invocationId !== 'string' || !HOST_EXECUTOR_ID_PATTERN.test(invocationId)) return denied;

  const base: HostExecutorRequestBase = {
    version: HOST_EXECUTOR_PROTOCOL_VERSION,
    requestId,
    runId,
    entryId,
    invocationId,
  };

  switch (type as HostExecutorRequestType) {
    case 'invoke': {
      const { executorKind, seedId, selector, payload: body, schemaHash, admissionId } = raw;
      if (typeof executorKind !== 'string'
        || !(HOST_EXECUTOR_KINDS as readonly string[]).includes(executorKind)) {
        return denied;
      }
      const hasSeed = hasOwn(raw, 'seedId');
      const hasSelector = hasOwn(raw, 'selector');
      if (hasSeed === hasSelector) return denied;
      if (hasSeed && (typeof seedId !== 'string' || !HOST_EXECUTOR_ID_PATTERN.test(seedId))) return denied;
      if (hasSelector) {
        if (executorKind !== 'agent') return denied;
        if (typeof selector !== 'string'
          || selector.length > HOST_EXECUTOR_MAX_SELECTOR_LENGTH
          || !CANONICAL_DYNAMIC_REPOSITORY_PATTERN.test(selector)) {
          return denied;
        }
      }
      if (typeof body !== 'string' || body.length === 0 || !isWellFormedString(body)) return denied;
      if (Buffer.byteLength(body, 'utf8') > HOST_EXECUTOR_MAX_PAYLOAD_BYTES) return denied;
      if (typeof schemaHash !== 'string' || !HOST_EXECUTOR_SHA256_PATTERN.test(schemaHash)) return denied;
      if (typeof admissionId !== 'string' || !HOST_EXECUTOR_ID_PATTERN.test(admissionId)) return denied;
      const request: HostExecutorInvokeRequest = {
        ...base,
        type: 'invoke',
        executorKind: executorKind as HostExecutorKind,
        payload: body,
        schemaHash,
        admissionId,
      };
      if (hasSeed) request.seedId = seedId as string;
      else request.selector = selector as string;
      return { ok: true, request };
    }
    case 'cancel': {
      const { cancelGeneration } = raw;
      if (!Number.isSafeInteger(cancelGeneration) || (cancelGeneration as number) < 1) return denied;
      return { ok: true, request: { ...base, type: 'cancel', cancelGeneration: cancelGeneration as number } };
    }
    case 'settle': {
      const { resultDigest } = raw;
      if (typeof resultDigest !== 'string' || !HOST_EXECUTOR_SHA256_PATTERN.test(resultDigest)) return denied;
      return { ok: true, request: { ...base, type: 'settle', resultDigest } };
    }
    case 'status':
      return { ok: true, request: { ...base, type: 'status' } };
  }
  /* istanbul ignore next -- exhaustive switch */
  return denied;
}

/**
 * Immutable hash of an invoke request's execution-relevant fields.
 *
 * `requestId` is excluded so a broker retry with a fresh request ID maps to
 * the same record; any other difference yields a different hash and is
 * rejected as a conflict.
 */
export function hostExecutorInvokeHash(request: HostExecutorInvokeRequest): string {
  return sha256Hex(JSON.stringify([
    HOST_EXECUTOR_PROTOCOL_VERSION,
    request.runId,
    request.entryId,
    request.executorKind,
    request.invocationId,
    request.seedId ?? null,
    request.selector ?? null,
    request.payload,
    request.schemaHash,
    request.admissionId,
  ]));
}

/** Digest the broker echoes back in `settle` to acknowledge a terminal result. */
export function hostExecutorResultDigest(outcome: HostExecutorOutcome, result: string | undefined): string {
  return sha256Hex(JSON.stringify([outcome, result ?? null]));
}

const CANONICAL_DENIED = Buffer.from(JSON.stringify({
  version: HOST_EXECUTOR_PROTOCOL_VERSION,
  ok: false,
  error: 'denied',
}), 'utf8');

/** The single canonical response for any unauthenticated or invalid request. */
export function canonicalDeniedResponse(): Buffer {
  return Buffer.from(CANONICAL_DENIED);
}

/**
 * Encodes a response payload. A response that would exceed
 * {@link HOST_EXECUTOR_MAX_RESPONSE_BYTES} is replaced by the canonical
 * denial rather than truncated.
 */
export function encodeHostExecutorResponse(response: HostExecutorResponse): Buffer {
  const encoded = Buffer.from(JSON.stringify(response), 'utf8');
  if (encoded.length > HOST_EXECUTOR_MAX_RESPONSE_BYTES) return canonicalDeniedResponse();
  return encoded;
}

/** Prepends the 4-byte big-endian length header. */
export function frameHostExecutorMessage(payload: Buffer): Buffer {
  const header = Buffer.alloc(HOST_EXECUTOR_FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Validates a backend-reported bounded result. Results are only carried for
 * `success`; every other outcome crosses the boundary as a bare outcome.
 */
export function isValidHostExecutorResult(outcome: unknown, result: unknown): outcome is HostExecutorOutcome {
  if (typeof outcome !== 'string' || !(HOST_EXECUTOR_OUTCOMES as readonly string[]).includes(outcome)) {
    return false;
  }
  if (outcome !== 'success') return result === undefined;
  return typeof result === 'string'
    && isWellFormedString(result)
    && Buffer.byteLength(result, 'utf8') <= HOST_EXECUTOR_MAX_RESULT_BYTES;
}
