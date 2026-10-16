import { requireObject } from './json-validation';

describe('requireObject', () => {
  it('returns plain JSON objects', () => {
    const value = { key: 'value' };

    expect(requireObject(value, 'value')).toBe(value);
  });

  it.each([null, undefined, false, true, 0, 1, '', 'value', [], ['value']])(
    'rejects non-object JSON values: %p',
    (value) => {
      expect(() => requireObject(value, 'value')).toThrow(
        'value must be a JSON object',
      );
    },
  );
});
