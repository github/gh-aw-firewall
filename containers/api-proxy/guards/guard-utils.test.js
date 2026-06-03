const { parsePositiveInteger, parseModelMultipliers, parsePositiveNumber } = require('./guard-utils');

describe('guard-utils', () => {
  describe('parsePositiveInteger', () => {
    it.each([
      undefined,
      null,
      '',
      '   ',
      0,
      '0',
      -1,
      '-1',
      '1.5',
      'abc',
    ])('returns null for %p', (raw) => {
      expect(parsePositiveInteger(raw)).toBeNull();
    });

    it.each([
      [1, 1],
      ['1', 1],
      [' 42 ', 42],
    ])('for raw value %p returns %p', (raw, expected) => {
      expect(parsePositiveInteger(raw)).toBe(expected);
    });
  });

  describe('parseModelMultipliers', () => {
    it.each([undefined, null, '', '   ', 'invalid-json', '[]', '42'])(
      'returns empty object for %p',
      (raw) => {
        expect(parseModelMultipliers(raw)).toEqual({});
      }
    );

    it('parses only finite positive multipliers', () => {
      expect(
        parseModelMultipliers(
          JSON.stringify({
            valid: 2,
            stringValid: '3.5',
            zero: 0,
            negative: -1,
            notANumber: 'abc',
            infinity: Infinity,
          })
        )
      ).toEqual({
        valid: 2,
        stringValid: 3.5,
      });
    });
  });

  describe('parsePositiveNumber', () => {
    it.each([undefined, null, '', 'abc', 0, -1, Infinity])('returns null for %p', (raw) => {
      expect(parsePositiveNumber(raw)).toBeNull();
    });

    it.each([
      [1, 1],
      ['2.5', 2.5],
      [' 3 ', 3],
    ])('for raw value %p returns %p', (raw, expected) => {
      expect(parsePositiveNumber(raw)).toBe(expected);
    });
  });
});
