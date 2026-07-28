import {
  OUTCOME_COUNT,
  RESERVED_ERROR_OUTCOME,
  MAX_OUTCOME_BYTES,
  MAX_SCRIPT_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES,
  OUTCOME_PATTERN,
  SEALED_PROBE_REPO_PATTERN,
  validateOutcome,
  validateOutcomes,
  validateSealedProbeRequest,
  buildSealedProbeResultSchema,
  canonicalizeSealedProbeResult,
  CANONICAL_ERROR_RESULT_JSON,
  parseSealedProbeResult,
  parseSealedProbeResultJson,
  type SealedProbeOutcomes,
} from './protocol';

const OUTCOMES: SealedProbeOutcomes = ['success', 'timeout', 'blocked'];

describe('SEALED_PROBE_REPO_PATTERN', () => {
  it.each([
    'octo/repo',
    'octo-org/octo-repo',
    'my-org/my.repo-name_2',
    'a/b',
  ])('accepts a valid owner/repo slug: %s', (slug) => {
    expect(SEALED_PROBE_REPO_PATTERN.test(slug)).toBe(true);
  });

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

describe('validateOutcome', () => {
  it('accepts a normal short label', () => {
    expect(validateOutcome('success')).toBeUndefined();
  });

  it('rejects non-strings', () => {
    expect(validateOutcome(42)).toMatch(/must be a string/);
    expect(validateOutcome(null)).toMatch(/must be a string/);
    expect(validateOutcome(undefined)).toMatch(/must be a string/);
  });

  it('rejects the empty string', () => {
    expect(validateOutcome('')).toMatch(/must not be empty/);
  });

  it('rejects the reserved ERROR sentinel', () => {
    expect(validateOutcome('ERROR')).toMatch(/reserved/);
  });

  it('rejects strings containing control characters', () => {
    expect(validateOutcome('bad\nvalue')).toMatch(/control characters/);
    expect(validateOutcome('bad\tvalue')).toMatch(/control characters/);
    expect(validateOutcome('bad\x00value')).toMatch(/control characters/);
  });

  it('accepts an identifier at exactly the byte cap', () => {
    const label = 'a'.repeat(MAX_OUTCOME_BYTES);
    expect(validateOutcome(label)).toBeUndefined();
  });

  it('rejects a label exceeding the UTF-8 byte cap', () => {
    const label = 'a'.repeat(MAX_OUTCOME_BYTES + 1);
    expect(validateOutcome(label)).toMatch(/64 UTF-8 bytes/);
  });

  it('rejects values that cannot be transported as safe enum identifiers', () => {
    expect(validateOutcome('has space')).toMatch(/ASCII identifier/);
    expect(validateOutcome('💥')).toMatch(/ASCII identifier/);
    expect(validateOutcome('1STARTS_WITH_DIGIT')).toMatch(/ASCII identifier/);
    expect(validateOutcome('HAS.DOT')).toMatch(/ASCII identifier/);
    expect(OUTCOME_PATTERN.test('YES_1')).toBe(true);
  });
});

describe('validateOutcomes', () => {
  it('accepts exactly three unique valid outcomes', () => {
    expect(validateOutcomes(['a', 'b', 'c'])).toEqual([]);
  });

  it('rejects a non-array', () => {
    expect(validateOutcomes('not-an-array').length).toBeGreaterThan(0);
  });

  it(`rejects fewer or more than ${OUTCOME_COUNT} entries`, () => {
    expect(validateOutcomes(['a', 'b']).length).toBeGreaterThan(0);
    expect(validateOutcomes(['a', 'b', 'c', 'd']).length).toBeGreaterThan(0);
  });

  it('rejects duplicate outcomes', () => {
    const errors = validateOutcomes(['a', 'a', 'b']);
    expect(errors).toContain('outcomes must be unique');
  });

  it('rejects a reserved ERROR outcome anywhere in the tuple', () => {
    const errors = validateOutcomes(['a', RESERVED_ERROR_OUTCOME, 'b']);
    expect(errors.some((e) => e.includes('reserved'))).toBe(true);
  });

  it('aggregates multiple per-item errors', () => {
    const errors = validateOutcomes(['', 'ok', 42]);
    expect(errors.some((e) => e.includes('outcomes[0]'))).toBe(true);
    expect(errors.some((e) => e.includes('outcomes[2]'))).toBe(true);
  });
});

describe('validateSealedProbeRequest', () => {
  const validRequest = {
    privateRepo: 'octo/repo',
    outcomes: OUTCOMES,
    script: 'print("hello")',
  };

  it('accepts a well-formed request', () => {
    expect(validateSealedProbeRequest(validRequest)).toEqual({ valid: true });
  });

  it('rejects non-object requests', () => {
    expect(validateSealedProbeRequest(null)).toEqual({ valid: false, errors: expect.any(Array) });
    expect(validateSealedProbeRequest('string')).toEqual({ valid: false, errors: expect.any(Array) });
    expect(validateSealedProbeRequest([1, 2, 3])).toEqual({ valid: false, errors: expect.any(Array) });
  });

  it('rejects a privateRepo that looks like a URL', () => {
    const result = validateSealedProbeRequest({ ...validRequest, privateRepo: 'https://github.com/octo/repo' });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing privateRepo', () => {
    const rest: Record<string, unknown> = { ...validRequest };
    delete rest.privateRepo;
    const result = validateSealedProbeRequest(rest);
    expect(result.valid).toBe(false);
  });

  it('rejects an empty script', () => {
    const result = validateSealedProbeRequest({ ...validRequest, script: '' });
    expect(result.valid).toBe(false);
  });

  it('rejects a script exceeding the size cap', () => {
    const result = validateSealedProbeRequest({ ...validRequest, script: 'x'.repeat(MAX_SCRIPT_BYTES + 1) });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('script must be at most'))).toBe(true);
    }
  });

  it('accepts a script at exactly the size cap', () => {
    const result = validateSealedProbeRequest({ ...validRequest, script: 'x'.repeat(MAX_SCRIPT_BYTES) });
    expect(result.valid).toBe(true);
  });

  it('rejects a request whose overall serialized size exceeds the request cap even though every declared field is within its own cap', () => {
    // Attach an oversized extra property so the whole-request size guard
    // (independent of the per-field script/outcome/privateRepo caps) triggers.
    const result = validateSealedProbeRequest({
      ...validRequest,
      extraPadding: 'x'.repeat(MAX_REQUEST_BYTES),
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('request must be at most'))).toBe(true);
    }
  });

  it('rejects unsupported request fields before launch', () => {
    const result = validateSealedProbeRequest({
      ...validRequest,
      runtime: 'docker',
    });
    expect(result).toEqual({
      valid: false,
      errors: expect.arrayContaining(['request.runtime is not supported']),
    });
  });

  it('rejects invalid outcomes on the request', () => {
    const result = validateSealedProbeRequest({ ...validRequest, outcomes: ['a', 'a', 'b'] });
    expect(result.valid).toBe(false);
  });

  it('aggregates errors across multiple invalid fields', () => {
    const result = validateSealedProbeRequest({ privateRepo: '', outcomes: ['a'], script: '' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(1);
    }
  });
});

describe('buildSealedProbeResultSchema', () => {
  it('builds the exact closed-schema representation', () => {
    expect(buildSealedProbeResultSchema(OUTCOMES)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['result'],
      properties: {
        result: {
          type: 'string',
          enum: ['success', 'timeout', 'blocked', 'ERROR'],
        },
      },
    });
  });

  it('includes the reserved ERROR sentinel as the fourth enum value', () => {
    const schema = buildSealedProbeResultSchema(OUTCOMES);
    expect(schema.properties.result.enum).toEqual([
      'success',
      'timeout',
      'blocked',
      RESERVED_ERROR_OUTCOME,
    ]);
  });
});

describe('canonicalizeSealedProbeResult', () => {
  it('produces the exact canonical JSON shape', () => {
    expect(canonicalizeSealedProbeResult('success')).toBe('{"result":"success"}');
  });

  it('exposes a precomputed canonical error result constant', () => {
    expect(CANONICAL_ERROR_RESULT_JSON).toBe('{"result":"ERROR"}');
  });
});

describe('parseSealedProbeResult', () => {
  it('accepts an exact match to a declared outcome', () => {
    expect(parseSealedProbeResult('{"result":"success"}', OUTCOMES)).toEqual({ result: 'success' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseSealedProbeResult('  \n{ "result" : "success" }\t\n', OUTCOMES)).toEqual({ result: 'success' });
  });

  it('maps malformed JSON to the reserved ERROR result', () => {
    expect(parseSealedProbeResult('not json at all', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('maps duplicate "result" keys to the reserved ERROR result', () => {
    expect(parseSealedProbeResult('{"result":"success","result":"timeout"}', OUTCOMES))
      .toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('maps trailing data after the object to the reserved ERROR result', () => {
    expect(parseSealedProbeResult('{"result":"success"} extra', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
    expect(parseSealedProbeResult('{"result":"success"}{}', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('maps extra fields to the reserved ERROR result', () => {
    expect(parseSealedProbeResult('{"result":"success","extra":1}', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('maps a non-enum result value to the reserved ERROR result', () => {
    expect(parseSealedProbeResult('{"result":"not-a-declared-outcome"}', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('maps a literal ERROR value to the (already reserved) ERROR result', () => {
    expect(parseSealedProbeResult('{"result":"ERROR"}', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('maps a non-string result value to the reserved ERROR result', () => {
    expect(parseSealedProbeResult('{"result":42}', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
    expect(parseSealedProbeResult('{"result":null}', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
    expect(parseSealedProbeResult('{"result":true}', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('maps an empty string to the reserved ERROR result', () => {
    expect(parseSealedProbeResult('', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('maps an oversized result to the reserved ERROR result', () => {
    const oversized = `{"result":"${'x'.repeat(MAX_RESULT_BYTES)}"}`;
    expect(parseSealedProbeResult(oversized, OUTCOMES))
      .toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('maps an array instead of an object to the reserved ERROR result', () => {
    expect(parseSealedProbeResult('["success"]', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('rejects single-quoted strings as malformed JSON', () => {
    expect(parseSealedProbeResult("{'result':'success'}", OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('rejects unterminated strings', () => {
    expect(parseSealedProbeResult('{"result":"success', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });

  it('rejects raw control characters embedded in the string', () => {
    expect(parseSealedProbeResult('{"result":"line\nbreak"}', OUTCOMES)).toEqual({ result: RESERVED_ERROR_OUTCOME });
  });
});

describe('parseSealedProbeResultJson', () => {
  it('returns canonical JSON for a valid result', () => {
    expect(parseSealedProbeResultJson('{"result":"success"}', OUTCOMES)).toBe('{"result":"success"}');
  });

  it('returns the canonical error JSON for any invalid input', () => {
    expect(parseSealedProbeResultJson('garbage', OUTCOMES)).toBe(CANONICAL_ERROR_RESULT_JSON);
    expect(parseSealedProbeResultJson('{"result":"success","result":"timeout"}', OUTCOMES)).toBe(CANONICAL_ERROR_RESULT_JSON);
  });
});
