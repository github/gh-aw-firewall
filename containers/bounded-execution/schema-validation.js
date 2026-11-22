'use strict';

/** Mirrors src/bounded-execution/finite-schema.ts. Keep both implementations in parity. */

const { utf8ByteLength } = require('./strict-json');

const MAX_SCHEMA_BYTES = 4096;
const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_NODES = 64;
const MAX_ENUM_VALUES = 4096;
const MAX_LITERAL_STRING_BYTES = 64;
const MAX_OBJECT_FIELDS = 16;
const MAX_TUPLE_ITEMS = 16;
const MAX_ARRAY_LENGTH = 64;
const MAX_UNION_VARIANTS = 16;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

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
        'schema node "type" must be one of: const, boolean, string, enum, integer, object, tuple, array, union',
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
    case 'string':
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

function schemaContainsFreeformString(schema) {
  switch (schema.type) {
    case 'string':
      return true;
    case 'object':
      return schema.fields.some((field) => schemaContainsFreeformString(field.schema));
    case 'tuple':
      return schema.items.some(schemaContainsFreeformString);
    case 'array':
      return schemaContainsFreeformString(schema.items);
    case 'union':
      return schema.variants.some((variant) => schemaContainsFreeformString(variant.schema));
    default:
      return false;
  }
}

/** Mirrors finite-schema.ts: only validated parsed schemas may be serialized. */
function serializeFiniteSchema(schema) {
  switch (schema.type) {
    case 'object':
      return { type: 'object', fields: Object.fromEntries(
        schema.fields.map(({ name, schema: child }) => [name, serializeFiniteSchema(child)]),
      ) };
    case 'union':
      return { type: 'union', variants: Object.fromEntries(
        schema.variants.map(({ tag, schema: child }) => [tag, serializeFiniteSchema(child)]),
      ) };
    case 'tuple':
      return { type: 'tuple', items: schema.items.map(serializeFiniteSchema) };
    case 'array':
      return { type: 'array', items: serializeFiniteSchema(schema.items), length: schema.length };
    default:
      return schema;
  }
}

module.exports = {
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
};
