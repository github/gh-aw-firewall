'use strict';

jest.mock('./catalogue-loader', () => ({ getCatalogueLoader: jest.fn() }));
jest.mock('./guards/max-model-multiplier-guard', () => ({ getModelMultiplierCapBlockState: jest.fn() }));

const { getCatalogueLoader } = require('./catalogue-loader');
const { getModelMultiplierCapBlockState } = require('./guards/max-model-multiplier-guard');
const {
  ROUTER_METADATA, createFallbackCandidates, createGuardedSelection, resolveRouterFallback, withinModelCap,
} = require('./routing-fallback-policy');
const { createRoutingError } = require('./routing-errors');

const SKIPPABLE = [
  'model_multiplier_cap_exceeded', 'model_multiplier_cap_unverifiable', 'pricing_resolution_error',
  'retired_model', 'model_policy_violation', 'no_route',
];
const TERMINAL = ['ai_credits_limit_exceeded', 'provider_unavailable', 'routing_cancelled', 'routing_timeout'];

function harness() {
  const choices = ['a', 'b', 'c'].map(id => ({ id, model: `github-copilot/model-${id}`, effort: 'medium' }));
  const pool = {
    choices,
    byId: Object.fromEntries(choices.map(choice => [choice.id, {
      choice, wireModel: `model-${choice.id}`, provider: 'copilot', protocol: 'responses',
    }])),
  };
  const executor = { checkBeforePrimary: jest.fn(async () => {}) };
  const assertActive = jest.fn();
  const eligibilityRequest = { awfEligibility: {}, awfEligibilityScope: { provider: 'copilot' } };
  const phaseSignal = new AbortController().signal;
  const guards = createGuardedSelection({
    pool, executor, assertActive, eligibilityRequest,
    runPhase: operation => operation({ signal: phaseSignal }),
  });
  return { pool, choices, executor, guards, assertActive, eligibilityRequest, phaseSignal };
}

describe('routing fallback policy', () => {
  let capture;

  beforeEach(() => {
    jest.clearAllMocks();
    capture = jest.fn(() => ({ pinned: true }));
    getCatalogueLoader.mockReturnValue({ capture });
  });

  it.each(['router_unavailable', 'routing_contract_error', 'routing_configuration_error', 'routing_timeout', ...SKIPPABLE])(
    'permits router fallback for %s within the overall deadline', code => {
      expect(resolveRouterFallback(createRoutingError(code, 'rejected'), { clock: { now: () => 1 }, deadline: 2 }))
        .toBe(code);
    },
  );

  it.each(['ai_credits_limit_exceeded', 'provider_unavailable', 'routing_cancelled'])(
    'never falls back from run-wide %s failures', code => {
      const error = createRoutingError(code, 'terminal');
      expect(() => resolveRouterFallback(error, { clock: { now: () => 1 }, deadline: 2 })).toThrow(error);
    },
  );

  it('prioritizes cancellation and does not fall back after the overall timeout', () => {
    const timeout = createRoutingError('routing_timeout', 'deadline');
    expect(() => resolveRouterFallback(timeout, { clock: { now: () => 2 }, deadline: 2 })).toThrow(timeout);
    expect(() => resolveRouterFallback(timeout, { signal: { aborted: true }, clock: { now: () => 2 }, deadline: 2 }))
      .toThrow(expect.objectContaining({ code: 'routing_cancelled' }));
    const untyped = Object.assign(new Error('unknown'), { code: 'no_route' });
    expect(() => resolveRouterFallback(untyped, {})).toThrow(untyped);
  });

  it.each(SKIPPABLE)('caches %s rejections and proceeds to the next choice', async code => {
    const { choices, executor, guards, assertActive } = harness();
    const error = createRoutingError(code, 'guard rejection');
    executor.checkBeforePrimary.mockRejectedValueOnce(error);
    const rejected = await guards.checkChoice(choices[0], ROUTER_METADATA);
    expect(rejected).toEqual({ ok: false, error });
    expect(await guards.checkChoice(choices[0], ROUTER_METADATA)).toBe(rejected);
    const winner = await guards.selectFirstPassing(choices.map(choice => ({ choice, metadata: ROUTER_METADATA })));
    expect(winner.choice).toBe(choices[1]);
    expect(executor.checkBeforePrimary).toHaveBeenCalledTimes(2);
    expect(assertActive).toHaveBeenCalledTimes(1);
    expect(guards.getFirstChoiceError()).toBe(error);
  });

  it.each(TERMINAL)('does not skip or cache terminal %s failures', async code => {
    const { choices, executor, guards, assertActive } = harness();
    const error = createRoutingError(code, 'terminal');
    executor.checkBeforePrimary.mockRejectedValueOnce(error);
    await expect(guards.selectFirstPassing(choices.map(choice => ({ choice, metadata: ROUTER_METADATA }))))
      .rejects.toBe(error);
    expect(executor.checkBeforePrimary).toHaveBeenCalledTimes(1);
    expect(guards.checkedChoices.size).toBe(0);
    expect(assertActive).not.toHaveBeenCalled();
  });

  it('does not cache a skippable rejection if cancellation or the deadline takes precedence', async () => {
    const { choices, executor, guards, assertActive } = harness();
    executor.checkBeforePrimary.mockRejectedValue(createRoutingError('retired_model', 'retired'));
    const timeout = createRoutingError('routing_timeout', 'deadline');
    assertActive.mockImplementation(() => { throw timeout; });
    await expect(guards.checkChoice(choices[0], ROUTER_METADATA)).rejects.toBe(timeout);
    expect(guards.getFirstChoiceError()).toBeNull();
    expect(guards.checkedChoices.size).toBe(0);
  });

  it('pins pricing and eligibility across checks, caches successes, and retains the first rejection', async () => {
    const { choices, executor, guards, eligibilityRequest, phaseSignal } = harness();
    expect(capture).not.toHaveBeenCalled();
    const firstError = createRoutingError('retired_model', 'first');
    executor.checkBeforePrimary
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(createRoutingError('model_policy_violation', 'second'));
    await guards.checkChoice(choices[0], ROUTER_METADATA);
    await guards.checkChoice(choices[1], ROUTER_METADATA);
    const passed = await guards.checkChoice(choices[2], ROUTER_METADATA);
    expect(await guards.checkChoice(choices[2], { selectionSource: 'fallback' })).toBe(passed);
    expect(guards.getFirstChoiceError()).toBe(firstError);
    expect(capture).toHaveBeenCalledTimes(1);
    const requests = executor.checkBeforePrimary.mock.calls.map(([request]) => request);
    for (const request of requests) {
      expect(request.signal).toBe(phaseSignal);
      expect(request.awfEligibility).toBe(eligibilityRequest.awfEligibility);
      expect(request.awfEligibilityScope).toBe(eligibilityRequest.awfEligibilityScope);
      expect(request.awfCatalogue).toBe(guards.getPinnedPricingCatalogue());
      expect(request.awfPricingCache).toBe(requests[0].awfPricingCache);
    }
    expect(passed.selection.selection_source).toBe('router');
    expect(await guards.selectFirstPassing(choices.map(choice => ({ choice, metadata: ROUTER_METADATA })))).toBeNull();
  });

  it.each([
    ['auto', { mode: 'robust' }, ['b', 'a', 'c']],
    ['auto', { mode: 'unknown' }, ['a', 'b', 'c']],
    ['auto', null, ['a', 'b', 'c']],
    ['balanced', { mode: 'robust' }, ['a', 'b', 'c']],
  ])('uses classification for auto fallback ordering only', (mode, classification, order) => {
    const { pool } = harness();
    const objective = { goal: 'cost', mode };
    const candidates = createFallbackCandidates(pool, {
      objective, classification, fallbackReason: 'no_route',
      codingTiers: { 'model-a': { tier: 'standard' }, 'model-b': { tier: 'premium' } },
    });
    expect(candidates.map(({ choice }) => choice.id)).toEqual(order);
    expect(candidates[0].metadata).toEqual({
      selectionSource: 'fallback', fallbackReason: 'no_route', fallbackTier: order[0] === 'a' ? 'standard' : 'premium',
    });
    expect(objective.mode).toBe(mode);
  });

  it('checks the multiplier cap against native wire IDs and providers', () => {
    const { pool, choices } = harness();
    getModelMultiplierCapBlockState.mockReturnValueOnce(null).mockReturnValueOnce({ blocked: true });
    expect(withinModelCap(choices[0], pool)).toBe(true);
    expect(withinModelCap(choices[1], pool)).toBe(false);
    expect(getModelMultiplierCapBlockState.mock.calls).toEqual([['model-a', 'copilot'], ['model-b', 'copilot']]);
  });
});
