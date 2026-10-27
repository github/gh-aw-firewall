import {
  ceilLog2,
  ceilLog2BigInt,
  schemaCardinality,
  informationChargeForSchema,
} from './finite-cardinality';
import type { FiniteSchemaNode } from './finite-schema';

const bool: FiniteSchemaNode = { type: 'boolean' };
const str: FiniteSchemaNode = { type: 'string' };
const int = (minimum: number, maximum: number): FiniteSchemaNode => ({ type: 'integer', minimum, maximum });

describe('ceilLog2', () => {
  it.each([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [1024, 10],
    [1025, 11],
  ])('ceilLog2(%d) = %d', (n, expected) => {
    expect(ceilLog2(n)).toBe(expected);
  });

  it('returns 0 for zero and one BigInt values', () => {
    expect(ceilLog2BigInt(0n)).toBe(0);
    expect(ceilLog2BigInt(1n)).toBe(0);
  });

  it('handles very large BigInts exactly', () => {
    expect(ceilLog2BigInt(1n << 200n)).toBe(200);
    expect(ceilLog2BigInt((1n << 200n) + 1n)).toBe(201);
  });
});

describe('schemaCardinality', () => {
  it('computes leaf cardinalities', () => {
    expect(schemaCardinality({ type: 'const', value: 'x' })).toBe(1n);
    expect(schemaCardinality(bool)).toBe(2n);
    expect(schemaCardinality({ type: 'enum', values: ['a', 'b', null] })).toBe(3n);
    expect(schemaCardinality(int(-5, 4))).toBe(10n);
  });

  it('rejects free-form strings, including nested ones', () => {
    expect(() => schemaCardinality(str)).toThrow('free-form string');
    expect(() => schemaCardinality({ type: 'object', fields: [{ name: 'a', schema: str }] })).toThrow(
      'free-form string',
    );
  });

  it('multiplies object fields and tuple items', () => {
    expect(
      schemaCardinality({
        type: 'object',
        fields: [{ name: 'a', schema: bool }, { name: 'b', schema: int(0, 2) }],
      }),
    ).toBe(6n);
    expect(schemaCardinality({ type: 'object', fields: [] })).toBe(1n);
    expect(schemaCardinality({ type: 'tuple', items: [bool, bool, int(1, 4)] })).toBe(16n);
  });

  it('raises array item cardinality to its length', () => {
    expect(schemaCardinality({ type: 'array', items: bool, length: 10 })).toBe(1024n);
    expect(schemaCardinality({ type: 'array', items: bool, length: 0 })).toBe(1n);
  });

  it('sums union variants', () => {
    expect(
      schemaCardinality({
        type: 'union',
        variants: [{ tag: 'a', schema: bool }, { tag: 'b', schema: int(0, 9) }],
      }),
    ).toBe(12n);
  });
});

describe('informationChargeForSchema', () => {
  it('adds status, log2 cardinality, and timing bits', () => {
    expect(informationChargeForSchema(bool, 1, 3)).toBe(1 + 1 + 3);
    expect(informationChargeForSchema({ type: 'const', value: 1 }, 2, 2)).toBe(4);
    expect(informationChargeForSchema(int(0, 9), 0, 0)).toBe(4);
  });

  it('matches exact cardinality for ordinary composite schemas', () => {
    const schema: FiniteSchemaNode = {
      type: 'object',
      fields: [
        { name: 'flags', schema: { type: 'array', items: bool, length: 8 } },
        { name: 'pick', schema: { type: 'tuple', items: [int(0, 2), bool] } },
        {
          name: 'u',
          schema: { type: 'union', variants: [{ tag: 'x', schema: bool }, { tag: 'y', schema: bool }] },
        },
      ],
    };
    expect(informationChargeForSchema(schema, 1, 1)).toBe(2 + ceilLog2BigInt(schemaCardinality(schema)));
  });

  it('rejects free-form strings', () => {
    expect(() => informationChargeForSchema(str, 1, 1)).toThrow('free-form string');
  });

  it('caps huge array cardinalities at a stable unaffordable charge', () => {
    const huge: FiniteSchemaNode = { type: 'array', items: int(0, 1_000_000), length: 1_000_000 };
    const charge = informationChargeForSchema(huge, 1, 1);
    expect(charge).toBe(2 + 1025);
  });

  it('caps nested arrays without materializing enormous BigInts', () => {
    const inner: FiniteSchemaNode = { type: 'array', items: bool, length: 1000 };
    const outer: FiniteSchemaNode = { type: 'array', items: inner, length: 1_000_000_000 };
    expect(informationChargeForSchema(outer, 0, 0)).toBe(1025);
  });

  it('caps oversized object and tuple products', () => {
    const big: FiniteSchemaNode = { type: 'array', items: int(0, 1_000_000), length: 50 };
    expect(informationChargeForSchema({ type: 'object', fields: [{ name: 'a', schema: big }, { name: 'b', schema: big }] }, 0, 0))
      .toBe(1025);
    expect(informationChargeForSchema({ type: 'tuple', items: [big, big, big, big, big, big] }, 0, 0))
      .toBe(1025);
  });

  it('caps oversized union totals and zero-length arrays stay exact', () => {
    const big: FiniteSchemaNode = { type: 'array', items: int(0, 1_000_000), length: 1_000_000 };
    expect(
      informationChargeForSchema(
        { type: 'union', variants: [{ tag: 'a', schema: big }, { tag: 'b', schema: big }] },
        0,
        0,
      ),
    ).toBe(1025);
    expect(informationChargeForSchema({ type: 'array', items: bool, length: 0 }, 0, 0)).toBe(0);
  });

  it('treats a single-value integer range as zero bits', () => {
    expect(informationChargeForSchema(int(7, 7), 0, 0)).toBe(0);
  });
});
