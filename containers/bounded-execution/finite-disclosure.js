'use strict';

/**
 * Finite-disclosure request/result protocol v2 - broker-side facade.
 *
 * The focused modules deliberately mirror src/bounded-execution/'s TypeScript
 * implementation. Keep both sides in parity; finite-disclosure-modules.test.ts
 * pins the module boundaries and this facade's public API.
 */

const {
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_NODES,
  MAX_ENUM_VALUES,
  MAX_LITERAL_STRING_BYTES,
  MAX_OBJECT_FIELDS,
  MAX_TUPLE_ITEMS,
  MAX_ARRAY_LENGTH,
  MAX_UNION_VARIANTS,
  validateSchema,
  serializeFiniteSchema,
  validateValueAgainstSchema,
  canonicalizeSchemaValue,
  schemaContainsFreeformString,
} = require('./schema-validation');
const {
  ceilLog2BigInt,
  schemaCardinality,
  informationChargeForSchema: calculateInformationChargeForSchema,
} = require('./cardinality');
const { strictParseJson, utf8ByteLength } = require('./strict-json');
const {
  TIMING_BUCKETS_MS,
  FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS,
  MAX_ENCLAVE_TIMEOUT_SECONDS,
  TIMING_BUCKET_BITS,
} = require('./timing');

const QUERY_PROTOCOL_VERSION = 2;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 8 * 1024;
const MAX_PRIVATE_REPO_LENGTH = 140;
const RESULT_STATUS_BIT_COST = 1;
const PRIVATE_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/;

function informationChargeForSchema(schema) {
  return calculateInformationChargeForSchema(schema, RESULT_STATUS_BIT_COST, TIMING_BUCKET_BITS);
}

// ── Request/result validation and canonical envelopes ───────────────────────

function validateEnclaveScriptRequest(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ['request must be a JSON object'] };
  }

  const errors = [];
  const { privateRepo, schema: schemaRaw, script } = raw;
  const allowedKeys = new Set(['privateRepo', 'schema', 'script']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) errors.push(`request.${key} is not supported`);
  }

  if (typeof privateRepo !== 'string' || privateRepo.length === 0) {
    errors.push('privateRepo must be a non-empty string');
  } else if (privateRepo.length > MAX_PRIVATE_REPO_LENGTH || !PRIVATE_REPOSITORY_PATTERN.test(privateRepo)) {
    errors.push(
      'privateRepo must be an "owner/repo" slug (no scheme, host, path traversal, query, fragment, or wildcard)',
    );
  }

  const schemaValidation = validateSchema(schemaRaw);
  if (!schemaValidation.valid) {
    errors.push(...schemaValidation.errors.map((error) => `schema: ${error}`));
  }

  if (typeof script !== 'string' || script.length === 0) {
    errors.push('script must be a non-empty string');
  } else if (utf8ByteLength(script) > MAX_SCRIPT_BYTES) {
    errors.push(`script must be at most ${MAX_SCRIPT_BYTES} bytes`);
  }

  if (
    errors.length > 0
    || !schemaValidation.valid
    || typeof privateRepo !== 'string'
    || typeof script !== 'string'
  ) {
    return { valid: false, errors };
  }

  return { valid: true, request: { privateRepo, schema: schemaValidation.schema, script } };
}

const CANONICAL_ERROR_RESPONSE_JSON = '{"status":"error"}';

function canonicalSuccessJson(canonicalResultJson) {
  return `{"status":"ok","result":${canonicalResultJson}}`;
}

function parseAndValidateFiniteOutput(raw, schema) {
  if (utf8ByteLength(raw) > MAX_RESULT_BYTES) return { ok: false };
  const parsed = strictParseJson(raw);
  if (!parsed) return { ok: false };
  if (!validateValueAgainstSchema(schema, parsed.value)) return { ok: false };
  return { ok: true, canonical: canonicalizeSchemaValue(schema, parsed.value) };
}

module.exports = {
  QUERY_PROTOCOL_VERSION,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_NODES,
  MAX_ENUM_VALUES,
  MAX_LITERAL_STRING_BYTES,
  MAX_OBJECT_FIELDS,
  MAX_TUPLE_ITEMS,
  MAX_ARRAY_LENGTH,
  MAX_UNION_VARIANTS,
  MAX_SCRIPT_BYTES,
  MAX_RESULT_BYTES,
  MAX_PRIVATE_REPO_LENGTH,
  TIMING_BUCKETS_MS,
  FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS,
  MAX_ENCLAVE_TIMEOUT_SECONDS,
  TIMING_BUCKET_BITS,
  RESULT_STATUS_BIT_COST,
  PRIVATE_REPOSITORY_PATTERN,
  CANONICAL_ERROR_RESPONSE_JSON,
  validateSchema,
  serializeFiniteSchema,
  ceilLog2BigInt,
  schemaCardinality,
  informationChargeForSchema,
  validateValueAgainstSchema,
  canonicalizeSchemaValue,
  schemaContainsFreeformString,
  strictParseJson,
  validateEnclaveScriptRequest,
  canonicalSuccessJson,
  parseAndValidateFiniteOutput,
};
