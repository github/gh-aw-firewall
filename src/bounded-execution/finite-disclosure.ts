/**
 * Enclave finite-disclosure protocol v2: a deliberately finite,
 * agent-authored response-schema algebra plus request/result validation and
 * canonicalization.
 *
 * This module defines the enclave finite-disclosure wire protocol independently of
 * any broker or sandbox runtime.
 *
 * Protocol summary:
 *   - A **request** asks the trusted broker to run an agent-authored Python
 *     script against a private repository and report a value conforming to
 *     a caller-authored finite response **schema** constrained by AWF.
 *   - The schema is drawn from a small, closed algebra (`const`, `boolean`,
 *     unique `enum`, bounded `integer`, fixed `object`, `tuple`, fixed-length
 *     `array`, and tagged `union`) — general JSON Schema is not accepted.
 *     Every construct has a computable, finite cardinality (number of
 *     distinguishable values), calculated with `BigInt` so it can never
 *     silently overflow.
 *   - A **result** is always exactly one of two canonical envelopes:
 *     `{"status":"ok","result":<value>}` or `{"status":"error"}`. The error
 *     state lives *outside* the declared schema — the schema only describes
 *     the shape of a successful `result` value — so, unlike protocol v1,
 *     schemas never need a reserved sentinel member.
 *   - Every accepted invocation reserves a fixed number of information-budget
 *     bits: one for the ok/error distinction, `ceil(log2(cardinality))` for
 *     the success payload, and {@link TIMING_BUCKET_BITS} for the observable
 *     response-timing bucket (see `docs/awf-config-spec.md` §14). Budget
 *     accounting itself lives in the broker's per-repository ledger; this
 *     module only computes the charge for a given schema.
 *
 * Schema parsing and result parsing deliberately do NOT use a general-purpose
 * JSON Schema validator, nor `JSON.parse`. Both use small, hand-written,
 * linear-time (no backtracking) recursive-descent parsers below, bounded by
 * fixed depth/node/size limits, so nothing attacker-influenced (schema text
 * or query output) can grow an unbounded parse tree, and duplicate object
 * keys — which `JSON.parse` would silently collapse — are rejected outright.
 *
 * `containers/bounded-execution/finite-disclosure.js` is a deliberate,
 * behaviour-identical mirror of this module for the enclave server
 * image, which cannot import AWF's TypeScript sources. Keep both in sync;
 * enclave protocol tests run shared vectors through both.
 */

/** Wire protocol version. Only this exact value is accepted. */
export const QUERY_PROTOCOL_VERSION = 2;

/** Maximum size, in UTF-8 bytes, of a serialized agent-authored schema. */
export const MAX_SCHEMA_BYTES = 4096;

/** Maximum nesting depth of a schema (object/tuple/array/union children). */
export const MAX_SCHEMA_DEPTH = 6;

/** Maximum total number of schema nodes (bounds parse/cardinality work). */
export const MAX_SCHEMA_NODES = 64;

/** Maximum number of members in one `enum` schema. */
export const MAX_ENUM_VALUES = 4096;

/** Maximum size, in UTF-8 bytes, of one `const`/`enum` string literal. */
export const MAX_LITERAL_STRING_BYTES = 64;

/** Maximum number of fields in one `object` schema. */
export const MAX_OBJECT_FIELDS = 16;

/** Maximum number of items in one `tuple` schema. */
export const MAX_TUPLE_ITEMS = 16;

/** Maximum fixed length of one `array` schema. */
export const MAX_ARRAY_LENGTH = 64;

/** Maximum number of variants in one `union` schema. */
export const MAX_UNION_VARIANTS = 16;

/** Maximum size, in UTF-8 bytes, of a query script. */
export const MAX_SCRIPT_BYTES = 64 * 1024;

/** Maximum size, in UTF-8 bytes, of the query's raw output file. */
export const MAX_RESULT_BYTES = 8 * 1024;

/** Maximum length of a `privateRepo` "owner/repo" slug. */
export const MAX_PRIVATE_REPO_LENGTH = 140;

/** Number of observable response-timing buckets (see `docs/awf-config-spec.md` §14). */
export const TIMING_BUCKETS_MS: readonly number[] = [10, 100, 1_000, 10_000, 60_000, 600_000];

/**
 * Time reserved inside the final bucket for Docker termination, result
 * validation, container removal, and workspace cleanup after the script's
 * configured wall-clock budget expires.
 */
export const FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS = 60_000;

/** Largest configurable script timeout while preserving the final-bucket margin. */
export const MAX_ENCLAVE_TIMEOUT_SECONDS =
  (TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1] - FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS) / 1000;

/**
 * Bits reserved for the timing side channel: `ceil(log2(TIMING_BUCKETS_MS.length))`.
 * Fixed at 3 for the current six-bucket design; recomputed defensively below
 * so the constant can never silently drift out of sync with the bucket list.
 */
export const TIMING_BUCKET_BITS = ceilLog2(TIMING_BUCKETS_MS.length);

/** Bits reserved for the canonical ok/error distinction. */
export const RESULT_STATUS_BIT_COST = 1;

/**
 * Matches a bare `owner/repo` slug only: no scheme/host (`://`), no path
 * traversal (`..`), no query string or fragment (`?`/`#`), no wildcard
 * (`*`), and no extra path segments (only one `/` is allowed).
 *
 * Keep in sync with `enclaves.privateRepos.items` in
 * `docs/awf-config.schema.json` (JSON Schema cannot share a regex constant
 * with TypeScript source).
 */
export const PRIVATE_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/;

/** Bounded ASCII identifier accepted for object field names and union tags. */
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Non-negative integer ceiling of `log2(n)`, for plain (non-BigInt) `n >= 1`. */
function ceilLog2(n: number): number {
  return ceilLog2BigInt(BigInt(n));
}

// ── Finite schema algebra ────────────────────────────────────────────────────

/** A JSON scalar literal usable in `const`/`enum` schema nodes. */
export type JsonLiteral = string | number | boolean | null;

export interface ConstSchemaNode {
  readonly type: 'const';
  readonly value: JsonLiteral;
}
export interface BooleanSchemaNode {
  readonly type: 'boolean';
}
export interface EnumSchemaNode {
  readonly type: 'enum';
  readonly values: readonly JsonLiteral[];
}
export interface IntegerSchemaNode {
  readonly type: 'integer';
  readonly minimum: number;
  readonly maximum: number;
}
export interface ObjectSchemaNode {
  readonly type: 'object';
  readonly fields: readonly { name: string; schema: FiniteSchemaNode }[];
}
export interface TupleSchemaNode {
  readonly type: 'tuple';
  readonly items: readonly FiniteSchemaNode[];
}
export interface ArraySchemaNode {
  readonly type: 'array';
  readonly items: FiniteSchemaNode;
  readonly length: number;
}
export interface UnionSchemaNode {
  readonly type: 'union';
  readonly variants: readonly { tag: string; schema: FiniteSchemaNode }[];
}

/**
 * A validated, finite response schema.
 *
 * This is the *parsed* representation — every instance has already passed
 * {@link validateSchema}'s bounds (depth, node count, enum/field/item counts,
 * literal sizes). Cardinality, value validation, and canonical serialization
 * below all assume that.
 */
export type FiniteSchemaNode =
  | ConstSchemaNode
  | BooleanSchemaNode
  | EnumSchemaNode
  | IntegerSchemaNode
  | ObjectSchemaNode
  | TupleSchemaNode
  | ArraySchemaNode
  | UnionSchemaNode;

export type FiniteSchemaValidation =
  | { valid: true; schema: FiniteSchemaNode }
  | { valid: false; errors: string[] };

function isValidLiteral(value: unknown): value is JsonLiteral {
  if (value === null) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isInteger(value) && Number.isSafeInteger(value);
  if (typeof value === 'string') {
    return !hasControlCharacters(value) && utf8ByteLength(value) <= MAX_LITERAL_STRING_BYTES;
  }
  return false;
}

function literalTypeTag(value: JsonLiteral): string {
  return value === null ? 'null' : typeof value;
}

interface SchemaParseContext {
  errors: string[];
  nodeCount: number;
}

function failSchema(ctx: SchemaParseContext, message: string): undefined {
  if (ctx.errors.length === 0) ctx.errors.push(message);
  return undefined;
}

/**
 * Builds one validated {@link FiniteSchemaNode}, enforcing every finite
 * bound as it recurses. Stops at the first violation (`ctx.errors` becomes
 * non-empty) rather than continuing to build a tree that will be discarded.
 */
function buildSchemaNode(raw: unknown, ctx: SchemaParseContext, depth: number): FiniteSchemaNode | undefined {
  if (ctx.errors.length > 0) return undefined;
  if (depth > MAX_SCHEMA_DEPTH) {
    return failSchema(ctx, `schema exceeds maximum depth of ${MAX_SCHEMA_DEPTH}`);
  }
  ctx.nodeCount += 1;
  if (ctx.nodeCount > MAX_SCHEMA_NODES) {
    return failSchema(ctx, `schema exceeds maximum node count of ${MAX_SCHEMA_NODES}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return failSchema(ctx, 'schema node must be a JSON object');
  }

  const node = raw as Record<string, unknown>;
  switch (node.type) {
    case 'const': {
      if (Object.keys(node).length !== 2 || !('value' in node)) {
        return failSchema(ctx, 'const schema must have exactly "type" and "value"');
      }
      if (!isValidLiteral(node.value)) {
        return failSchema(ctx, 'const value must be a bounded string, a safe integer, a boolean, or null');
      }
      return { type: 'const', value: node.value as JsonLiteral };
    }
    case 'boolean': {
      if (Object.keys(node).length !== 1) {
        return failSchema(ctx, 'boolean schema must have only "type"');
      }
      return { type: 'boolean' };
    }
    case 'enum': {
      if (Object.keys(node).length !== 2 || !('values' in node)) {
        return failSchema(ctx, 'enum schema must have exactly "type" and "values"');
      }
      const values = node.values;
      if (!Array.isArray(values) || values.length === 0) {
        return failSchema(ctx, 'enum values must be a non-empty array');
      }
      if (values.length > MAX_ENUM_VALUES) {
        return failSchema(ctx, `enum values must contain at most ${MAX_ENUM_VALUES} entries`);
      }
      for (const value of values) {
        if (!isValidLiteral(value)) {
          return failSchema(ctx, 'enum values must be bounded strings, safe integers, booleans, or null');
        }
      }
      const literals = values as JsonLiteral[];
      const firstTag = literalTypeTag(literals[0]);
      if (!literals.every((value) => literalTypeTag(value) === firstTag)) {
        return failSchema(ctx, 'enum values must all be the same JSON type');
      }
      const uniqueCount = new Set(literals.map((value) => JSON.stringify(value))).size;
      if (uniqueCount !== literals.length) {
        return failSchema(ctx, 'enum values must be unique');
      }
      return { type: 'enum', values: literals };
    }
    case 'integer': {
      if (Object.keys(node).length !== 3 || !('minimum' in node) || !('maximum' in node)) {
        return failSchema(ctx, 'integer schema must have exactly "type", "minimum", and "maximum"');
      }
      const { minimum, maximum } = node;
      if (typeof minimum !== 'number' || !Number.isSafeInteger(minimum)) {
        return failSchema(ctx, 'integer minimum must be a safe integer');
      }
      if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum)) {
        return failSchema(ctx, 'integer maximum must be a safe integer');
      }
      if (maximum < minimum) {
        return failSchema(ctx, 'integer maximum must be >= minimum');
      }
      return { type: 'integer', minimum, maximum };
    }
    case 'object': {
      if (Object.keys(node).length !== 2 || !('fields' in node)) {
        return failSchema(ctx, 'object schema must have exactly "type" and "fields"');
      }
      const fieldsRaw = node.fields;
      if (typeof fieldsRaw !== 'object' || fieldsRaw === null || Array.isArray(fieldsRaw)) {
        return failSchema(ctx, 'object "fields" must be a JSON object mapping field name to schema');
      }
      const fieldNames = Object.keys(fieldsRaw);
      if (fieldNames.length === 0) {
        return failSchema(ctx, 'object schema must declare at least one field');
      }
      if (fieldNames.length > MAX_OBJECT_FIELDS) {
        return failSchema(ctx, `object schema must declare at most ${MAX_OBJECT_FIELDS} fields`);
      }
      for (const name of fieldNames) {
        if (!IDENTIFIER_PATTERN.test(name)) {
          return failSchema(ctx, `object field name "${name}" is not a bounded ASCII identifier`);
        }
      }
      const fields: { name: string; schema: FiniteSchemaNode }[] = [];
      for (const name of fieldNames) {
        const child = buildSchemaNode((fieldsRaw as Record<string, unknown>)[name], ctx, depth + 1);
        if (!child) return undefined;
        fields.push({ name, schema: child });
      }
      return { type: 'object', fields };
    }
    case 'tuple': {
      if (Object.keys(node).length !== 2 || !('items' in node)) {
        return failSchema(ctx, 'tuple schema must have exactly "type" and "items"');
      }
      const itemsRaw = node.items;
      if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
        return failSchema(ctx, 'tuple "items" must be a non-empty array');
      }
      if (itemsRaw.length > MAX_TUPLE_ITEMS) {
        return failSchema(ctx, `tuple schema must declare at most ${MAX_TUPLE_ITEMS} items`);
      }
      const items: FiniteSchemaNode[] = [];
      for (const itemRaw of itemsRaw) {
        const child = buildSchemaNode(itemRaw, ctx, depth + 1);
        if (!child) return undefined;
        items.push(child);
      }
      return { type: 'tuple', items };
    }
    case 'array': {
      if (Object.keys(node).length !== 3 || !('items' in node) || !('length' in node)) {
        return failSchema(ctx, 'array schema must have exactly "type", "items", and "length"');
      }
      const { length } = node;
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
        return failSchema(ctx, `array "length" must be an integer between 0 and ${MAX_ARRAY_LENGTH}`);
      }
      const child = buildSchemaNode(node.items, ctx, depth + 1);
      if (!child) return undefined;
      return { type: 'array', items: child, length };
    }
    case 'union': {
      if (Object.keys(node).length !== 2 || !('variants' in node)) {
        return failSchema(ctx, 'union schema must have exactly "type" and "variants"');
      }
      const variantsRaw = node.variants;
      if (typeof variantsRaw !== 'object' || variantsRaw === null || Array.isArray(variantsRaw)) {
        return failSchema(ctx, 'union "variants" must be a JSON object mapping tag to schema');
      }
      const tags = Object.keys(variantsRaw);
      if (tags.length === 0) {
        return failSchema(ctx, 'union schema must declare at least one variant');
      }
      if (tags.length > MAX_UNION_VARIANTS) {
        return failSchema(ctx, `union schema must declare at most ${MAX_UNION_VARIANTS} variants`);
      }
      for (const tag of tags) {
        if (!IDENTIFIER_PATTERN.test(tag)) {
          return failSchema(ctx, `union tag "${tag}" is not a bounded ASCII identifier`);
        }
      }
      const variants: { tag: string; schema: FiniteSchemaNode }[] = [];
      for (const tag of tags) {
        const child = buildSchemaNode((variantsRaw as Record<string, unknown>)[tag], ctx, depth + 1);
        if (!child) return undefined;
        variants.push({ tag, schema: child });
      }
      return { type: 'union', variants };
    }
    default:
      return failSchema(
        ctx,
        'schema node "type" must be one of: const, boolean, enum, integer, object, tuple, array, union',
      );
  }
}

/**
 * Validates and parses an agent-authored schema.
 *
 * Rejects anything outside the finite algebra above: unbounded strings,
 * floats, regex domains, recursion/`$ref` (there is no such construct to
 * begin with), optional properties, `additionalProperties`, and overlapping
 * untagged unions are all structurally impossible to express, so they are
 * rejected by construction rather than by a separate deny-list.
 */
export function validateSchema(raw: unknown): FiniteSchemaValidation {
  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? '';
  } catch {
    return { valid: false, errors: ['schema must be JSON-serializable'] };
  }

  const ctx: SchemaParseContext = { errors: [], nodeCount: 0 };
  const schema = buildSchemaNode(raw, ctx, 0);
  if (!schema || ctx.errors.length > 0) {
    return { valid: false, errors: ctx.errors.length > 0 ? ctx.errors : ['invalid schema'] };
  }
  if (raw === undefined || utf8ByteLength(serialized) > MAX_SCHEMA_BYTES) {
    return { valid: false, errors: [`schema must be a JSON value of at most ${MAX_SCHEMA_BYTES} bytes`] };
  }
  return { valid: true, schema };
}

/** Ceiling of `log2(n)` for a non-negative `BigInt`, without floating point. */
export function ceilLog2BigInt(n: bigint): number {
  if (n <= 1n) return 0;
  let bits = 0;
  let remainder = n - 1n;
  while (remainder > 0n) {
    remainder >>= 1n;
    bits += 1;
  }
  return bits;
}

/**
 * Computes a schema's successful-outcome cardinality (number of
 * distinguishable valid values) as a `BigInt`, so it can never silently
 * overflow even for schemas near the configured bounds.
 */
export function schemaCardinality(schema: FiniteSchemaNode): bigint {
  switch (schema.type) {
    case 'const':
      return 1n;
    case 'boolean':
      return 2n;
    case 'enum':
      return BigInt(schema.values.length);
    case 'integer':
      return BigInt(schema.maximum) - BigInt(schema.minimum) + 1n;
    case 'object':
      return schema.fields.reduce((acc, field) => acc * schemaCardinality(field.schema), 1n);
    case 'tuple':
      return schema.items.reduce((acc, item) => acc * schemaCardinality(item), 1n);
    case 'array':
      return schemaCardinality(schema.items) ** BigInt(schema.length);
    case 'union':
      return schema.variants.reduce((acc, variant) => acc + schemaCardinality(variant.schema), 0n);
  }
}

/**
 * Computes cardinality only up to a bounded, already-unaffordable result.
 *
 * Materializing the exact cardinality of deeply nested fixed arrays can create
 * multi-megabyte BigInts from a tiny request. The exact value above this cap is
 * irrelevant once it exceeds this threshold: every metered sensitivity has at
 * most 64 bits per run, while the fixed status/timing channels already cost 4
 * bits. The larger 1024-bit cap preserves exact charges for ordinary schemas.
 */
const MAX_EXACT_SCHEMA_CARDINALITY = 1n << 1024n;
const CAPPED_SCHEMA_CARDINALITY = MAX_EXACT_SCHEMA_CARDINALITY + 1n;

function cappedMultiply(left: bigint, right: bigint): bigint {
  if (left === 0n || right === 0n) return 0n;
  if (left > MAX_EXACT_SCHEMA_CARDINALITY / right) return CAPPED_SCHEMA_CARDINALITY;
  return left * right;
}

function cappedPower(base: bigint, exponent: number): bigint {
  let result = 1n;
  let factor = base;
  let remaining = exponent;
  while (remaining > 0) {
    if ((remaining & 1) === 1) result = cappedMultiply(result, factor);
    if (result > MAX_EXACT_SCHEMA_CARDINALITY) return result;
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) factor = cappedMultiply(factor, factor);
  }
  return result;
}

function cappedSchemaCardinality(schema: FiniteSchemaNode): bigint {
  switch (schema.type) {
    case 'const':
      return 1n;
    case 'boolean':
      return 2n;
    case 'enum':
      return BigInt(schema.values.length);
    case 'integer':
      return BigInt(schema.maximum) - BigInt(schema.minimum) + 1n;
    case 'object':
      return schema.fields.reduce(
        (acc, field) => cappedMultiply(acc, cappedSchemaCardinality(field.schema)),
        1n,
      );
    case 'tuple':
      return schema.items.reduce(
        (acc, item) => cappedMultiply(acc, cappedSchemaCardinality(item)),
        1n,
      );
    case 'array':
      return cappedPower(cappedSchemaCardinality(schema.items), schema.length);
    case 'union': {
      let total = 0n;
      for (const variant of schema.variants) {
        total += cappedSchemaCardinality(variant.schema);
        if (total > MAX_EXACT_SCHEMA_CARDINALITY) return CAPPED_SCHEMA_CARDINALITY;
      }
      return total;
    }
  }
}

/**
 * The maximum complete-transcript information charge, in bits, for one
 * invocation using this schema:
 *
 * ```text
 * queryBits = 1 (ok/error) + ceil(log2(successCardinality)) + 3 (timing)
 * ```
 *
 * This is the value the broker's per-repository ledger debits *before*
 * copying a seed or launching Python — never refunded, regardless of the
 * actual result or completion bucket.
 */
export function informationChargeForSchema(schema: FiniteSchemaNode): number {
  return RESULT_STATUS_BIT_COST + ceilLog2BigInt(cappedSchemaCardinality(schema)) + TIMING_BUCKET_BITS;
}

function jsonLiteralEquals(value: unknown, literal: JsonLiteral): boolean {
  if (literal === null) return value === null;
  if (typeof literal === 'number') return typeof value === 'number' && Number.isInteger(value) && value === literal;
  return value === literal;
}

/**
 * Strictly validates a parsed JSON value against an already-approved schema:
 * exact JSON type, enum membership, integer range, exact required
 * object/tuple/array shape (no extras, no missing fields, exact length), and
 * an explicit tagged-union variant. Never coerces.
 */
export function validateValueAgainstSchema(schema: FiniteSchemaNode, value: unknown): boolean {
  switch (schema.type) {
    case 'const':
      return jsonLiteralEquals(value, schema.value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return schema.values.some((candidate) => jsonLiteralEquals(value, candidate));
    case 'integer':
      return (
        typeof value === 'number'
        && Number.isInteger(value)
        && value >= schema.minimum
        && value <= schema.maximum
      );
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      if (Object.keys(obj).length !== schema.fields.length) return false;
      return schema.fields.every(
        (field) =>
          Object.prototype.hasOwnProperty.call(obj, field.name)
          && validateValueAgainstSchema(field.schema, obj[field.name]),
      );
    }
    case 'tuple':
      return (
        Array.isArray(value)
        && value.length === schema.items.length
        && schema.items.every((itemSchema, index) => validateValueAgainstSchema(itemSchema, value[index]))
      );
    case 'array':
      return (
        Array.isArray(value)
        && value.length === schema.length
        && value.every((item) => validateValueAgainstSchema(schema.items, item))
      );
    case 'union': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      if (Object.keys(obj).length !== 2 || !('tag' in obj) || !('value' in obj) || typeof obj.tag !== 'string') {
        return false;
      }
      const variant = schema.variants.find((candidate) => candidate.tag === obj.tag);
      return variant !== undefined && validateValueAgainstSchema(variant.schema, obj.value);
    }
  }
}

/**
 * Canonically re-serializes an already-validated value.
 *
 * The broker calls this on its own parsed representation — never on the raw
 * bytes a query wrote — so two different serializations of the same
 * semantic value (whitespace, key order, numeric formatting) collapse to the
 * identical observable transcript.
 */
export function canonicalizeSchemaValue(schema: FiniteSchemaNode, value: unknown): string {
  switch (schema.type) {
    case 'const':
      return JSON.stringify(schema.value);
    case 'boolean':
    case 'enum':
    case 'integer':
      return JSON.stringify(value);
    case 'object': {
      const obj = value as Record<string, unknown>;
      const parts = schema.fields.map(
        (field) => `${JSON.stringify(field.name)}:${canonicalizeSchemaValue(field.schema, obj[field.name])}`,
      );
      return `{${parts.join(',')}}`;
    }
    case 'tuple': {
      const arr = value as unknown[];
      return `[${schema.items.map((itemSchema, index) => canonicalizeSchemaValue(itemSchema, arr[index])).join(',')}]`;
    }
    case 'array': {
      const arr = value as unknown[];
      return `[${arr.map((item) => canonicalizeSchemaValue(schema.items, item)).join(',')}]`;
    }
    case 'union': {
      const obj = value as { tag: string; value: unknown };
      const variant = schema.variants.find((candidate) => candidate.tag === obj.tag);
      // Unreachable when `value` already passed validateValueAgainstSchema.
      if (!variant) return 'null';
      return `{"tag":${JSON.stringify(obj.tag)},"value":${canonicalizeSchemaValue(variant.schema, obj.value)}}`;
    }
  }
}

// ── Strict JSON parsing (no `JSON.parse`) ────────────────────────────────────

/** Hard cap on parser recursion, independent of any schema's own depth bound. */
const MAX_JSON_PARSE_DEPTH = 32;

const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function skipJsonWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && JSON_WHITESPACE.has(text[i])) i++;
  return i;
}

interface ParsedNode {
  value: unknown;
  endIndex: number;
}

/**
 * Parses a JSON string literal starting at `text[start]` (`text[start]` must
 * be `"`). Rejects raw control characters and invalid/unterminated escapes.
 */
function parseJsonStringLiteral(text: string, start: number): { value: string; endIndex: number } | undefined {
  if (text[start] !== '"') return undefined;

  let i = start + 1;
  let value = '';
  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') return { value, endIndex: i + 1 };

    if (ch === '\\') {
      const escape = text[i + 1];
      switch (escape) {
        case '"': value += '"'; i += 2; continue;
        case '\\': value += '\\'; i += 2; continue;
        case '/': value += '/'; i += 2; continue;
        case 'b': value += '\b'; i += 2; continue;
        case 'f': value += '\f'; i += 2; continue;
        case 'n': value += '\n'; i += 2; continue;
        case 'r': value += '\r'; i += 2; continue;
        case 't': value += '\t'; i += 2; continue;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        default:
          return undefined;
      }
    }

    if (ch.charCodeAt(0) < 0x20) return undefined;
    value += ch;
    i++;
  }

  return undefined;
}

function parseJsonNumber(text: string, start: number): ParsedNode | undefined {
  let i = start;
  if (text[i] === '-') i++;
  if (text[i] === '0') {
    i++;
  } else if (text[i] >= '1' && text[i] <= '9') {
    while (text[i] >= '0' && text[i] <= '9') i++;
  } else {
    return undefined;
  }
  if (text[i] === '.') {
    i++;
    if (!(text[i] >= '0' && text[i] <= '9')) return undefined;
    while (text[i] >= '0' && text[i] <= '9') i++;
  }
  if (text[i] === 'e' || text[i] === 'E') {
    i++;
    if (text[i] === '+' || text[i] === '-') i++;
    if (!(text[i] >= '0' && text[i] <= '9')) return undefined;
    while (text[i] >= '0' && text[i] <= '9') i++;
  }
  const raw = text.slice(start, i);
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return { value, endIndex: i };
}

function parseJsonValue(text: string, index: number, depth: number): ParsedNode | undefined {
  if (depth > MAX_JSON_PARSE_DEPTH) return undefined;
  const ch = text[index];

  if (ch === '{') return parseJsonObject(text, index, depth);
  if (ch === '[') return parseJsonArray(text, index, depth);
  if (ch === '"') {
    const literal = parseJsonStringLiteral(text, index);
    return literal && { value: literal.value, endIndex: literal.endIndex };
  }
  if (text.startsWith('true', index)) return { value: true, endIndex: index + 4 };
  if (text.startsWith('false', index)) return { value: false, endIndex: index + 5 };
  if (text.startsWith('null', index)) return { value: null, endIndex: index + 4 };
  if (ch === '-' || (ch >= '0' && ch <= '9')) return parseJsonNumber(text, index);
  return undefined;
}

function parseJsonObject(text: string, index: number, depth: number): ParsedNode | undefined {
  let i = skipJsonWhitespace(text, index + 1);
  const obj: Record<string, unknown> = {};
  if (text[i] === '}') return { value: obj, endIndex: i + 1 };

  for (;;) {
    i = skipJsonWhitespace(text, i);
    const key = parseJsonStringLiteral(text, i);
    if (!key) return undefined;
    i = skipJsonWhitespace(text, key.endIndex);
    if (text[i] !== ':') return undefined;
    i = skipJsonWhitespace(text, i + 1);
    const value = parseJsonValue(text, i, depth + 1);
    if (!value) return undefined;
    // Reject duplicate keys outright rather than silently keeping the last
    // occurrence (which is what `JSON.parse` does) — a dedicated strict
    // parser, not a more permissive result encoding, is the safer choice.
    if (Object.prototype.hasOwnProperty.call(obj, key.value)) return undefined;
    obj[key.value] = value.value;
    i = skipJsonWhitespace(text, value.endIndex);
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === '}') return { value: obj, endIndex: i + 1 };
    return undefined;
  }
}

function parseJsonArray(text: string, index: number, depth: number): ParsedNode | undefined {
  let i = skipJsonWhitespace(text, index + 1);
  const arr: unknown[] = [];
  if (text[i] === ']') return { value: arr, endIndex: i + 1 };

  for (;;) {
    i = skipJsonWhitespace(text, i);
    const value = parseJsonValue(text, i, depth + 1);
    if (!value) return undefined;
    arr.push(value.value);
    i = skipJsonWhitespace(text, value.endIndex);
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === ']') return { value: arr, endIndex: i + 1 };
    return undefined;
  }
}

/**
 * Strictly parses exactly one JSON value from `text` — no trailing data,
 * no duplicate object keys.
 */
export function strictParseJson(text: string): { value: unknown } | undefined {
  const start = skipJsonWhitespace(text, 0);
  const result = parseJsonValue(text, start, 0);
  if (!result) return undefined;
  const end = skipJsonWhitespace(text, result.endIndex);
  if (end !== text.length) return undefined;
  return { value: result.value };
}

// ── Request/result validation and canonical envelopes ───────────────────────

/** An enclave script execution request, already assembled from MCP arguments. */
export interface EnclaveScriptRequest {
  /** Private repository (`owner/repo`) the query script runs against. */
  privateRepo: string;
  /** The caller-authored finite response schema constrained by AWF. */
  schema: FiniteSchemaNode;
  /** The query script source. */
  script: string;
}

export type EnclaveScriptRequestValidation =
  | { valid: true; request: EnclaveScriptRequest }
  | { valid: false; errors: string[] };

/**
 * Validates an unknown value as a {@link EnclaveScriptRequest}: field shape,
 * the `privateRepo` slug pattern, the finite response schema, and the
 * script size cap.
 */
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

/** The canonical JSON text for every failure: `{"status":"error"}`. */
export const CANONICAL_ERROR_RESPONSE_JSON = '{"status":"error"}';

/** Wraps an already-canonicalized result value into the canonical success envelope. */
export function canonicalSuccessJson(canonicalResultJson: string): string {
  return `{"status":"ok","result":${canonicalResultJson}}`;
}

/**
 * Parses and validates a query's raw output file contents against the
 * request's approved schema, returning the broker's own canonical
 * re-serialization of the value on success.
 *
 * Every failure mode — oversized output, malformed JSON, duplicate keys,
 * wrong type, out-of-range value, unknown enum member, missing/extra
 * fields, wrong tuple/array length, unknown union tag — maps to the same
 * `{ ok: false }`, which callers turn into {@link CANONICAL_ERROR_RESPONSE_JSON}.
 */
export function parseAndValidateFiniteOutput(
  raw: string,
  schema: FiniteSchemaNode,
): { ok: true; canonical: string } | { ok: false } {
  if (utf8ByteLength(raw) > MAX_RESULT_BYTES) return { ok: false };
  const parsed = strictParseJson(raw);
  if (!parsed) return { ok: false };
  if (!validateValueAgainstSchema(schema, parsed.value)) return { ok: false };
  return { ok: true, canonical: canonicalizeSchemaValue(schema, parsed.value) };
}
