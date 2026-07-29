import * as path from 'path';
import {
  CANONICAL_ERROR_JSON,
  MAX_ARRAY_LENGTH,
  MAX_ENUM_VALUES,
  MAX_OBJECT_FIELDS,
  MAX_PRIVATE_REPO_LENGTH,
  MAX_PROBE_TIMEOUT_SECONDS,
  MAX_RESULT_BYTES,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_NODES,
  MAX_SCRIPT_BYTES,
  MAX_TUPLE_ITEMS,
  MAX_UNION_VARIANTS,
  PROBE_PROTOCOL_VERSION,
  RESULT_STATUS_BIT_COST,
  FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS,
  SEALED_PROBE_REPO_PATTERN,
  TIMING_BUCKETS_MS,
  TIMING_BUCKET_BITS,
  canonicalOkJson,
  canonicalizeSchemaValue,
  ceilLog2BigInt,
  parseAndValidateProbeOutput,
  queryBitsForSchema,
  schemaCardinality,
  strictParseJson,
  validateSchema,
  validateSealedProbeRequest,
  validateValueAgainstSchema,
  type SealedProbeSchemaNode,
} from './protocol';
import {
  SEALED_PROBE_SENSITIVITIES,
  SEALED_PROBE_SENSITIVITY_RUN_BITS,
} from '../types/sealed-probe-options';

/**
 * The broker runs in its own container image and cannot import AWF's
 * TypeScript sources, so `containers/sealed-probe/broker/protocol.js`
 * restates the entire v2 protocol (finite schema algebra, cardinality/bit
 * charge, strict JSON parsing, request/result validation, canonicalization).
 * This suite runs one shared vector table through *both* implementations and
 * fails the moment they disagree, which is what makes the duplication safe.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const brokerProtocol = require(
  path.join(__dirname, '..', '..', 'containers', 'sealed-probe', 'broker', 'protocol.js'),
);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const brokerSensitivity = require(
  path.join(__dirname, '..', '..', 'containers', 'sealed-probe', 'broker', 'sensitivity.js'),
);

const SCHEMA_VECTORS: Array<{ name: string; schema: unknown }> = [
  { name: 'const string', schema: { type: 'const', value: 'ok' } },
  { name: 'const number', schema: { type: 'const', value: 42 } },
  { name: 'const boolean', schema: { type: 'const', value: false } },
  { name: 'const null', schema: { type: 'const', value: null } },
  { name: 'const extra property', schema: { type: 'const', value: 1, extra: true } },
  { name: 'boolean', schema: { type: 'boolean' } },
  { name: 'boolean extra property', schema: { type: 'boolean', extra: true } },
  { name: 'string enum', schema: { type: 'enum', values: ['a', 'b', 'c'] } },
  { name: 'integer enum', schema: { type: 'enum', values: [1, 2, 3] } },
  { name: 'enum duplicate values', schema: { type: 'enum', values: ['a', 'a'] } },
  { name: 'enum mixed types', schema: { type: 'enum', values: ['a', 1] } },
  { name: 'enum empty', schema: { type: 'enum', values: [] } },
  { name: `enum oversized (${MAX_ENUM_VALUES + 1})`, schema: { type: 'enum', values: Array.from({ length: MAX_ENUM_VALUES + 1 }, (_, i) => i) } },
  { name: 'integer bounded', schema: { type: 'integer', minimum: 0, maximum: 255 } },
  { name: 'integer maximum below minimum', schema: { type: 'integer', minimum: 10, maximum: 0 } },
  { name: 'integer non-integer bound', schema: { type: 'integer', minimum: 0.5, maximum: 10 } },
  {
    name: 'object fixed fields',
    schema: {
      type: 'object',
      fields: { ok: { type: 'boolean' }, count: { type: 'integer', minimum: 0, maximum: 3 } },
    },
  },
  { name: 'object empty fields', schema: { type: 'object', fields: {} } },
  {
    name: `object oversized (${MAX_OBJECT_FIELDS + 1} fields)`,
    schema: {
      type: 'object',
      fields: Object.fromEntries(Array.from({ length: MAX_OBJECT_FIELDS + 1 }, (_, i) => [`f${i}`, { type: 'boolean' }])),
    },
  },
  { name: 'object invalid field name', schema: { type: 'object', fields: { 'bad name': { type: 'boolean' } } } },
  { name: 'tuple', schema: { type: 'tuple', items: [{ type: 'boolean' }, { type: 'boolean' }] } },
  { name: 'tuple empty', schema: { type: 'tuple', items: [] } },
  {
    name: `tuple oversized (${MAX_TUPLE_ITEMS + 1} items)`,
    schema: { type: 'tuple', items: Array.from({ length: MAX_TUPLE_ITEMS + 1 }, () => ({ type: 'boolean' })) },
  },
  { name: 'array fixed length', schema: { type: 'array', items: { type: 'boolean' }, length: 5 } },
  { name: 'array zero length', schema: { type: 'array', items: { type: 'boolean' }, length: 0 } },
  { name: 'array negative length', schema: { type: 'array', items: { type: 'boolean' }, length: -1 } },
  { name: `array oversized length (${MAX_ARRAY_LENGTH + 1})`, schema: { type: 'array', items: { type: 'boolean' }, length: MAX_ARRAY_LENGTH + 1 } },
  {
    name: 'union tagged disjoint',
    schema: {
      type: 'union',
      variants: { a: { type: 'boolean' }, b: { type: 'integer', minimum: 0, maximum: 9 } },
    },
  },
  { name: 'union empty variants', schema: { type: 'union', variants: {} } },
  {
    name: `union oversized (${MAX_UNION_VARIANTS + 1} variants)`,
    schema: {
      type: 'union',
      variants: Object.fromEntries(Array.from({ length: MAX_UNION_VARIANTS + 1 }, (_, i) => [`v${i}`, { type: 'boolean' }])),
    },
  },
  { name: 'union invalid tag', schema: { type: 'union', variants: { '1bad': { type: 'boolean' } } } },
  { name: 'unknown node type', schema: { type: 'string' } },
  { name: 'not an object', schema: 'nope' },
  { name: 'null', schema: null },
  { name: 'array instead of object', schema: [1, 2] },
  { name: 'nested composite', schema: {
    type: 'object',
    fields: {
      status: { type: 'enum', values: ['ok', 'error'] },
      items: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 9 }, length: 3 },
      pair: { type: 'tuple', items: [{ type: 'boolean' }, { type: 'const', value: 'x' }] },
      choice: { type: 'union', variants: { a: { type: 'boolean' }, b: { type: 'boolean' } } },
    },
  } },
  {
    name: `depth exceeded (${MAX_SCHEMA_DEPTH + 1} levels)`,
    schema: (() => {
      let deep: unknown = { type: 'boolean' };
      for (let i = 0; i <= MAX_SCHEMA_DEPTH; i++) deep = { type: 'array', items: deep, length: 1 };
      return deep;
    })(),
  },
  {
    name: 'depth at exact limit',
    schema: (() => {
      let atLimit: unknown = { type: 'boolean' };
      for (let i = 0; i < MAX_SCHEMA_DEPTH; i++) atLimit = { type: 'array', items: atLimit, length: 1 };
      return atLimit;
    })(),
  },
  {
    name: `node count exceeded (${MAX_SCHEMA_NODES} leaves)`,
    schema: { type: 'tuple', items: Array.from({ length: MAX_SCHEMA_NODES }, () => ({ type: 'boolean' })) },
  },
  { name: 'undefined', schema: undefined },
];

const VALID_SCHEMAS_FOR_VALUE_TESTS: Array<{
  name: string;
  schema: SealedProbeSchemaNode;
  values: unknown[];
}> = [
  { name: 'const', schema: { type: 'const', value: 'ok' }, values: ['ok', 'not-ok', 1, null] },
  { name: 'boolean', schema: { type: 'boolean' }, values: [true, false, 1, 'true', null] },
  { name: 'enum', schema: { type: 'enum', values: ['a', 'b'] }, values: ['a', 'b', 'c', 1] },
  {
    name: 'integer',
    schema: { type: 'integer', minimum: 0, maximum: 10 },
    values: [0, 5, 10, 11, -1, 5.5, '5'],
  },
  {
    name: 'object',
    schema: { type: 'object', fields: [{ name: 'ok', schema: { type: 'boolean' } }] },
    values: [{ ok: true }, {}, { ok: true, extra: 1 }, { ok: 'no' }, null, [true]],
  },
  {
    name: 'tuple',
    schema: { type: 'tuple', items: [{ type: 'boolean' }, { type: 'boolean' }] },
    values: [[true, false], [true], [true, false, true], 'not-an-array'],
  },
  {
    name: 'array',
    schema: { type: 'array', items: { type: 'boolean' }, length: 2 },
    values: [[true, false], [true], [true, false, true]],
  },
  {
    name: 'union',
    schema: {
      type: 'union',
      variants: [
        { tag: 'a', schema: { type: 'boolean' } },
        { tag: 'b', schema: { type: 'integer', minimum: 0, maximum: 9 } },
      ],
    },
    values: [
      { tag: 'a', value: true },
      { tag: 'b', value: 5 },
      { tag: 'b', value: true },
      { tag: 'c', value: true },
      { tag: 'a', value: true, extra: 1 },
      true,
    ],
  },
];

const REQUEST_VECTORS: Array<{ name: string; request: unknown }> = [
  { name: 'valid request', request: { privateRepo: 'octo/private', schema: { type: 'boolean' }, script: 'print(1)' } },
  { name: 'not an object', request: 'nope' },
  { name: 'null', request: null },
  { name: 'array', request: [] },
  { name: 'extra control field', request: { privateRepo: 'octo/private', schema: { type: 'boolean' }, script: 'x', image: 'evil' } },
  { name: 'timeout control field', request: { privateRepo: 'octo/private', schema: { type: 'boolean' }, script: 'x', timeout: 9999 } },
  { name: 'missing repo', request: { schema: { type: 'boolean' }, script: 'x' } },
  { name: 'url repo', request: { privateRepo: 'https://github.com/octo/private', schema: { type: 'boolean' }, script: 'x' } },
  { name: 'traversal repo', request: { privateRepo: 'octo/../../etc', schema: { type: 'boolean' }, script: 'x' } },
  { name: 'wildcard repo', request: { privateRepo: 'octo/*', schema: { type: 'boolean' }, script: 'x' } },
  { name: 'query repo', request: { privateRepo: 'octo/private?x=1', schema: { type: 'boolean' }, script: 'x' } },
  { name: `oversized repo (> ${MAX_PRIVATE_REPO_LENGTH})`, request: { privateRepo: `octo/${'r'.repeat(MAX_PRIVATE_REPO_LENGTH)}`, schema: { type: 'boolean' }, script: 'x' } },
  { name: 'missing schema', request: { privateRepo: 'octo/private', script: 'x' } },
  { name: 'invalid schema', request: { privateRepo: 'octo/private', schema: { type: 'nope' }, script: 'x' } },
  { name: 'empty script', request: { privateRepo: 'octo/private', schema: { type: 'boolean' }, script: '' } },
  { name: 'non-string script', request: { privateRepo: 'octo/private', schema: { type: 'boolean' }, script: 42 } },
  { name: 'oversized script', request: { privateRepo: 'octo/private', schema: { type: 'boolean' }, script: 'x'.repeat(MAX_SCRIPT_BYTES + 1) } },
  { name: 'script at exact size cap', request: { privateRepo: 'octo/private', schema: { type: 'boolean' }, script: 'x'.repeat(MAX_SCRIPT_BYTES) } },
];

const RESULT_VECTORS: Array<{ name: string; schema: SealedProbeSchemaNode; raw: string }> = [
  { name: 'valid enum result', schema: { type: 'enum', values: ['YES', 'NO', 'UNKNOWN'] }, raw: '{"result":"YES"}' },
  {
    name: 'whitespace tolerant',
    schema: { type: 'object', fields: [{ name: 'result', schema: { type: 'enum', values: ['NO'] } }] },
    raw: '  { "result" : "NO" }  ',
  },
  { name: 'malformed JSON', schema: { type: 'boolean' }, raw: 'not json at all' },
  { name: 'duplicate keys', schema: { type: 'object', fields: [{ name: 'result', schema: { type: 'boolean' } }] }, raw: '{"result":true,"result":false}' },
  { name: 'trailing data', schema: { type: 'boolean' }, raw: 'true extra' },
  { name: 'two values concatenated', schema: { type: 'boolean' }, raw: 'true false' },
  { name: 'extra fields', schema: { type: 'object', fields: [{ name: 'ok', schema: { type: 'boolean' } }] }, raw: '{"ok":true,"extra":1}' },
  { name: 'value outside enum', schema: { type: 'enum', values: ['a', 'b'] }, raw: '"c"' },
  { name: 'wrong type', schema: { type: 'boolean' }, raw: '1' },
  { name: 'null value against boolean', schema: { type: 'boolean' }, raw: 'null' },
  { name: 'array instead of object', schema: { type: 'object', fields: [{ name: 'a', schema: { type: 'boolean' } }] }, raw: '["a"]' },
  { name: 'empty string', schema: { type: 'boolean' }, raw: '' },
  { name: 'single-quoted string', schema: { type: 'boolean' }, raw: "'true'" },
  { name: 'unterminated string', schema: { type: 'enum', values: ['x'] }, raw: '"x' },
  { name: 'raw control character', schema: { type: 'enum', values: ['line\nbreak'] }, raw: '"line\nbreak"' },
  { name: 'unicode escape', schema: { type: 'enum', values: ['s'] }, raw: '"\\u0073"' },
  { name: 'invalid hex escape', schema: { type: 'boolean' }, raw: '"\\uZZZZ"' },
  { name: 'invalid escape letter', schema: { type: 'boolean' }, raw: '"\\x41"' },
  { name: 'oversized result', schema: { type: 'enum', values: ['x'.repeat(MAX_RESULT_BYTES)] }, raw: `"${'x'.repeat(MAX_RESULT_BYTES)}"` },
  {
    name: 'nested object matches regardless of key order',
    schema: {
      type: 'object',
      fields: [
        { name: 'a', schema: { type: 'boolean' } },
        { name: 'b', schema: { type: 'boolean' } },
      ],
    },
    raw: '{"b":true,"a":false}',
  },
];

describe('sealed-probe protocol parity (TypeScript vs broker JavaScript)', () => {
  it('exposes identical protocol constants', () => {
    expect(brokerProtocol.PROBE_PROTOCOL_VERSION).toBe(PROBE_PROTOCOL_VERSION);
    expect(brokerProtocol.MAX_SCHEMA_BYTES).toBe(MAX_SCHEMA_BYTES);
    expect(brokerProtocol.MAX_SCHEMA_DEPTH).toBe(MAX_SCHEMA_DEPTH);
    expect(brokerProtocol.MAX_SCHEMA_NODES).toBe(MAX_SCHEMA_NODES);
    expect(brokerProtocol.MAX_ENUM_VALUES).toBe(MAX_ENUM_VALUES);
    expect(brokerProtocol.MAX_OBJECT_FIELDS).toBe(MAX_OBJECT_FIELDS);
    expect(brokerProtocol.MAX_TUPLE_ITEMS).toBe(MAX_TUPLE_ITEMS);
    expect(brokerProtocol.MAX_ARRAY_LENGTH).toBe(MAX_ARRAY_LENGTH);
    expect(brokerProtocol.MAX_UNION_VARIANTS).toBe(MAX_UNION_VARIANTS);
    expect(brokerProtocol.MAX_SCRIPT_BYTES).toBe(MAX_SCRIPT_BYTES);
    expect(brokerProtocol.MAX_RESULT_BYTES).toBe(MAX_RESULT_BYTES);
    expect(brokerProtocol.MAX_PRIVATE_REPO_LENGTH).toBe(MAX_PRIVATE_REPO_LENGTH);
    expect(brokerProtocol.TIMING_BUCKETS_MS).toEqual(TIMING_BUCKETS_MS);
    expect(brokerProtocol.FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS)
      .toBe(FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS);
    expect(brokerProtocol.MAX_PROBE_TIMEOUT_SECONDS).toBe(MAX_PROBE_TIMEOUT_SECONDS);
    expect(brokerProtocol.TIMING_BUCKET_BITS).toBe(TIMING_BUCKET_BITS);
    expect(brokerProtocol.RESULT_STATUS_BIT_COST).toBe(RESULT_STATUS_BIT_COST);
    expect(brokerProtocol.SEALED_PROBE_REPO_PATTERN.source).toBe(SEALED_PROBE_REPO_PATTERN.source);
    expect(brokerProtocol.CANONICAL_ERROR_JSON).toBe(CANONICAL_ERROR_JSON);
  });

  it('keeps broker sensitivity categories and run budgets aligned with host policy', () => {
    expect(brokerSensitivity.SEALED_PROBE_SENSITIVITIES).toEqual(SEALED_PROBE_SENSITIVITIES);
    expect(brokerSensitivity.SEALED_PROBE_SENSITIVITY_RUN_BITS).toEqual(
      SEALED_PROBE_SENSITIVITY_RUN_BITS,
    );
  });

  it.each(SCHEMA_VECTORS)('agrees on schema validity: $name', ({ schema }) => {
    const ts = validateSchema(schema);
    const js = brokerProtocol.validateSchema(schema);
    expect(js.valid).toBe(ts.valid);
    if (ts.valid && js.valid) {
      expect(js.schema).toEqual(ts.schema);
    }
  });

  it.each(SCHEMA_VECTORS.filter((v) => validateSchema(v.schema).valid))(
    'agrees on cardinality and query-bit charge for valid schema: $name',
    ({ schema }) => {
      const tsValidation = validateSchema(schema);
      const jsValidation = brokerProtocol.validateSchema(schema);
      if (!tsValidation.valid || !jsValidation.valid) throw new Error('unreachable: filtered to valid schemas');

      const tsCardinality = schemaCardinality(tsValidation.schema);
      const jsCardinality = brokerProtocol.schemaCardinality(jsValidation.schema);
      expect(jsCardinality).toBe(tsCardinality);

      const tsBits = queryBitsForSchema(tsValidation.schema);
      const jsBits = brokerProtocol.queryBitsForSchema(jsValidation.schema);
      expect(jsBits).toBe(tsBits);
    },
  );

  it.each(
    VALID_SCHEMAS_FOR_VALUE_TESTS.flatMap(({ name, schema, values }) =>
      values.map((value, index) => ({ name: `${name}[${index}]`, schema, value })),
    ),
  )('agrees on value validation and canonicalization: $name', ({ schema, value }) => {
    const tsValid = validateValueAgainstSchema(schema, value);
    const jsValid = brokerProtocol.validateValueAgainstSchema(schema, value);
    expect(jsValid).toBe(tsValid);

    if (tsValid && jsValid) {
      expect(brokerProtocol.canonicalizeSchemaValue(schema, value)).toBe(canonicalizeSchemaValue(schema, value));
    }
  });

  it.each(REQUEST_VECTORS)('agrees on request validity: $name', ({ request }) => {
    const ts = validateSealedProbeRequest(request);
    const js = brokerProtocol.validateSealedProbeRequest(request);

    expect(js.valid).toBe(ts.valid);
    if (!ts.valid && !js.valid) {
      expect(js.errors).toEqual(ts.errors);
    }
  });

  it.each(RESULT_VECTORS)('agrees on probe output parsing/validation: $name', ({ schema, raw }) => {
    const ts = parseAndValidateProbeOutput(raw, schema);
    const js = brokerProtocol.parseAndValidateProbeOutput(raw, schema);
    expect(js).toEqual(ts);
  });

  it('agrees on strict JSON parsing', () => {
    const vectors = ['{"a":1}', '{"a":1,"a":2}', '{"a":1} extra', 'not json', '', '"\\u0073"', '"\\uZZZZ"'];
    for (const raw of vectors) {
      expect(brokerProtocol.strictParseJson(raw)).toEqual(strictParseJson(raw));
    }
  });

  it('agrees on ceilLog2BigInt across boundary values', () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 5n, 8n, 9n, 1024n, 1025n, 2n ** 64n]) {
      expect(brokerProtocol.ceilLog2BigInt(n)).toBe(ceilLog2BigInt(n));
    }
  });

  it('agrees on the canonical ok envelope wrapper', () => {
    for (const canonical of ['true', '"ok"', '{"a":1}']) {
      expect(brokerProtocol.canonicalOkJson(canonical)).toBe(canonicalOkJson(canonical));
    }
  });
});
