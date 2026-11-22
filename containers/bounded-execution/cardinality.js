'use strict';

/** Mirrors src/bounded-execution/finite-cardinality.ts. Keep both implementations in parity. */

function ceilLog2(n) {
  return ceilLog2BigInt(BigInt(n));
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
    case 'string':
      throw new Error('free-form string schemas do not have finite cardinality');
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
    case 'string':
      throw new Error('free-form string schemas do not have finite cardinality');
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

function informationChargeForSchema(schema, resultStatusBitCost, timingBucketBits) {
  return resultStatusBitCost + ceilLog2BigInt(cappedSchemaCardinality(schema)) + timingBucketBits;
}

module.exports = {
  ceilLog2,
  ceilLog2BigInt,
  schemaCardinality,
  informationChargeForSchema,
};
