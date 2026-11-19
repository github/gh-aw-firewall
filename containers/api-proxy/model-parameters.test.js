const {
  splitModelParameters,
  appendModelParameters,
  applyModelParametersToResolution,
} = require('./model-parameters');

describe('model parameters', () => {
  it.each([null, undefined, 42, 'gpt-5'])('leaves a model without parameters unchanged: %p', model => {
    expect(splitModelParameters(model)).toEqual({ baseModel: model, parameterSuffix: '' });
  });

  it('splits only at the first question mark', () => {
    expect(splitModelParameters('gpt-5?reasoning=high&value=?')).toEqual({
      baseModel: 'gpt-5', parameterSuffix: '?reasoning=high&value=?',
    });
  });

  it('preserves parameters already present on a candidate', () => {
    expect(appendModelParameters('gpt-5?reasoning=low', '?reasoning=high')).toBe('gpt-5?reasoning=low');
    expect(appendModelParameters('gpt-5', '?reasoning=high')).toBe('gpt-5?reasoning=high');
    expect(appendModelParameters(null, '?reasoning=high')).toBeNull();
  });

  it('copies a resolution and its candidates without mutating the original', () => {
    const resolution = Object.freeze({
      resolvedModel: 'gpt-5',
      candidates: Object.freeze(['gpt-5', 'gpt-5?reasoning=low']),
      log: [],
    });
    expect(applyModelParametersToResolution(resolution, '?reasoning=high')).toEqual({
      resolvedModel: 'gpt-5?reasoning=high',
      candidates: ['gpt-5?reasoning=high', 'gpt-5?reasoning=low'],
      log: resolution.log,
    });
    expect(applyModelParametersToResolution(resolution, '')).toBe(resolution);
    expect(applyModelParametersToResolution(null, '?reasoning=high')).toBeNull();
  });

  it('does not add candidates to a fallback result without them', () => {
    expect(applyModelParametersToResolution({ resolvedModel: 'gpt-5' }, '?reasoning=high')).toEqual({
      resolvedModel: 'gpt-5?reasoning=high',
    });
  });
});
