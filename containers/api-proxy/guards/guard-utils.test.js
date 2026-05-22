const { parsePositiveInteger } = require('./guard-utils');

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
});
