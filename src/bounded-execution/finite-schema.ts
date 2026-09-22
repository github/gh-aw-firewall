/** Finite response-schema algebra, validation, and value canonicalization. */

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
export interface StringSchemaNode {
  readonly type: 'string';
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
  | StringSchemaNode
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
    case 'string': {
      if (Object.keys(node).length !== 1) {
        return failSchema(ctx, 'string schema must have only "type"');
      }
      return { type: 'string' };
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
        'schema node "type" must be one of: const, boolean, string, enum, integer, object, tuple, array, union',
      );
  }
}

/**
 * Validates and parses an agent-authored schema.
 *
 * Rejects anything outside the structured algebra above: floats, regex
 * domains, recursion/`$ref` (there is no such construct to begin with),
 * optional properties, `additionalProperties`, and overlapping untagged
 * unions are all structurally impossible to express, so they are rejected by
 * construction rather than by a separate deny-list. Free-form string nodes
 * are parsed here and authorized against trusted repository metadata by the
 * enclave broker before execution.
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
    case 'string':
      return typeof value === 'string';
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
    case 'string':
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

/** Whether a schema contains a free-form string node reserved for trusted repositories. */
export function schemaContainsFreeformString(schema: FiniteSchemaNode): boolean {
  switch (schema.type) {
    case 'string':
      return true;
    case 'object':
      return schema.fields.some(field => schemaContainsFreeformString(field.schema));
    case 'tuple':
      return schema.items.some(schemaContainsFreeformString);
    case 'array':
      return schemaContainsFreeformString(schema.items);
    case 'union':
      return schema.variants.some(variant => schemaContainsFreeformString(variant.schema));
    default:
      return false;
  }
}
