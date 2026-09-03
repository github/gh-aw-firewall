import * as path from 'path';
import {
  canonicalizeSchemaValue,
  parseAndValidateFiniteOutput,
  schemaCardinality,
  schemaContainsFreeformString,
  validateSchema,
  validateValueAgainstSchema,
} from './finite-disclosure';

/* eslint-disable @typescript-eslint/no-require-imports */
const containerProtocol = require(
  path.join(__dirname, '..', '..', 'containers', 'bounded-execution', 'finite-disclosure.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

const structuredStringSchema = {
  type: 'object',
  fields: {
    action: { type: 'enum', values: ['dispatch', 'ignore'] },
    rationale: { type: 'string' },
  },
};

describe.each([
  ['host', {
    canonicalizeSchemaValue,
    parseAndValidateFiniteOutput,
    schemaCardinality,
    schemaContainsFreeformString,
    validateSchema,
    validateValueAgainstSchema,
  }],
  ['container', containerProtocol],
])('trusted string schema parity: %s', (_name, protocol) => {
  it('parses, detects, validates, and canonicalizes a structured free-form string', () => {
    const validation = protocol.validateSchema(structuredStringSchema);
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;

    const value = { rationale: 'Issue body can be summarized freely.', action: 'dispatch' };
    expect(protocol.schemaContainsFreeformString(validation.schema)).toBe(true);
    expect(protocol.validateValueAgainstSchema(validation.schema, value)).toBe(true);
    expect(protocol.canonicalizeSchemaValue(validation.schema, value)).toBe(
      '{"action":"dispatch","rationale":"Issue body can be summarized freely."}',
    );
    expect(protocol.parseAndValidateFiniteOutput(JSON.stringify(value), validation.schema)).toEqual({
      ok: true,
      canonical: '{"action":"dispatch","rationale":"Issue body can be summarized freely."}',
    });
  });

  it('keeps string schemas exact and outside finite-cardinality accounting', () => {
    expect(protocol.validateSchema({ type: 'string', maxLength: 10 }).valid).toBe(false);
    const validation = protocol.validateSchema({ type: 'string' });
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;
    expect(() => protocol.schemaCardinality(validation.schema)).toThrow(
      'free-form string schemas do not have finite cardinality',
    );
  });
});
