const { parseModelAliases, resolveAliasDefinition } = require('./model-alias-config');

describe('model alias configuration module', () => {
  it('parses and normalizes legacy and extended aliases', () => {
    const models = {
      Team: ['openai/gpt-*'],
      '': { patterns: ['Team'], fallback: false },
    };
    expect(parseModelAliases(JSON.stringify({ models }))).toEqual({ models });
    expect(resolveAliasDefinition(models.Team)).toEqual({ patterns: models.Team, fallback: true });
    expect(resolveAliasDefinition(models[''])).toEqual(models['']);
  });

  it.each(['null', '[]', '{}', '{"models":{"team":{"patterns":[1]}}}'])(
    'rejects malformed configuration: %s', raw => {
      expect(parseModelAliases(raw)).toBeNull();
    },
  );

  it('preserves the error code for case-insensitive alias collisions', () => {
    expect(() => parseModelAliases('{"models":{"Team":[],"TEAM":[]}}')).toThrow(
      expect.objectContaining({ code: 'ambiguous_model_alias' }),
    );
  });

  it.each([null, undefined, 'team', {}])('normalizes an invalid alias definition: %p', raw => {
    expect(resolveAliasDefinition(raw)).toEqual({ patterns: [], fallback: true });
  });
});
