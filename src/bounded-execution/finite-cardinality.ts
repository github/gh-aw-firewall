/** BigInt cardinality calculations for finite response schemas. */

import type { FiniteSchemaNode } from './finite-schema';

/** Non-negative integer ceiling of `log2(n)`, for plain (non-BigInt) `n >= 1`. */
export function ceilLog2(n: number): number {
  return ceilLog2BigInt(BigInt(n));
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
  }
}

/**
 * The maximum complete-transcript information charge, in bits, for one
 * invocation using this schema:
 *
 * ```text
 * queryBits = resultStatusBitCost + ceil(log2(successCardinality)) + timingBucketBits
 * ```
 *
 * This is the value the broker's per-repository ledger debits *before*
 * copying a seed or launching Python — never refunded, regardless of the
 * actual result or completion bucket.
 */
export function informationChargeForSchema(
  schema: FiniteSchemaNode,
  resultStatusBitCost: number,
  timingBucketBits: number,
): number {
  return resultStatusBitCost + ceilLog2BigInt(cappedSchemaCardinality(schema)) + timingBucketBits;
}
