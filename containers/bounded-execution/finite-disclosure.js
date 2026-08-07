'use strict';

/**
 * Finite-disclosure request/result protocol v2 - broker-side implementation.
 *
 * This is a deliberate, behaviour-identical mirror of
 * `src/bounded-execution/finite-disclosure.ts`. The broker runs inside its own
 * container image and cannot import AWF's TypeScript sources, so the rules are
 * restated here and pinned
 * by `src/enclave-script/protocol-parity.test.ts`, which runs the *same* vector
 * table through both implementations and fails if they ever diverge.
 *
 * Do not "improve" one side without the other.
 */

const QUERY_PROTOCOL_VERSION = 2;

const MAX_SCHEMA_BYTES = 4096;
const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_NODES = 64;
const MAX_ENUM_VALUES = 4096;
const MAX_LITERAL_STRING_BYTES = 64;
const MAX_OBJECT_FIELDS = 16;
const MAX_TUPLE_ITEMS = 16;
const MAX_ARRAY_LENGTH = 64;
const MAX_UNION_VARIANTS = 16;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 8 * 1024;
const MAX_PRIVATE_REPO_LENGTH = 140;

const TIMING_BUCKETS_MS = [10, 100, 1_000, 10_000, 60_000, 600_000];
const FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS = 60_000;
const MAX_ENCLAVE_TIMEOUT_SECONDS =
  (TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1] - FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS) / 1000;

function ceilLog2(n) {
  return ceilLog2BigInt(BigInt(n));
}

const TIMING_BUCKET_BITS = ceilLog2(TIMING_BUCKETS_MS.length);
const RESULT_STATUS_BIT_COST = 1;

const PRIVATE_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function utf8ByteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function hasControlCharacters(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isValidLiteral(value) {
  if (value === null) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isInteger(value) && Number.isSafeInteger(value);
  if (typeof value === 'string') {
    return !hasControlCharacters(value) && utf8ByteLength(value) <= MAX_LITERAL_STRING_BYTES;
  }
  return false;
}

function literalTypeTag(value) {
  return value === null ? 'null' : typeof value;
}

function failSchema(ctx, message) {
  if (ctx.errors.length === 0) ctx.errors.push(message);
  return undefined;
}

function buildSchemaNode(raw, ctx, depth) {
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

  const node = raw;
  switch (node.type) {
    case 'const': {
      if (Object.keys(node).length !== 2 || !('value' in node)) {
        return failSchema(ctx, 'const schema must have exactly "type" and "value"');
      }
      if (!isValidLiteral(node.value)) {
        return failSchema(ctx, 'const value must be a bounded string, a safe integer, a boolean, or null');
      }
      return { type: 'const', value: node.value };
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
      const firstTag = literalTypeTag(values[0]);
      if (!values.every((value) => literalTypeTag(value) === firstTag)) {
        return failSchema(ctx, 'enum values must all be the same JSON type');
      }
      const uniqueCount = new Set(values.map((value) => JSON.stringify(value))).size;
      if (uniqueCount !== values.length) {
        return failSchema(ctx, 'enum values must be unique');
      }
      return { type: 'enum', values };
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
      const fields = [];
      for (const name of fieldNames) {
        const child = buildSchemaNode(fieldsRaw[name], ctx, depth + 1);
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
      const items = [];
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
      const variants = [];
      for (const tag of tags) {
        const child = buildSchemaNode(variantsRaw[tag], ctx, depth + 1);
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

function validateSchema(raw) {
  let serialized;
  try {
    serialized = JSON.stringify(raw) ?? '';
  } catch {
    return { valid: false, errors: ['schema must be JSON-serializable'] };
  }

  const ctx = { errors: [], nodeCount: 0 };
  const schema = buildSchemaNode(raw, ctx, 0);
  if (!schema || ctx.errors.length > 0) {
    return { valid: false, errors: ctx.errors.length > 0 ? ctx.errors : ['invalid schema'] };
  }
  if (raw === undefined || utf8ByteLength(serialized) > MAX_SCHEMA_BYTES) {
    return { valid: false, errors: [`schema must be a JSON value of at most ${MAX_SCHEMA_BYTES} bytes`] };
  }
  return { valid: true, schema };
}

function ceilLog2BigInt(n) {
  if (n <= 1n) return 0;
  let bits = 0;
  let remainder = n - 1n;
  while (remainder > 0n) {
    remainder >>= 1n;
    bits += 1;
  }
  return bits;
}

function schemaCardinality(schema) {
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
    default:
      throw new Error(`unreachable schema type: ${schema.type}`);
  }
}

const MAX_EXACT_SCHEMA_CARDINALITY = 1n << 1024n;
const CAPPED_SCHEMA_CARDINALITY = MAX_EXACT_SCHEMA_CARDINALITY + 1n;

function cappedMultiply(left, right) {
  if (left === 0n || right === 0n) return 0n;
  if (left > MAX_EXACT_SCHEMA_CARDINALITY / right) return CAPPED_SCHEMA_CARDINALITY;
  return left * right;
}

function cappedPower(base, exponent) {
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

function cappedSchemaCardinality(schema) {
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
    default:
      throw new Error(`unreachable schema type: ${schema.type}`);
  }
}

function informationChargeForSchema(schema) {
  return RESULT_STATUS_BIT_COST + ceilLog2BigInt(cappedSchemaCardinality(schema)) + TIMING_BUCKET_BITS;
}

function jsonLiteralEquals(value, literal) {
  if (literal === null) return value === null;
  if (typeof literal === 'number') return typeof value === 'number' && Number.isInteger(value) && value === literal;
  return value === literal;
}

function validateValueAgainstSchema(schema, value) {
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
      if (Object.keys(value).length !== schema.fields.length) return false;
      return schema.fields.every(
        (field) =>
          Object.prototype.hasOwnProperty.call(value, field.name)
          && validateValueAgainstSchema(field.schema, value[field.name]),
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
      if (Object.keys(value).length !== 2 || !('tag' in value) || !('value' in value) || typeof value.tag !== 'string') {
        return false;
      }
      const variant = schema.variants.find((candidate) => candidate.tag === value.tag);
      return variant !== undefined && validateValueAgainstSchema(variant.schema, value.value);
    }
    default:
      return false;
  }
}

function canonicalizeSchemaValue(schema, value) {
  switch (schema.type) {
    case 'const':
      return JSON.stringify(schema.value);
    case 'boolean':
    case 'enum':
    case 'integer':
      return JSON.stringify(value);
    case 'object': {
      const parts = schema.fields.map(
        (field) => `${JSON.stringify(field.name)}:${canonicalizeSchemaValue(field.schema, value[field.name])}`,
      );
      return `{${parts.join(',')}}`;
    }
    case 'tuple':
      return `[${schema.items.map((itemSchema, index) => canonicalizeSchemaValue(itemSchema, value[index])).join(',')}]`;
    case 'array':
      return `[${value.map((item) => canonicalizeSchemaValue(schema.items, item)).join(',')}]`;
    case 'union': {
      const variant = schema.variants.find((candidate) => candidate.tag === value.tag);
      if (!variant) return 'null';
      return `{"tag":${JSON.stringify(value.tag)},"value":${canonicalizeSchemaValue(variant.schema, value.value)}}`;
    }
    default:
      throw new Error(`unreachable schema type: ${schema.type}`);
  }
}

// ── Strict JSON parsing (no `JSON.parse`) ────────────────────────────────────

const MAX_JSON_PARSE_DEPTH = 32;
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function skipJsonWhitespace(text, index) {
  let i = index;
  while (i < text.length && JSON_WHITESPACE.has(text[i])) i++;
  return i;
}

function parseJsonStringLiteral(text, start) {
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

function parseJsonNumber(text, start) {
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

function parseJsonValue(text, index, depth) {
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

function parseJsonObject(text, index, depth) {
  let i = skipJsonWhitespace(text, index + 1);
  const obj = {};
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
    if (Object.prototype.hasOwnProperty.call(obj, key.value)) return undefined;
    obj[key.value] = value.value;
    i = skipJsonWhitespace(text, value.endIndex);
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === '}') return { value: obj, endIndex: i + 1 };
    return undefined;
  }
}

function parseJsonArray(text, index, depth) {
  let i = skipJsonWhitespace(text, index + 1);
  const arr = [];
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

function strictParseJson(text) {
  const start = skipJsonWhitespace(text, 0);
  const result = parseJsonValue(text, start, 0);
  if (!result) return undefined;
  const end = skipJsonWhitespace(text, result.endIndex);
  if (end !== text.length) return undefined;
  return { value: result.value };
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
  ceilLog2BigInt,
  schemaCardinality,
  informationChargeForSchema,
  validateValueAgainstSchema,
  canonicalizeSchemaValue,
  strictParseJson,
  validateEnclaveScriptRequest,
  canonicalSuccessJson,
  parseAndValidateFiniteOutput,
};
