import {
  informationChargeForSchema,
  schemaCardinality,
} from './finite-cardinality';
import { informationChargeForSchema as facadeInformationChargeForSchema } from './finite-disclosure';
import {
  canonicalizeSchemaValue,
  serializeFiniteSchema,
  validateSchema,
  validateValueAgainstSchema,
} from './finite-schema';
import { strictParseJson } from './strict-json-parser';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const brokerSchema = require('../../containers/bounded-execution/finite-disclosure');

describe('finite disclosure focused modules', () => {
  it.each([
    { type: 'object', fields: { package_json: { type: 'boolean' }, src: { type: 'boolean' } } },
    {
      type: 'union', variants: {
        yes: { type: 'tuple', items: [
          { type: 'array', length: 2, items: { type: 'object', fields: { present: { type: 'boolean' } } } },
          { type: 'const', value: null },
          { type: 'enum', values: ['a', 'b'] },
          { type: 'integer', minimum: 0, maximum: 1 },
        ] },
        no: { type: 'object', fields: { constructor: { type: 'string' } } },
      },
    },
  ])('round-trips parsed schemas to the wire grammar recursively: $type', (wire) => {
    const validation = validateSchema(wire);
    expect(validation.valid).toBe(true);
    if (!validation.valid) throw new Error('Invalid schema fixture');
    expect(brokerSchema.validateSchema(wire)).toEqual(validation);
    expect(serializeFiniteSchema(validation.schema)).toEqual(wire);
    expect(brokerSchema.serializeFiniteSchema(validation.schema)).toEqual(wire);
    expect(validateSchema(serializeFiniteSchema(validation.schema))).toEqual(validation);
    expect(validateSchema(validation.schema).valid).toBe(false);
  });

  it('keeps schema validation and cardinality calculation independently usable', () => {
    const validation = validateSchema({
      type: 'object',
      fields: {
        approved: { type: 'boolean' },
        priority: { type: 'integer', minimum: 1, maximum: 3 },
      },
    });

    expect(validation.valid).toBe(true);
    if (!validation.valid) return;

    expect(schemaCardinality(validation.schema)).toBe(6n);
    expect(informationChargeForSchema(validation.schema, 1, 4)).toBe(8);
    expect(facadeInformationChargeForSchema(validation.schema)).toBe(8);
    expect(validateValueAgainstSchema(validation.schema, { approved: true, priority: 2 })).toBe(true);
    expect(canonicalizeSchemaValue(validation.schema, { approved: true, priority: 2 })).toBe(
      '{"approved":true,"priority":2}',
    );
  });

  it('keeps strict parsing available without schema semantics', () => {
    expect(strictParseJson('{"value":[true,null,1]}')).toEqual({
      value: { value: [true, null, 1] },
    });
    expect(strictParseJson('{"value":1,"value":2}')).toBeUndefined();
  });

  it('applies the 4096-byte bound to wire grammar, not the larger parsed arrays', () => {
    const wire = { type: 'object', fields: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
      `${'f'.repeat(61)}${index}`, { type: 'enum', values: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(10)] },
    ])) };
    const parsed = validateSchema(wire);
    if (!parsed.valid) throw new Error('Invalid schema fixture');
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(JSON.stringify(parsed.schema))).toBeGreaterThan(4096);
    expect(serializeFiniteSchema(parsed.schema)).toEqual(wire);
    expect(brokerSchema.serializeFiniteSchema(parsed.schema)).toEqual(wire);
    expect(brokerSchema.validateSchema(brokerSchema.serializeFiniteSchema(parsed.schema))).toEqual(parsed);
  });
});
