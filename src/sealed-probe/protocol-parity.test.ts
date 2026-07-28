import * as path from 'path';
import {
  buildSealedProbeResultSchema,
  canonicalizeSealedProbeResult,
  parseSealedProbeResult,
  validateSealedProbeRequest,
  MAX_OUTCOME_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES,
  MAX_SCRIPT_BYTES,
  OUTCOME_COUNT,
  RESERVED_ERROR_OUTCOME,
  SEALED_PROBE_REPO_PATTERN,
  type SealedProbeOutcomes,
} from './protocol';

/**
 * The broker runs in its own container image and cannot import AWF's
 * TypeScript sources, so `containers/sealed-probe/broker/protocol.js` restates
 * the protocol. This suite runs one shared vector table through *both*
 * implementations and fails the moment they disagree, which is what makes the
 * duplication safe.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const brokerProtocol = require(
  path.join(__dirname, '..', '..', 'containers', 'sealed-probe', 'broker', 'protocol.js'),
);

const OUTCOMES: SealedProbeOutcomes = ['YES', 'NO', 'UNKNOWN'];

const REQUEST_VECTORS: Array<{ name: string; request: unknown }> = [
  { name: 'valid request', request: { privateRepo: 'octo/private', outcomes: [...OUTCOMES], script: 'print(1)' } },
  { name: 'not an object', request: 'nope' },
  { name: 'null', request: null },
  { name: 'array', request: [] },
  { name: 'extra control field', request: { privateRepo: 'octo/private', outcomes: [...OUTCOMES], script: 'x', image: 'evil' } },
  { name: 'timeout control field', request: { privateRepo: 'octo/private', outcomes: [...OUTCOMES], script: 'x', timeout: 9999 } },
  { name: 'schema control field', request: { privateRepo: 'octo/private', outcomes: [...OUTCOMES], script: 'x', schema: {} } },
  { name: 'missing repo', request: { outcomes: [...OUTCOMES], script: 'x' } },
  { name: 'url repo', request: { privateRepo: 'https://github.com/octo/private', outcomes: [...OUTCOMES], script: 'x' } },
  { name: 'traversal repo', request: { privateRepo: 'octo/../../etc', outcomes: [...OUTCOMES], script: 'x' } },
  { name: 'wildcard repo', request: { privateRepo: 'octo/*', outcomes: [...OUTCOMES], script: 'x' } },
  { name: 'query repo', request: { privateRepo: 'octo/private?x=1', outcomes: [...OUTCOMES], script: 'x' } },
  { name: 'two outcomes', request: { privateRepo: 'octo/private', outcomes: ['A', 'B'], script: 'x' } },
  { name: 'four outcomes', request: { privateRepo: 'octo/private', outcomes: ['A', 'B', 'C', 'D'], script: 'x' } },
  { name: 'duplicate outcomes', request: { privateRepo: 'octo/private', outcomes: ['A', 'A', 'B'], script: 'x' } },
  { name: 'reserved outcome', request: { privateRepo: 'octo/private', outcomes: ['A', 'B', 'ERROR'], script: 'x' } },
  { name: 'empty outcome', request: { privateRepo: 'octo/private', outcomes: ['A', 'B', ''], script: 'x' } },
  { name: 'control character outcome', request: { privateRepo: 'octo/private', outcomes: ['A', 'B', 'C\n'], script: 'x' } },
  { name: 'oversized outcome', request: { privateRepo: 'octo/private', outcomes: ['A', 'B', 'x'.repeat(MAX_OUTCOME_BYTES + 1)], script: 'x' } },
  { name: 'non-string outcome', request: { privateRepo: 'octo/private', outcomes: ['A', 'B', 3], script: 'x' } },
  { name: 'outcomes not an array', request: { privateRepo: 'octo/private', outcomes: 'A,B,C', script: 'x' } },
  { name: 'empty script', request: { privateRepo: 'octo/private', outcomes: [...OUTCOMES], script: '' } },
  { name: 'non-string script', request: { privateRepo: 'octo/private', outcomes: [...OUTCOMES], script: 42 } },
  { name: 'oversized script', request: { privateRepo: 'octo/private', outcomes: [...OUTCOMES], script: 'x'.repeat(MAX_SCRIPT_BYTES + 1) } },
];

const RESULT_VECTORS: string[] = [
  '{"result":"YES"}',
  '{"result": "NO"}',
  '  {"result":"UNKNOWN"}  ',
  '{"result":"ERROR"}',
  '{"result":"MAYBE"}',
  '{"result":"yes"}',
  '{"result":"YES"} trailing',
  '{"result":"YES"}{"result":"NO"}',
  '{"result":"YES","extra":1}',
  '{"result":"YES","result":"NO"}',
  '{"answer":"YES"}',
  '{"result":1}',
  '{"result":null}',
  '{"result":["YES"]}',
  '["YES"]',
  '',
  'YES',
  '{',
  '{"result":"YE\\u0053"}',
  '{"result":"YES\\n"}',
  '{"result":"Y\u0000ES"}',
  `{"result":"${'x'.repeat(MAX_RESULT_BYTES)}"}`,
];

describe('sealed-probe protocol parity (TypeScript vs broker JavaScript)', () => {
  it('exposes identical protocol constants', () => {
    expect(brokerProtocol.OUTCOME_COUNT).toBe(OUTCOME_COUNT);
    expect(brokerProtocol.RESERVED_ERROR_OUTCOME).toBe(RESERVED_ERROR_OUTCOME);
    expect(brokerProtocol.MAX_OUTCOME_BYTES).toBe(MAX_OUTCOME_BYTES);
    expect(brokerProtocol.MAX_SCRIPT_BYTES).toBe(MAX_SCRIPT_BYTES);
    expect(brokerProtocol.MAX_REQUEST_BYTES).toBe(MAX_REQUEST_BYTES);
    expect(brokerProtocol.MAX_RESULT_BYTES).toBe(MAX_RESULT_BYTES);
    expect(brokerProtocol.SEALED_PROBE_REPO_PATTERN.source).toBe(SEALED_PROBE_REPO_PATTERN.source);
  });

  it.each(REQUEST_VECTORS)('agrees on request validity: $name', ({ request }) => {
    const ts = validateSealedProbeRequest(request);
    const js = brokerProtocol.validateSealedProbeRequest(request);

    expect(js.valid).toBe(ts.valid);
    expect(js.errors ?? []).toEqual(ts.valid ? [] : ts.errors);
  });

  it.each(RESULT_VECTORS.map((raw, index) => ({ index, raw })))(
    'agrees on result parsing for vector $index',
    ({ raw }) => {
      expect(brokerProtocol.parseSealedProbeResult(raw, [...OUTCOMES])).toEqual(
        parseSealedProbeResult(raw, OUTCOMES),
      );
    },
  );

  it('agrees on canonical serialization', () => {
    for (const outcome of [...OUTCOMES, RESERVED_ERROR_OUTCOME]) {
      expect(brokerProtocol.canonicalizeSealedProbeResult(outcome)).toBe(
        canonicalizeSealedProbeResult(outcome),
      );
    }
    expect(brokerProtocol.CANONICAL_ERROR_RESULT_JSON).toBe('{"result":"ERROR"}');
  });

  it('agrees on the closed result schema', () => {
    expect(brokerProtocol.buildSealedProbeResultSchema([...OUTCOMES])).toEqual(
      buildSealedProbeResultSchema(OUTCOMES),
    );
  });
});
