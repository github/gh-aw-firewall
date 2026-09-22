import {
  informationChargeForSchema,
  schemaCardinality,
} from './finite-cardinality';
import { informationChargeForSchema as facadeInformationChargeForSchema } from './finite-disclosure';
import {
  canonicalizeSchemaValue,
  validateSchema,
  validateValueAgainstSchema,
} from './finite-schema';
import { strictParseJson } from './strict-json-parser';

describe('finite disclosure focused modules', () => {
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
});
