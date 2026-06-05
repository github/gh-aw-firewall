const { parseBodyAsObject } = require('./body-utils');

describe('parseBodyAsObject', () => {
  it('parses a JSON object from a buffer', () => {
    const parsed = parseBodyAsObject(Buffer.from(JSON.stringify({ model: 'gpt-5.4' })));
    expect(parsed).toEqual({ model: 'gpt-5.4' });
  });

  it('returns null for invalid JSON', () => {
    expect(parseBodyAsObject(Buffer.from('not-json'))).toBeNull();
  });

  it('returns null for arrays and non-objects', () => {
    expect(parseBodyAsObject(Buffer.from(JSON.stringify([])))).toBeNull();
    expect(parseBodyAsObject(Buffer.from(JSON.stringify('text')))).toBeNull();
  });
});
