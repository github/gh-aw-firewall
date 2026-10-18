const { parseCallerHeader, callerHeaderRejection, callerRecordFields } = require('./caller-header');

describe('caller-header', () => {
  test('parseCallerHeader accepts the main agent', () => {
    expect(parseCallerHeader('main')).toEqual({ purpose: 'agent', caller_source: 'caller_header' });
  });

  test('parseCallerHeader accepts a sub-agent name', () => {
    expect(parseCallerHeader('subagent/file-summarizer')).toEqual({
      purpose: 'subagent',
      agent_name: 'file-summarizer',
      caller_source: 'caller_header',
    });
    expect(parseCallerHeader('subagent/a_b.c:d/e-f')).toMatchObject({ agent_name: 'a_b.c:d/e-f' });
  });

  test('parseCallerHeader accepts a value of exactly 128 characters', () => {
    const value = `subagent/${'a'.repeat(119)}`;
    expect(value).toHaveLength(128);
    expect(parseCallerHeader(value)).toMatchObject({ agent_name: 'a'.repeat(119) });
  });

  test('parseCallerHeader returns null when the header is absent', () => {
    expect(parseCallerHeader(undefined)).toBeNull();
    expect(callerHeaderRejection(undefined)).toBeNull();
  });

  test.each([
    ['a 129-character value', `subagent/${'a'.repeat(120)}`, 'too_long'],
    ['an illegal space', 'subagent/file summarizer', 'invalid_format'],
    ['an empty sub-agent name', 'subagent/', 'invalid_format'],
    ['an unknown form', 'admin', 'invalid_format'],
    ['a duplicated header joined by Node', 'main, main', 'invalid_format'],
    ['an empty value', '', 'invalid_format'],
    ['a newline suffix', 'main\n', 'invalid_format'],
    ['a non-string value', ['main'], 'not_a_string'],
  ])('parseCallerHeader rejects invalid values: %s', (_name, value, reason) => {
    expect(parseCallerHeader(value)).toBeNull();
    expect(callerHeaderRejection(value)).toBe(reason);
  });

  test('callerRecordFields prefers the trusted AWF purpose over a caller', () => {
    expect(callerRecordFields('routing_classification', parseCallerHeader('subagent/x'))).toEqual({
      purpose: 'routing_classification',
      caller_source: 'awf',
    });
  });

  test('callerRecordFields returns no fields without a valid caller', () => {
    expect(callerRecordFields(undefined, null)).toEqual({});
    expect(callerRecordFields(undefined, { purpose: 'admin', caller_source: 'caller_header' })).toEqual({});
  });
});
