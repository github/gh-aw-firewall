'use strict';

const crypto = require('crypto');

/**
 * Canonical hash of an invocation's finite response schema.
 *
 * ADR 0001 binds every delegated identity to "the finite schema hash" for the
 * invocation, and mcpg admits a bounded number of distinct hashes per envelope
 * (`max_dynamic_schema_hashes`). Two invocations that declare the *same*
 * schema must therefore produce the same hash regardless of key order or
 * insignificant JSON formatting, and two different schemas must never
 * collide into one admitted slot.
 *
 * The canonical form is JSON with object keys sorted by their UTF-16 code
 * units, arrays left in order (order is semantically significant in a finite
 * schema's `enum`, tuple, and union members), and no insignificant
 * whitespace. `undefined` values are dropped exactly as `JSON.stringify`
 * would drop them.
 */
function canonicalizeSchema(value) {
  if (Array.isArray(value)) return value.map(canonicalizeSchema);
  if (value === null || typeof value !== 'object') return value;
  const canonical = {};
  for (const key of Object.keys(value).sort()) {
    const entry = canonicalizeSchema(value[key]);
    if (entry !== undefined) canonical[key] = entry;
  }
  return canonical;
}

/** Returns the lowercase hex SHA-256 of a schema's canonical serialization. */
function finiteSchemaHash(schema) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeSchema(schema)), 'utf8')
    .digest('hex');
}

module.exports = { canonicalizeSchema, finiteSchemaHash };
