import {
  CANONICAL_ERROR_JSON,
  MAX_ARRAY_LENGTH,
  MAX_ENUM_VALUES,
  MAX_LITERAL_STRING_BYTES,
  MAX_OBJECT_FIELDS,
  MAX_PRIVATE_REPO_LENGTH,
  MAX_RESULT_BYTES,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_NODES,
  MAX_SCRIPT_BYTES,
  MAX_TUPLE_ITEMS,
  MAX_UNION_VARIANTS,
  PROBE_PROTOCOL_VERSION,
  RESULT_STATUS_BIT_COST,
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
  SEALED_PROBE_DEFAULTS as EXPORTED_DEFAULTS,
  SEALED_PROBE_SENSITIVITIES as EXPORTED_SENSITIVITIES,
  SEALED_PROBE_SENSITIVITY_RUN_BITS as EXPORTED_RUN_BITS,
} from '../types';

describe('protocol constants', () => {
  it('fixes the wire protocol version at 2', () => {
    expect(PROBE_PROTOCOL_VERSION).toBe(2);
  });

  it('has exactly six timing buckets and 3 timing bits', () => {
    expect(TIMING_BUCKETS_MS).toEqual([10, 100, 1_000, 10_000, 60_000, 600_000]);
    expect(TIMING_BUCKET_BITS).toBe(3);
  });

  it('charges 1 bit for the ok/error distinction', () => {
    expect(RESULT_STATUS_BIT_COST).toBe(1);
  });

  it('exposes sealed-probe policy constants through the public types barrel', () => {
    expect(EXPORTED_DEFAULTS.timeout).toBe(30);
    expect(EXPORTED_SENSITIVITIES).toEqual(['public', 'internal', 'confidential', 'sealed']);
    expect(EXPORTED_RUN_BITS).toEqual({ public: null, internal: 64, confidential: 8, sealed: 0 });
  });
});

describe('SEALED_PROBE_REPO_PATTERN', () => {
  it.each(['octo/repo', 'octo-org/octo-repo', 'my-org/my.repo-name_2', 'a/b'])(
    'accepts a valid owner/repo slug: %s',
    (slug) => {
      expect(SEALED_PROBE_REPO_PATTERN.test(slug)).toBe(true);
    },
  );

  it.each([
    ['a full URL', 'https://github.com/octo/repo'],
    ['a scheme-relative URL', '//github.com/octo/repo'],
    ['a wildcard', 'octo/*'],
    ['dot-traversal repo', 'octo/..'],
    ['single-dot repo', 'octo/.'],
    ['embedded traversal', 'octo/re..po'],
    ['a query string', 'octo/repo?x=1'],
    ['a fragment', 'octo/repo#section'],
    ['an extra path segment', 'octo/repo/extra'],
    ['no owner', '/repo'],
    ['no slash', 'octorepo'],
    ['leading slash owner', '/octo/repo'],
    ['owner starting with dot', './repo'],
  ])('rejects %s', (_label, slug) => {
    expect(SEALED_PROBE_REPO_PATTERN.test(slug)).toBe(false);
  });
});

describe('ceilLog2BigInt', () => {
  it.each([
    [0n, 0],
    [1n, 0],
    [2n, 1],
    [3n, 2],
    [4n, 2],
    [5n, 3],
    [8n, 3],
    [9n, 4],
    [1024n, 10],
    [1025n, 11],
  ])('ceilLog2BigInt(%s) === %s', (n, expected) => {
    expect(ceilLog2BigInt(n)).toBe(expected);
  });

  it('handles very large cardinalities without floating-point overflow', () => {
    // 2^100, computed without ever going through a floating-point log.
    const huge = 2n ** 100n;
    expect(ceilLog2BigInt(huge)).toBe(100);
    expect(ceilLog2BigInt(huge + 1n)).toBe(101);
  });
});

describe('validateSchema', () => {
  it('accepts a const schema', () => {
    const result = validateSchema({ type: 'const', value: 'ok' });
    expect(result).toEqual({ valid: true, schema: { type: 'const', value: 'ok' } });
  });

  it('rejects a const schema with extra properties', () => {
    expect(validateSchema({ type: 'const', value: 'ok', extra: 1 }).valid).toBe(false);
  });

  it('rejects malformed literal and schema-node shapes', () => {
    expect(validateSchema({ type: 'const' }).valid).toBe(false);
    expect(validateSchema({ type: 'const', value: { arbitrary: 'object' } }).valid).toBe(false);
    expect(validateSchema({ type: 'const', value: 'line\nbreak' }).valid).toBe(false);
    expect(validateSchema({ type: 'enum' }).valid).toBe(false);
    expect(validateSchema({ type: 'enum', values: [undefined] }).valid).toBe(false);
    expect(validateSchema({ type: 'enum', values: [null] }).valid).toBe(true);
    expect(validateSchema({ type: 'integer', minimum: 0 }).valid).toBe(false);
    expect(validateSchema({ type: 'object' }).valid).toBe(false);
    expect(validateSchema({ type: 'object', fields: [] }).valid).toBe(false);
    expect(validateSchema({ type: 'tuple' }).valid).toBe(false);
    expect(validateSchema({ type: 'array', items: { type: 'boolean' } }).valid).toBe(false);
    expect(validateSchema({ type: 'union' }).valid).toBe(false);
    expect(validateSchema({ type: 'union', variants: [] }).valid).toBe(false);
    expect(validateSchema({ type: 'union', variants: { bad: { type: 'unknown' } } }).valid).toBe(false);
  });

  it('accepts a boolean schema and rejects extra properties', () => {
    expect(validateSchema({ type: 'boolean' })).toEqual({ valid: true, schema: { type: 'boolean' } });
    expect(validateSchema({ type: 'boolean', extra: 1 }).valid).toBe(false);
  });

  it('accepts a unique enum schema of a single JSON type', () => {
    const result = validateSchema({ type: 'enum', values: ['a', 'b', 'c'] });
    expect(result).toEqual({ valid: true, schema: { type: 'enum', values: ['a', 'b', 'c'] } });
  });

  it('rejects an enum with duplicate values', () => {
    expect(validateSchema({ type: 'enum', values: ['a', 'a'] }).valid).toBe(false);
  });

  it('rejects an enum mixing JSON types', () => {
    expect(validateSchema({ type: 'enum', values: ['a', 1] }).valid).toBe(false);
  });

  it('rejects an empty enum', () => {
    expect(validateSchema({ type: 'enum', values: [] }).valid).toBe(false);
  });

  it(`rejects an enum exceeding ${MAX_ENUM_VALUES} values`, () => {
    const values = Array.from({ length: MAX_ENUM_VALUES + 1 }, (_, i) => i);
    const result = validateSchema({ type: 'enum', values });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/at most 4096 entries|4096 bytes/);
    }
  });

  it('accepts a moderately sized enum comfortably under both the count and byte caps', () => {
    const values = Array.from({ length: 200 }, (_, i) => i);
    expect(validateSchema({ type: 'enum', values }).valid).toBe(true);
  });

  it('accepts a bounded integer schema and rejects maximum < minimum', () => {
    expect(validateSchema({ type: 'integer', minimum: 0, maximum: 10 }).valid).toBe(true);
    expect(validateSchema({ type: 'integer', minimum: 10, maximum: 0 }).valid).toBe(false);
  });

  it('rejects a non-integer or unsafe integer bound', () => {
    expect(validateSchema({ type: 'integer', minimum: 0.5, maximum: 10 }).valid).toBe(false);
    expect(validateSchema({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER + 1 }).valid).toBe(false);
  });

  it('accepts a required fixed object schema', () => {
    const result = validateSchema({
      type: 'object',
      fields: { ok: { type: 'boolean' }, count: { type: 'integer', minimum: 0, maximum: 3 } },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an object schema with zero fields or too many fields', () => {
    expect(validateSchema({ type: 'object', fields: {} }).valid).toBe(false);
    const tooMany: Record<string, unknown> = {};
    for (let i = 0; i < MAX_OBJECT_FIELDS + 1; i++) tooMany[`f${i}`] = { type: 'boolean' };
    expect(validateSchema({ type: 'object', fields: tooMany }).valid).toBe(false);
  });

  it('rejects an object field name that is not a bounded ASCII identifier', () => {
    expect(validateSchema({ type: 'object', fields: { 'bad name': { type: 'boolean' } } }).valid).toBe(false);
    expect(validateSchema({ type: 'object', fields: { '1bad': { type: 'boolean' } } }).valid).toBe(false);
  });

  it('accepts a tuple schema and rejects an empty or oversized one', () => {
    expect(validateSchema({ type: 'tuple', items: [{ type: 'boolean' }, { type: 'boolean' }] }).valid).toBe(true);
    expect(validateSchema({ type: 'tuple', items: [] }).valid).toBe(false);
    const tooMany = Array.from({ length: MAX_TUPLE_ITEMS + 1 }, () => ({ type: 'boolean' }));
    expect(validateSchema({ type: 'tuple', items: tooMany }).valid).toBe(false);
  });

  it('accepts a fixed-length array schema and rejects an out-of-range length', () => {
    expect(validateSchema({ type: 'array', items: { type: 'boolean' }, length: 3 }).valid).toBe(true);
    expect(validateSchema({ type: 'array', items: { type: 'boolean' }, length: 0 }).valid).toBe(true);
    expect(validateSchema({ type: 'array', items: { type: 'boolean' }, length: -1 }).valid).toBe(false);
    expect(validateSchema({ type: 'array', items: { type: 'boolean' }, length: MAX_ARRAY_LENGTH + 1 }).valid).toBe(
      false,
    );
  });

  it('accepts a tagged disjoint union schema and rejects an empty or oversized one', () => {
    expect(
      validateSchema({
        type: 'union',
        variants: { a: { type: 'boolean' }, b: { type: 'integer', minimum: 0, maximum: 1 } },
      }).valid,
    ).toBe(true);
    expect(validateSchema({ type: 'union', variants: {} }).valid).toBe(false);
    const tooMany: Record<string, unknown> = {};
    for (let i = 0; i < MAX_UNION_VARIANTS + 1; i++) tooMany[`v${i}`] = { type: 'boolean' };
    expect(validateSchema({ type: 'union', variants: tooMany }).valid).toBe(false);
  });

  it('rejects a union tag that is not a bounded ASCII identifier', () => {
    expect(validateSchema({ type: 'union', variants: { '1bad': { type: 'boolean' } } }).valid).toBe(false);
  });

  it('rejects an unknown schema node type', () => {
    expect(validateSchema({ type: 'string' }).valid).toBe(false);
    expect(validateSchema({}).valid).toBe(false);
    expect(validateSchema(null).valid).toBe(false);
    expect(validateSchema('not an object').valid).toBe(false);
    expect(validateSchema([1, 2]).valid).toBe(false);
  });

  it(`rejects a schema exceeding maximum depth of ${MAX_SCHEMA_DEPTH}`, () => {
    let deep: unknown = { type: 'boolean' };
    for (let i = 0; i <= MAX_SCHEMA_DEPTH; i++) {
      deep = { type: 'array', items: deep, length: 1 };
    }
    expect(validateSchema(deep).valid).toBe(false);
  });

  it('accepts a schema at exactly the maximum depth', () => {
    let atLimit: unknown = { type: 'boolean' };
    for (let i = 0; i < MAX_SCHEMA_DEPTH; i++) {
      atLimit = { type: 'array', items: atLimit, length: 1 };
    }
    expect(validateSchema(atLimit).valid).toBe(true);
  });

  it(`rejects a schema exceeding ${MAX_SCHEMA_NODES} total nodes`, () => {
    const fields = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [
        `f${i}`,
        { type: 'tuple', items: Array.from({ length: 4 }, () => ({ type: 'boolean' })) },
      ]),
    );
    const result = validateSchema({ type: 'object', fields });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toContain('maximum node count');
  });

  it(`rejects a const literal string exceeding ${MAX_LITERAL_STRING_BYTES} bytes`, () => {
    expect(validateSchema({ type: 'const', value: 'a'.repeat(MAX_LITERAL_STRING_BYTES) }).valid).toBe(true);
    expect(validateSchema({ type: 'const', value: 'a'.repeat(MAX_LITERAL_STRING_BYTES + 1) }).valid).toBe(false);
  });

  it(`rejects a schema serialization exceeding ${MAX_SCHEMA_BYTES} bytes`, () => {
    // An enum of many small distinct strings is a compact way to blow the
    // byte cap without hitting node/field/tuple-count bounds first.
    const values = Array.from({ length: 2000 }, (_, i) => `v${i}`);
    expect(validateSchema({ type: 'enum', values }).valid).toBe(false);
  });

  it('rejects a schema that is not JSON-serializable', () => {
    const cyclic: Record<string, unknown> = { type: 'boolean' };
    cyclic.self = cyclic;
    expect(validateSchema(cyclic).valid).toBe(false);
  });

  it('rejects undefined', () => {
    expect(validateSchema(undefined).valid).toBe(false);
  });
});

describe('schemaCardinality and queryBitsForSchema', () => {
  it('computes cardinality 1 for const (0 bits)', () => {
    const schema: SealedProbeSchemaNode = { type: 'const', value: 'ok' };
    expect(schemaCardinality(schema)).toBe(1n);
    expect(queryBitsForSchema(schema)).toBe(RESULT_STATUS_BIT_COST + 0 + TIMING_BUCKET_BITS);
  });

  it('computes cardinality 2 for boolean (1 bit)', () => {
    const schema: SealedProbeSchemaNode = { type: 'boolean' };
    expect(schemaCardinality(schema)).toBe(2n);
    expect(queryBitsForSchema(schema)).toBe(RESULT_STATUS_BIT_COST + 1 + TIMING_BUCKET_BITS);
  });

  it('computes cardinality equal to the enum length', () => {
    const schema: SealedProbeSchemaNode = { type: 'enum', values: ['a', 'b', 'c', 'd'] };
    expect(schemaCardinality(schema)).toBe(4n);
    expect(queryBitsForSchema(schema)).toBe(RESULT_STATUS_BIT_COST + 2 + TIMING_BUCKET_BITS);
  });

  it('computes cardinality as the inclusive integer range size', () => {
    const schema: SealedProbeSchemaNode = { type: 'integer', minimum: 0, maximum: 255 };
    expect(schemaCardinality(schema)).toBe(256n);
    expect(queryBitsForSchema(schema)).toBe(RESULT_STATUS_BIT_COST + 8 + TIMING_BUCKET_BITS);
  });

  it('multiplies cardinality across object fields', () => {
    const schema: SealedProbeSchemaNode = {
      type: 'object',
      fields: [
        { name: 'a', schema: { type: 'boolean' } },
        { name: 'b', schema: { type: 'integer', minimum: 0, maximum: 3 } },
      ],
    };
    // 2 * 4 = 8
    expect(schemaCardinality(schema)).toBe(8n);
  });

  it('multiplies cardinality across tuple items', () => {
    const schema: SealedProbeSchemaNode = {
      type: 'tuple',
      items: [{ type: 'boolean' }, { type: 'boolean' }, { type: 'boolean' }],
    };
    expect(schemaCardinality(schema)).toBe(8n);
  });

  it('raises item cardinality to the fixed array length', () => {
    const schema: SealedProbeSchemaNode = { type: 'array', items: { type: 'boolean' }, length: 10 };
    expect(schemaCardinality(schema)).toBe(1024n);
  });

  it('handles a zero-length array as cardinality 1', () => {
    const schema: SealedProbeSchemaNode = { type: 'array', items: { type: 'boolean' }, length: 0 };
    expect(schemaCardinality(schema)).toBe(1n);
  });

  it('sums cardinality across disjoint union variants', () => {
    const schema: SealedProbeSchemaNode = {
      type: 'union',
      variants: [
        { tag: 'a', schema: { type: 'boolean' } },
        { tag: 'b', schema: { type: 'integer', minimum: 0, maximum: 9 } },
      ],
    };
    // 2 + 10 = 12
    expect(schemaCardinality(schema)).toBe(12n);
  });

  it('never overflows even for a schema near the configured bounds', () => {
    // Cardinality far beyond Number.MAX_SAFE_INTEGER — must stay exact as a BigInt.
    const schema: SealedProbeSchemaNode = { type: 'array', items: { type: 'integer', minimum: 0, maximum: 65535 }, length: 8 };
    const expected = 65536n ** 8n;
    expect(schemaCardinality(schema)).toBe(expected);
    expect(queryBitsForSchema(schema)).toBe(
      RESULT_STATUS_BIT_COST + ceilLog2BigInt(expected) + TIMING_BUCKET_BITS,
    );
  });

  it('charges exactly 4 bits for the cheapest possible schema (const)', () => {
    // 1 (status) + 0 (const) + 3 (timing) = 4 — the floor for every invocation.
    expect(queryBitsForSchema({ type: 'const', value: 1 })).toBe(4);
  });
});

describe('validateValueAgainstSchema', () => {
  it('validates const by exact value equality', () => {
    expect(validateValueAgainstSchema({ type: 'const', value: 'ok' }, 'ok')).toBe(true);
    expect(validateValueAgainstSchema({ type: 'const', value: 'ok' }, 'not-ok')).toBe(false);
    expect(validateValueAgainstSchema({ type: 'const', value: null }, null)).toBe(true);
    expect(validateValueAgainstSchema({ type: 'const', value: 1 }, 1)).toBe(true);
    expect(validateValueAgainstSchema({ type: 'const', value: 1 }, '1')).toBe(false);
  });

  it('validates boolean by strict type', () => {
    const schema: SealedProbeSchemaNode = { type: 'boolean' };
    expect(validateValueAgainstSchema(schema, true)).toBe(true);
    expect(validateValueAgainstSchema(schema, false)).toBe(true);
    expect(validateValueAgainstSchema(schema, 1)).toBe(false);
    expect(validateValueAgainstSchema(schema, 'true')).toBe(false);
  });

  it('validates enum membership only, rejecting unknown members', () => {
    const schema: SealedProbeSchemaNode = { type: 'enum', values: ['a', 'b'] };
    expect(validateValueAgainstSchema(schema, 'a')).toBe(true);
    expect(validateValueAgainstSchema(schema, 'c')).toBe(false);
  });

  it('validates integer range and rejects non-integers', () => {
    const schema: SealedProbeSchemaNode = { type: 'integer', minimum: 0, maximum: 10 };
    expect(validateValueAgainstSchema(schema, 5)).toBe(true);
    expect(validateValueAgainstSchema(schema, 0)).toBe(true);
    expect(validateValueAgainstSchema(schema, 10)).toBe(true);
    expect(validateValueAgainstSchema(schema, 11)).toBe(false);
    expect(validateValueAgainstSchema(schema, -1)).toBe(false);
    expect(validateValueAgainstSchema(schema, 5.5)).toBe(false);
  });

  it('validates fixed object shape: no missing, no extra fields', () => {
    const schema: SealedProbeSchemaNode = {
      type: 'object',
      fields: [{ name: 'ok', schema: { type: 'boolean' } }],
    };
    expect(validateValueAgainstSchema(schema, { ok: true })).toBe(true);
    expect(validateValueAgainstSchema(schema, {})).toBe(false);
    expect(validateValueAgainstSchema(schema, { ok: true, extra: 1 })).toBe(false);
    expect(validateValueAgainstSchema(schema, { ok: 'not-a-bool' })).toBe(false);
    expect(validateValueAgainstSchema(schema, null)).toBe(false);
    expect(validateValueAgainstSchema(schema, [true])).toBe(false);
  });

  it('validates fixed-length tuples exactly', () => {
    const schema: SealedProbeSchemaNode = { type: 'tuple', items: [{ type: 'boolean' }, { type: 'boolean' }] };
    expect(validateValueAgainstSchema(schema, [true, false])).toBe(true);
    expect(validateValueAgainstSchema(schema, [true])).toBe(false);
    expect(validateValueAgainstSchema(schema, [true, false, true])).toBe(false);
  });

  it('validates fixed-length arrays exactly', () => {
    const schema: SealedProbeSchemaNode = { type: 'array', items: { type: 'boolean' }, length: 2 };
    expect(validateValueAgainstSchema(schema, [true, false])).toBe(true);
    expect(validateValueAgainstSchema(schema, [true])).toBe(false);
    expect(validateValueAgainstSchema(schema, [true, false, true])).toBe(false);
  });

  it('validates a tagged union: exact tag/value shape, no untagged escape', () => {
    const schema: SealedProbeSchemaNode = {
      type: 'union',
      variants: [
        { tag: 'a', schema: { type: 'boolean' } },
        { tag: 'b', schema: { type: 'integer', minimum: 0, maximum: 9 } },
      ],
    };
    expect(validateValueAgainstSchema(schema, { tag: 'a', value: true })).toBe(true);
    expect(validateValueAgainstSchema(schema, { tag: 'b', value: 5 })).toBe(true);
    expect(validateValueAgainstSchema(schema, { tag: 'b', value: true })).toBe(false);
    expect(validateValueAgainstSchema(schema, { tag: 'c', value: true })).toBe(false);
    expect(validateValueAgainstSchema(schema, { tag: 'a', value: true, extra: 1 })).toBe(false);
    expect(validateValueAgainstSchema(schema, true)).toBe(false);
  });
});

describe('canonicalizeSchemaValue', () => {
  it('re-serializes const to its declared literal, ignoring the input value', () => {
    expect(canonicalizeSchemaValue({ type: 'const', value: 'ok' }, 'ok')).toBe('"ok"');
  });

  it('re-serializes boolean/enum/integer values directly', () => {
    expect(canonicalizeSchemaValue({ type: 'boolean' }, true)).toBe('true');
    expect(canonicalizeSchemaValue({ type: 'enum', values: ['a', 'b'] }, 'b')).toBe('"b"');
    expect(canonicalizeSchemaValue({ type: 'integer', minimum: 0, maximum: 10 }, 7)).toBe('7');
  });

  it('re-serializes an object in declared field order regardless of input key order', () => {
    const schema: SealedProbeSchemaNode = {
      type: 'object',
      fields: [
        { name: 'b', schema: { type: 'boolean' } },
        { name: 'a', schema: { type: 'boolean' } },
      ],
    };
    expect(canonicalizeSchemaValue(schema, { a: false, b: true })).toBe('{"b":true,"a":false}');
  });

  it('re-serializes tuples and arrays positionally', () => {
    const tuple: SealedProbeSchemaNode = { type: 'tuple', items: [{ type: 'boolean' }, { type: 'boolean' }] };
    expect(canonicalizeSchemaValue(tuple, [true, false])).toBe('[true,false]');

    const array: SealedProbeSchemaNode = { type: 'array', items: { type: 'boolean' }, length: 2 };
    expect(canonicalizeSchemaValue(array, [false, true])).toBe('[false,true]');
  });

  it('re-serializes a tagged union as {"tag":...,"value":...}', () => {
    const schema: SealedProbeSchemaNode = {
      type: 'union',
      variants: [{ tag: 'a', schema: { type: 'boolean' } }],
    };
    expect(canonicalizeSchemaValue(schema, { tag: 'a', value: true })).toBe('{"tag":"a","value":true}');
    expect(canonicalizeSchemaValue(schema, { tag: 'missing', value: true })).toBe('null');
  });
});

describe('strictParseJson', () => {
  it('parses valid JSON values', () => {
    expect(strictParseJson('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(strictParseJson('[1,2,3]')).toEqual({ value: [1, 2, 3] });
    expect(strictParseJson('true')).toEqual({ value: true });
    expect(strictParseJson('null')).toEqual({ value: null });
    expect(strictParseJson('  "spaced"  ')).toEqual({ value: 'spaced' });
  });

  it('rejects duplicate object keys instead of silently keeping the last', () => {
    expect(strictParseJson('{"a":1,"a":2}')).toBeUndefined();
  });

  it('rejects trailing data after the value', () => {
    expect(strictParseJson('{"a":1} extra')).toBeUndefined();
    expect(strictParseJson('{"a":1}{}')).toBeUndefined();
  });

  it('rejects malformed JSON', () => {
    expect(strictParseJson('not json')).toBeUndefined();
    expect(strictParseJson("{'a':1}")).toBeUndefined();
    expect(strictParseJson('{"a":1')).toBeUndefined();
    expect(strictParseJson('')).toBeUndefined();
  });

  it('rejects raw control characters embedded in a string', () => {
    expect(strictParseJson('{"a":"line\nbreak"}')).toBeUndefined();
  });

  it.each([
    ['{"a":"s\\"uccess"}', { a: 's"uccess' }],
    ['{"a":"s\\\\uccess"}', { a: 's\\uccess' }],
    ['{"a":"s\\/uccess"}', { a: 's/uccess' }],
    ['{"a":"\\b\\f\\n\\r\\t"}', { a: '\b\f\n\r\t' }],
    ['{"a":"\\u0073"}', { a: 's' }],
  ])('parses standard JSON escapes: %s', (raw, expected) => {
    expect(strictParseJson(raw)).toEqual({ value: expected });
  });

  it.each([
    ['0', 0],
    ['-1', -1],
    ['12.5', 12.5],
    ['1e3', 1000],
    ['1E+3', 1000],
    ['1e-3', 0.001],
    ['{}', {}],
    ['[]', []],
    ['false', false],
  ])('parses JSON number and empty-container form %s', (raw, expected) => {
    expect(strictParseJson(raw)).toEqual({ value: expected });
  });

  it.each(['01', '-', '1.', '1e', '1e+', '1e999', '{"a" 1}', '{"a":}', '[1', '[1,]', '{"a":1,}'])(
    'rejects malformed number or container syntax: %s',
    (raw) => {
      expect(strictParseJson(raw)).toBeUndefined();
    },
  );

  it('rejects JSON nesting beyond the parser depth bound', () => {
    expect(strictParseJson(`${'['.repeat(40)}0${']'.repeat(40)}`)).toBeUndefined();
  });

  it.each(['{"a":"\\x41"}', '{"a":"\\uZZZZ"}', '{"a":"trailing\\\\'])(
    'rejects invalid escapes: %s',
    (raw) => {
      expect(strictParseJson(raw)).toBeUndefined();
    },
  );
});

describe('validateSealedProbeRequest', () => {
  const validRequest = {
    privateRepo: 'octo/repo',
    schema: { type: 'boolean' },
    script: 'print("hello")',
  };

  it('accepts a well-formed request', () => {
    const result = validateSealedProbeRequest(validRequest);
    expect(result).toEqual({
      valid: true,
      request: { privateRepo: 'octo/repo', schema: { type: 'boolean' }, script: 'print("hello")' },
    });
  });

  it('rejects non-object requests', () => {
    expect(validateSealedProbeRequest(null).valid).toBe(false);
    expect(validateSealedProbeRequest('string').valid).toBe(false);
    expect(validateSealedProbeRequest([1, 2, 3]).valid).toBe(false);
  });

  it('rejects a privateRepo that looks like a URL', () => {
    const result = validateSealedProbeRequest({ ...validRequest, privateRepo: 'https://github.com/octo/repo' });
    expect(result.valid).toBe(false);
  });

  it(`rejects a privateRepo exceeding ${MAX_PRIVATE_REPO_LENGTH} characters`, () => {
    const long = `octo/${'r'.repeat(MAX_PRIVATE_REPO_LENGTH)}`;
    const result = validateSealedProbeRequest({ ...validRequest, privateRepo: long });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing privateRepo', () => {
    const rest: Record<string, unknown> = { ...validRequest };
    delete rest.privateRepo;
    expect(validateSealedProbeRequest(rest).valid).toBe(false);
  });

  it('rejects an invalid schema', () => {
    const result = validateSealedProbeRequest({ ...validRequest, schema: { type: 'nope' } });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.startsWith('schema:'))).toBe(true);
    }
  });

  it('rejects an empty script', () => {
    expect(validateSealedProbeRequest({ ...validRequest, script: '' }).valid).toBe(false);
  });

  it('rejects a script exceeding the size cap', () => {
    const result = validateSealedProbeRequest({ ...validRequest, script: 'x'.repeat(MAX_SCRIPT_BYTES + 1) });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('script must be at most'))).toBe(true);
    }
  });

  it('accepts a script at exactly the size cap', () => {
    expect(validateSealedProbeRequest({ ...validRequest, script: 'x'.repeat(MAX_SCRIPT_BYTES) }).valid).toBe(true);
  });

  it('accepts an escape-heavy script at the raw script cap', () => {
    expect(
      validateSealedProbeRequest({ ...validRequest, script: '\n'.repeat(MAX_SCRIPT_BYTES) }).valid,
    ).toBe(true);
  });

  it('rejects unsupported request fields before launch', () => {
    const result = validateSealedProbeRequest({ ...validRequest, runtime: 'docker' });
    expect(result).toEqual({
      valid: false,
      errors: expect.arrayContaining(['request.runtime is not supported']),
    });
  });

  it('rejects a cyclic request through its unsupported field', () => {
    const cyclic: Record<string, unknown> = { ...validRequest };
    cyclic.self = cyclic;
    const result = validateSealedProbeRequest(cyclic);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(expect.arrayContaining(['request.self is not supported']));
    }
  });

  it('aggregates errors across multiple invalid fields', () => {
    const result = validateSealedProbeRequest({ privateRepo: '', schema: { type: 'nope' }, script: '' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(1);
    }
  });
});

describe('canonical envelopes', () => {
  it('exposes the exact canonical error JSON', () => {
    expect(CANONICAL_ERROR_JSON).toBe('{"status":"error"}');
  });

  it('wraps an already-canonicalized result value into the ok envelope', () => {
    expect(canonicalOkJson('true')).toBe('{"status":"ok","result":true}');
    expect(canonicalOkJson('"ok"')).toBe('{"status":"ok","result":"ok"}');
  });
});

describe('parseAndValidateProbeOutput', () => {
  const schema: SealedProbeSchemaNode = { type: 'enum', values: ['success', 'timeout', 'blocked'] };

  it('accepts and canonicalizes a valid result', () => {
    expect(parseAndValidateProbeOutput('{"result":"success"}', { type: 'object', fields: [{ name: 'result', schema }] }))
      .toEqual({ ok: true, canonical: '{"result":"success"}' });
  });

  it('accepts a bare schema value directly (no envelope object required by the schema itself)', () => {
    expect(parseAndValidateProbeOutput('"success"', schema)).toEqual({ ok: true, canonical: '"success"' });
  });

  it('rejects malformed JSON', () => {
    expect(parseAndValidateProbeOutput('not json', schema)).toEqual({ ok: false });
  });

  it('rejects a value outside the enum', () => {
    expect(parseAndValidateProbeOutput('"not-a-declared-outcome"', schema)).toEqual({ ok: false });
  });

  it(`rejects output exceeding ${MAX_RESULT_BYTES} bytes`, () => {
    const oversized = `"${'x'.repeat(MAX_RESULT_BYTES)}"`;
    expect(parseAndValidateProbeOutput(oversized, { type: 'enum', values: [oversized.slice(1, -1)] })).toEqual({
      ok: false,
    });
  });

  it('rejects duplicate-key JSON', () => {
    expect(
      parseAndValidateProbeOutput('{"a":1,"a":2}', { type: 'object', fields: [{ name: 'a', schema: { type: 'boolean' } }] }),
    ).toEqual({ ok: false });
  });

  it('rejects an empty string', () => {
    expect(parseAndValidateProbeOutput('', schema)).toEqual({ ok: false });
  });

  it('normalizes canonical output regardless of source whitespace/key order', () => {
    const objSchema: SealedProbeSchemaNode = {
      type: 'object',
      fields: [
        { name: 'a', schema: { type: 'boolean' } },
        { name: 'b', schema: { type: 'boolean' } },
      ],
    };
    expect(parseAndValidateProbeOutput('{ "b" : true , "a" : false }', objSchema)).toEqual({
      ok: true,
      canonical: '{"a":false,"b":true}',
    });
  });
});
