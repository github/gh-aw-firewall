/**
 * Enclave finite-disclosure protocol v2 request/result validation facade.
 *
 * Schema algebra, cardinality math, and strict JSON parsing are maintained in
 * focused modules and re-exported here to preserve the protocol's public API.
 */

import { ceilLog2 } from './finite-cardinality';
import {
  canonicalizeSchemaValue,
  type FiniteSchemaNode,
  validateSchema,
  validateValueAgainstSchema,
} from './finite-schema';
import { strictParseJson, utf8ByteLength } from './strict-json-parser';

export * from './finite-schema';
export { ceilLog2BigInt, informationChargeForSchema, schemaCardinality } from './finite-cardinality';
export { strictParseJson } from './strict-json-parser';

/** Wire protocol version. Only this exact value is accepted. */
export const QUERY_PROTOCOL_VERSION = 2;

/** Maximum size, in UTF-8 bytes, of a query script. */
export const MAX_SCRIPT_BYTES = 64 * 1024;

/** Maximum size, in UTF-8 bytes, of the query's raw output file. */
export const MAX_RESULT_BYTES = 8 * 1024;

/** Maximum length of a `privateRepo` "owner/repo" slug. */
export const MAX_PRIVATE_REPO_LENGTH = 140;

/** Number of observable response-timing buckets (see `docs/awf-config-spec.md` §14). */
export const TIMING_BUCKETS_MS: readonly number[] = [
  100, 1_000, 10_000, 60_000, 120_000, 180_000, 240_000, 300_000, 600_000, 1_200_000, 2_400_000, 4_800_000,
];

/** Time reserved after a script times out for cleanup and result validation. */
export const FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS = 60_000;

/** Largest configurable script timeout while preserving the final-bucket margin. */
export const MAX_ENCLAVE_TIMEOUT_SECONDS =
  (TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1] - FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS) / 1000;

/** Bits reserved for the timing side channel. */
export const TIMING_BUCKET_BITS = ceilLog2(TIMING_BUCKETS_MS.length);

/** Bits reserved for the canonical ok/error distinction. */
export const RESULT_STATUS_BIT_COST = 1;

/** Matches a bare `owner/repo` slug only. */
export const PRIVATE_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/;

/** An enclave script execution request, already assembled from MCP arguments. */
export interface EnclaveScriptRequest {
  privateRepo: string;
  schema: FiniteSchemaNode;
  script: string;
}

export type EnclaveScriptRequestValidation =
  | { valid: true; request: EnclaveScriptRequest }
  | { valid: false; errors: string[] };

/** Validates an unknown value as an enclave script execution request. */
export function validateEnclaveScriptRequest(raw: unknown): EnclaveScriptRequestValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ['request must be a JSON object'] };
  }

  const errors: string[] = [];
  const record = raw as Record<string, unknown>;
  const { privateRepo, schema: schemaRaw, script } = record;
  const allowedKeys = new Set(['privateRepo', 'schema', 'script']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) errors.push(`request.${key} is not supported`);
  }

  if (typeof privateRepo !== 'string' || privateRepo.length === 0) {
    errors.push('privateRepo must be a non-empty string');
  } else if (privateRepo.length > MAX_PRIVATE_REPO_LENGTH || !PRIVATE_REPOSITORY_PATTERN.test(privateRepo)) {
    errors.push('privateRepo must be an "owner/repo" slug (no scheme, host, path traversal, query, fragment, or wildcard)');
  }

  const schemaValidation = validateSchema(schemaRaw);
  if (!schemaValidation.valid) errors.push(...schemaValidation.errors.map((error) => `schema: ${error}`));

  if (typeof script !== 'string' || script.length === 0) {
    errors.push('script must be a non-empty string');
  } else if (utf8ByteLength(script) > MAX_SCRIPT_BYTES) {
    errors.push(`script must be at most ${MAX_SCRIPT_BYTES} bytes`);
  }

  if (errors.length > 0 || !schemaValidation.valid || typeof privateRepo !== 'string' || typeof script !== 'string') {
    return { valid: false, errors };
  }
  return { valid: true, request: { privateRepo, schema: schemaValidation.schema, script } };
}

/** The canonical JSON text for every failure: `{"status":"error"}`. */
export const CANONICAL_ERROR_RESPONSE_JSON = '{"status":"error"}';

/** Wraps an already-canonicalized result value into the canonical success envelope. */
export function canonicalSuccessJson(canonicalResultJson: string): string {
  return `{"status":"ok","result":${canonicalResultJson}}`;
}

/** Parses, validates, and canonically re-serializes a query result. */
export function parseAndValidateFiniteOutput(
  raw: string,
  schema: FiniteSchemaNode,
): { ok: true; canonical: string } | { ok: false } {
  if (utf8ByteLength(raw) > MAX_RESULT_BYTES) return { ok: false };
  const parsed = strictParseJson(raw);
  if (!parsed || !validateValueAgainstSchema(schema, parsed.value)) return { ok: false };
  return { ok: true, canonical: canonicalizeSchemaValue(schema, parsed.value) };
}
