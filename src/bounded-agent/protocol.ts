/**
 * Bounded-agent request/result protocol.
 *
 * The wire *algebra* — the finite response schema, its cardinality and
 * information charge, strict JSON parsing, canonicalization, timing buckets,
 * and the canonical success/error envelopes — is the PR1 bounded-execution
 * foundation in `src/bounded-execution/finite-disclosure.ts`. This module adds
 * only what is specific to a bounded *agent* request:
 *
 * - the request selects a configured repository, declares a finite result
 *   schema, and carries a byte-bounded task text; nothing else;
 * - every control a caller might try to smuggle in — image, command,
 *   executable, mount, environment, endpoint, network, proxy, credential,
 *   timeout, resource limit, runtime, or tool definition — is explicitly
 *   rejected, as is any unknown key.
 *
 * Rejecting *explicitly named* controls in addition to the generic
 * unknown-key rule is redundant by construction; it is kept because it turns a
 * future accidental widening of the accepted key set into a test failure
 * rather than a silent capability grant.
 */

import {
  MAX_PRIVATE_REPO_LENGTH,
  BOUNDED_QUERY_REPO_PATTERN,
  validateSchema,
  type BoundedQuerySchemaNode,
} from '../bounded-execution/finite-disclosure';

export {
  CANONICAL_ERROR_JSON,
  MAX_RESULT_BYTES,
  MAX_SCHEMA_BYTES,
  MAX_QUERY_TIMEOUT_SECONDS as MAX_BOUNDED_AGENT_TIMEOUT_SECONDS,
  RESULT_STATUS_BIT_COST,
  TIMING_BUCKETS_MS,
  TIMING_BUCKET_BITS,
  BOUNDED_QUERY_REPO_PATTERN as BOUNDED_AGENT_REPO_PATTERN,
  MAX_PRIVATE_REPO_LENGTH,
  canonicalOkJson,
  parseAndValidateQueryOutput,
  queryBitsForSchema,
  schemaCardinality,
  strictParseJson,
  validateSchema,
  validateValueAgainstSchema,
  canonicalizeSchemaValue,
  type BoundedQuerySchemaNode as BoundedAgentSchemaNode,
} from '../bounded-execution/finite-disclosure';

/** Framing/protocol version of the bounded-agent request contract. */
export const AGENT_PROTOCOL_VERSION = 1;

/** Hard ceiling on the caller-supplied task text, independent of configuration. */
export const MAX_TASK_BYTES = 64 * 1024;

/** The complete set of keys a bounded-agent request may contain. */
export const ALLOWED_REQUEST_KEYS: readonly string[] = ['privateRepo', 'schema', 'task'];

/**
 * Controls a request may never express.
 *
 * These are all fixed trusted configuration. Naming them explicitly makes the
 * rejection self-documenting and testable; the generic unknown-key rule below
 * would reject them anyway.
 */
export const FORBIDDEN_REQUEST_KEYS: readonly string[] = [
  'image',
  'images',
  'command',
  'cmd',
  'args',
  'argv',
  'entrypoint',
  'executable',
  'interpreter',
  'script',
  'shell',
  'mount',
  'mounts',
  'volume',
  'volumes',
  'bind',
  'path',
  'paths',
  'workdir',
  'env',
  'environment',
  'endpoint',
  'endpoints',
  'baseUrl',
  'url',
  'host',
  'network',
  'networks',
  'dns',
  'proxy',
  'httpProxy',
  'httpsProxy',
  'credential',
  'credentials',
  'apiKey',
  'token',
  'authorization',
  'headers',
  'timeout',
  'timeoutSeconds',
  'deadline',
  'memory',
  'memoryLimit',
  'cpu',
  'cpuLimit',
  'pids',
  'pidsLimit',
  'tmpfs',
  'ulimit',
  'resources',
  'runtime',
  'backend',
  'sandbox',
  'profile',
  'model',
  'provider',
  'temperature',
  'maxTokens',
  'maxModelRequests',
  'tool',
  'tools',
  'toolChoice',
  'functions',
  'systemPrompt',
  'system',
  'messages',
];

/** A validated bounded-agent request. */
export interface BoundedAgentRequest {
  /** Configured repository selector, in `owner/repo` form. */
  privateRepo: string;
  /** Finite response schema the enclave's answer must conform to. */
  schema: BoundedQuerySchemaNode;
  /** Byte-bounded task text, forwarded verbatim into the enclave prompt. */
  task: string;
}

export type BoundedAgentValidation =
  | { valid: true; request: BoundedAgentRequest }
  | { valid: false; errors: string[] };

/** Options bounding a request against the *run's* normalized configuration. */
export interface ValidateBoundedAgentRequestOptions {
  /** Configured `maxTaskBytes`. Clamped to {@link MAX_TASK_BYTES}. */
  maxTaskBytes?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a bounded-agent request against the fixed protocol.
 *
 * Fails closed: any structural surprise (unknown key, forbidden control,
 * oversized task, non-finite schema, malformed repository selector) produces
 * an invalid result whose errors are only ever written to the protected audit
 * log, never returned to the caller.
 */
export function validateBoundedAgentRequest(
  raw: unknown,
  options: ValidateBoundedAgentRequestOptions = {},
): BoundedAgentValidation {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['request must be a JSON object'] };
  }

  const forbidden = FORBIDDEN_REQUEST_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(raw, key));
  for (const key of forbidden) {
    errors.push(`request may not specify "${key}"`);
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_REQUEST_KEYS.includes(key) && !forbidden.includes(key)) {
      errors.push(`unknown request key: "${key}"`);
    }
  }

  const { privateRepo, schema, task } = raw as Partial<BoundedAgentRequest>;

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

  const taskLimit = Math.min(
    Number.isInteger(options.maxTaskBytes) && (options.maxTaskBytes as number) > 0
      ? (options.maxTaskBytes as number)
      : MAX_TASK_BYTES,
    MAX_TASK_BYTES,
  );
  if (typeof task !== 'string') {
    errors.push('task must be a string');
  } else if (task.length === 0) {
    errors.push('task must not be empty');
  } else if (Buffer.byteLength(task, 'utf8') > taskLimit) {
    errors.push('task exceeds the maximum size');
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    request: {
      privateRepo: privateRepo as string,
      schema: schemaValidation.valid ? schemaValidation.schema : (schema as BoundedQuerySchemaNode),
      task: task as string,
    },
  };
}
