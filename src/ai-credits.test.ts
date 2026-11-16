import { parseAiCreditSuffix } from './ai-credits';

describe('parseAiCreditSuffix', () => {
  it.each([
    [' 20k ', 20_000],
    ['100M', 100_000_000],
  ])('parses %s with an inferred result type', (input, expected) => {
    const result = parseAiCreditSuffix(input);
    expect(result.recognized).toBe(true);
    if (result.recognized && 'value' in result) {
      expect(result.value).toBe(expected);
    } else {
      throw new Error('Expected a parsed AI credit suffix');
    }
  });

  it.each([undefined, 20, '20'])('does not recognize %s as a suffix', (input) => {
    expect(parseAiCreditSuffix(input)).toEqual({ recognized: false });
  });

  it.each(['20.5K', '0K', '10000000000000000M'])('reports invalid suffix %s', (input) => {
    const result = parseAiCreditSuffix(input);
    expect(result.recognized).toBe(true);
    if (result.recognized && 'error' in result) {
      expect(result.error).toEqual(expect.any(String));
    } else {
      throw new Error('Expected an AI credit suffix error');
    }
  });
});
