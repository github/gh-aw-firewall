import {
  ceilLog2,
  ceilLog2BigInt,
  informationChargeForSchema,
  schemaCardinality,
} from './finite-cardinality';
import * as hostCardinality from './finite-cardinality';
import * as hostDisclosure from './finite-disclosure';
import { informationChargeForSchema as facadeInformationChargeForSchema } from './finite-disclosure';
import * as hostSchema from './finite-schema';
import {
  canonicalizeSchemaValue,
  serializeFiniteSchema,
  validateSchema,
  validateValueAgainstSchema,
} from './finite-schema';
import { strictParseJson, utf8ByteLength } from './strict-json-parser';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDisclosure = require('../../containers/bounded-execution/finite-disclosure') as typeof hostDisclosure;
const brokerSchema = require('../../containers/bounded-execution/schema-validation') as typeof hostSchema;
const brokerCardinality = require('../../containers/bounded-execution/cardinality') as typeof hostCardinality;
const brokerJson = require('../../containers/bounded-execution/strict-json') as {
  strictParseJson: typeof strictParseJson;
  utf8ByteLength: typeof utf8ByteLength;
};
const brokerTiming = require('../../containers/bounded-execution/timing') as Pick<typeof hostDisclosure,
  'TIMING_BUCKETS_MS' | 'TIMING_BUCKET_BITS' | 'FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS' | 'MAX_ENCLAVE_TIMEOUT_SECONDS'
>;
const brokerEntrypoint = require('../../containers/bounded-execution') as typeof hostDisclosure;
/* eslint-enable @typescript-eslint/no-require-imports */

describe('finite disclosure focused modules', () => {
  it('preserves the facade exports without leaking module-only helpers', () => {
    expect(Object.keys(brokerDisclosure).sort()).toEqual(Object.keys(hostDisclosure).sort());
    expect(Object.keys(brokerSchema).sort()).toEqual(Object.keys(hostSchema).sort());
    expect(Object.keys(brokerCardinality).sort()).toEqual(Object.keys(hostCardinality).sort());
    for (const [name, value] of Object.entries(brokerDisclosure)) {
      expect(brokerEntrypoint[name as keyof typeof hostDisclosure]).toBe(value);
      if (typeof value !== 'function') {
        expect(value).toEqual(hostDisclosure[name as keyof typeof hostDisclosure]);
      }
    }
    for (const [name, value] of Object.entries(brokerSchema)) {
      expect(brokerDisclosure[name as keyof typeof hostSchema]).toBe(value);
    }
    expect(brokerDisclosure.ceilLog2BigInt).toBe(brokerCardinality.ceilLog2BigInt);
    expect(brokerDisclosure.schemaCardinality).toBe(brokerCardinality.schemaCardinality);
    expect(brokerDisclosure.strictParseJson).toBe(brokerJson.strictParseJson);
    for (const [name, value] of Object.entries(brokerTiming)) {
      expect(brokerDisclosure[name as keyof typeof brokerTiming]).toBe(value);
      expect(value).toEqual(hostDisclosure[name as keyof typeof brokerTiming]);
    }
  });

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
    expect(brokerCardinality.schemaCardinality(validation.schema)).toBe(6n);
    expect(informationChargeForSchema(validation.schema, 1, 4)).toBe(8);
    expect(brokerCardinality.informationChargeForSchema(validation.schema, 1, 4)).toBe(8);
    expect(brokerCardinality.informationChargeForSchema(validation.schema, 0, 0)).toBe(3);
    expect(facadeInformationChargeForSchema(validation.schema)).toBe(8);
    expect(brokerDisclosure.informationChargeForSchema(validation.schema)).toBe(8);
    expect(validateValueAgainstSchema(validation.schema, { approved: true, priority: 2 })).toBe(true);
    expect(brokerSchema.validateValueAgainstSchema(validation.schema, { approved: true, priority: 2 })).toBe(true);
    expect(canonicalizeSchemaValue(validation.schema, { approved: true, priority: 2 })).toBe(
      '{"approved":true,"priority":2}',
    );
    expect(brokerSchema.canonicalizeSchemaValue(validation.schema, { priority: 2, approved: true })).toBe(
      '{"approved":true,"priority":2}',
    );
  });

  it.each([
    '{"value":[true,null,1]}',
    ' \t\r\n{"escaped":"\\u0061\\n","number":-1.25e2}',
    '{"value":1,"value":2}',
    '{"value":1,"\\u0076alue":2}',
    '01',
    '1e999',
    '[true,]',
    'true false',
    '\u00a0null',
    `${'['.repeat(32)}0${']'.repeat(32)}`,
    `${'['.repeat(33)}0${']'.repeat(33)}`,
  ])('keeps strict parsing in parity without schema semantics: %s', (raw) => {
    expect(brokerJson.strictParseJson(raw)).toEqual(strictParseJson(raw));
  });

  it('keeps byte-length and exact logarithm helpers independently usable', () => {
    expect(brokerJson.utf8ByteLength('é🙂')).toBe(utf8ByteLength('é🙂'));
    expect(brokerCardinality.ceilLog2(1025)).toBe(ceilLog2(1025));
    expect(brokerCardinality.ceilLog2BigInt((1n << 200n) + 1n)).toBe(ceilLog2BigInt((1n << 200n) + 1n));
  });

  it('preserves bounded charges for deeply nested arrays', () => {
    const validation = validateSchema({
      type: 'array', length: 64, items: { type: 'array', length: 64, items: { type: 'boolean' } },
    });
    if (!validation.valid) throw new Error('Invalid schema fixture');
    expect(brokerCardinality.informationChargeForSchema(validation.schema, 0, 0)).toBe(1025);
    expect(brokerDisclosure.informationChargeForSchema(validation.schema)).toBe(
      facadeInformationChargeForSchema(validation.schema),
    );
    expect(() => brokerCardinality.schemaCardinality({ type: 'string' })).toThrow('free-form string');
    expect(() => brokerDisclosure.informationChargeForSchema({ type: 'string' })).toThrow('free-form string');
  });

  it('keeps request validation and result envelopes wired through the facade', () => {
    const request = {
      privateRepo: 'owner/repo',
      schema: { type: 'object', fields: { approved: { type: 'boolean' }, priority: { type: 'integer', minimum: 1, maximum: 3 } } },
      script: 'print("{}")',
    };
    for (const raw of [
      request,
      { ...request, privateRepo: 'owner/../repo', extra: true },
      { ...request, script: 'é'.repeat(hostDisclosure.MAX_SCRIPT_BYTES / 2) },
      { ...request, script: `${'é'.repeat(hostDisclosure.MAX_SCRIPT_BYTES / 2)}a` },
      { ...request, schema: { type: 'enum', values: [true, true] } },
    ]) {
      expect(brokerDisclosure.validateEnclaveScriptRequest(raw)).toEqual(hostDisclosure.validateEnclaveScriptRequest(raw));
    }
    const validation = brokerDisclosure.validateEnclaveScriptRequest(request);
    if (!validation.valid) throw new Error('Invalid request fixture');
    for (const raw of [
      '{"priority":2,"approved":true}',
      '{"priority":2,"approved":true,"approved":false}',
      '{"priority":4,"approved":true}',
      `${' '.repeat(hostDisclosure.MAX_RESULT_BYTES)}{"approved":true,"priority":2}`,
    ]) {
      expect(brokerDisclosure.parseAndValidateFiniteOutput(raw, validation.request.schema)).toEqual(
        hostDisclosure.parseAndValidateFiniteOutput(raw, validation.request.schema),
      );
    }
    expect(brokerDisclosure.parseAndValidateFiniteOutput('{"priority":2,"approved":true}', validation.request.schema))
      .toEqual({ ok: true, canonical: '{"approved":true,"priority":2}' });
    expect(brokerDisclosure.canonicalSuccessJson('true')).toBe(hostDisclosure.canonicalSuccessJson('true'));
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
