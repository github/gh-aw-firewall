jest.mock('./model-eligibility', () => ({ evaluateModelEligibility: jest.fn() }));
jest.mock('./guards/retired-model-guard', () => ({ getRetiredModelBlockState: jest.fn() }));

const { evaluateModelEligibility } = require('./model-eligibility');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const { _isModelPermittedByPolicy, _isModelHarnessPermitted } = require('./model-policy');

beforeEach(() => {
  jest.resetAllMocks();
});

describe('resolver model policy', () => {
  it('applies allow and deny patterns and permits models without a policy', () => {
    const policy = { allowedModels: ['openai/gpt-*'], disallowedModels: ['openai/*mini*'] };
    expect(_isModelPermittedByPolicy('gpt-5', null, 'openai')).toBe(true);
    expect(_isModelPermittedByPolicy('gpt-5', policy, 'openai')).toBe(true);
    expect(_isModelPermittedByPolicy('gpt-5-mini', policy, 'openai')).toBe(false);
    expect(_isModelPermittedByPolicy('other', policy, 'openai')).toBe(false);
  });

  it('rejects retired Copilot targets even without a configured policy', () => {
    getRetiredModelBlockState.mockReturnValue({ reason: 'retired' });
    expect(_isModelPermittedByPolicy('retired-model', null, 'copilot')).toBe(false);
    expect(getRetiredModelBlockState).toHaveBeenCalledWith('retired-model', 'copilot', { inputMode: 'native' });
    expect(_isModelPermittedByPolicy('retired-model', null, 'openai')).toBe(true);
  });

  it.each(['incompatible', 'unverified'])('records the first %s harness rejection', harness => {
    const decision = { harness };
    const state = { eligibilityRequest: {} };
    evaluateModelEligibility.mockReturnValue(decision);
    expect(_isModelHarnessPermitted('gpt-5', 'openai', state)).toBe(false);
    expect(evaluateModelEligibility).toHaveBeenCalledWith('gpt-5', 'openai', state.eligibilityRequest, { inputMode: 'native' });
    expect(state.harnessRejection).toBe(decision);
    evaluateModelEligibility.mockReturnValue({ harness: 'incompatible' });
    expect(_isModelHarnessPermitted('gpt-5-mini', 'openai', state)).toBe(false);
    expect(state.harnessRejection).toBe(decision);
  });

  it('does not mark an eligible harness as rejected', () => {
    evaluateModelEligibility.mockReturnValue({ harness: 'compatible' });
    const state = { eligibilityRequest: {} };
    expect(_isModelHarnessPermitted('gpt-5', 'openai', state)).toBe(true);
    expect(state.harnessRejection).toBeUndefined();
  });
});
