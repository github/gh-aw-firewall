'use strict';

const {
  createOrdinaryAdaptiveReceipt, createSelection, finalizeAdaptiveReceipt, modelEffortPair, resolveAdaptiveLevel,
} = require('./routing-selection-receipts');

const PAIR = 'github-copilot/model-a@low';

function adaptive(attempt = 1) {
  return {
    job: { workflow: 'test-workflow', run_id: '123', attempt },
    summary: {
      generation: 'generation', mode: 'live', scope: 'copilot/cost/shared', incumbent: PAIR,
      explore: { allowed: true, turn: true, in_flight: 2 },
    },
  };
}

describe('routing selection receipts', () => {
  it.each(['economy', 'balanced', 'robust'])('resolves auto evidence to classifier mode %s', mode => {
    expect(resolveAdaptiveLevel({ level: 'auto' }, 'auto', { mode })).toBe(mode);
  });

  it.each([null, {}, { mode: 'unknown' }, { mode: 'toString' }])('defaults unresolved auto levels to balanced', classification => {
    expect(resolveAdaptiveLevel({ level: 'auto' }, 'auto', classification)).toBe('balanced');
  });

  it.each([null, [], {}, { level: 'balanced' }, Object.create({ level: 'auto' })])(
    'does not resolve malformed, fixed, or inherited summary levels', summary => {
      expect(resolveAdaptiveLevel(summary, 'auto', { mode: 'robust' })).toBeUndefined();
    },
  );

  it('does not resolve auto evidence for a fixed objective', () => {
    expect(resolveAdaptiveLevel({ level: 'auto' }, 'balanced', { mode: 'robust' })).toBeUndefined();
  });

  it('preserves only own effort fields, including explicit undefined', () => {
    expect(modelEffortPair({ id: 'a', model: 'model-a' })).toEqual({ model: 'model-a' });
    expect(modelEffortPair({ model: 'model-a', effort: undefined })).toHaveProperty('effort', undefined);
    expect(modelEffortPair(Object.assign(Object.create({ effort: 'high' }), { model: 'model-a' })))
      .toEqual({ model: 'model-a' });
  });

  it.each([
    ['responses', '/responses'], ['chat-completions', '/chat/completions'], ['messages', '/v1/messages'],
  ])('builds immutable %s selections with router defaults and fallback metadata', (protocol, endpoint) => {
    const choice = { id: 'a', model: 'github-copilot/model-a', effort: 'low' };
    const mapping = { provider: 'copilot', wireModel: 'model-a', protocol };
    const selection = createSelection(choice, mapping);
    expect(selection).toEqual({
      schema: 'awf-routing-selection/v1', engine: 'copilot', provider: 'copilot',
      choice, wire_model: 'model-a', endpoint,
      selection_source: 'router', fallback_reason: null, fallback_tier: null,
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.choice)).toBe(true);
    expect(Object.isFrozen(choice)).toBe(false);
    expect(createSelection(choice, mapping, {
      selectionSource: 'fallback', fallbackReason: 'no_route', fallbackTier: 'standard',
    })).toMatchObject({
      selection_source: 'fallback', fallback_reason: 'no_route', fallback_tier: 'standard',
    });
  });

  it.each([1, 2])('preserves ordinary evidence and disallows rerun exploration (attempt %s)', attempt => {
    const evidence = adaptive(attempt);
    expect(createOrdinaryAdaptiveReceipt(evidence, PAIR, 'selection_rejected')).toEqual({
      event: 'adaptive_selection', v: 2, workflow: evidence.job.workflow,
      run: { id: '123', attempt }, generation: 'generation', mode: 'live', scope: 'copilot/cost/shared',
      role: 'ordinary', explore_allowed: attempt === 1, selected: PAIR, ordinary: PAIR, would: null,
      incumbent: { before: PAIR, after: PAIR }, costs: {},
      concurrency: { turn: true, in_flight: 2, capacity: null }, reason: 'selection_rejected',
    });
  });

  it.each([[{}, 'selection_rejected'], [null, 'router_fallback']])(
    'finalizes ordinary receipts with the appropriate fallback reason', (route, reason) => {
      const receipt = finalizeAdaptiveReceipt({ adaptive: adaptive(), hasValidSummary: true, winningPair: PAIR, route });
      expect(receipt.reason).toBe(reason);
      expect(Object.isFrozen(receipt.incumbent)).toBe(true);
      expect(Object.isFrozen(receipt.concurrency)).toBe(true);
    },
  );

  it.each([[null, 'summary_missing'], [{ generation: 'untrusted' }, 'invalid_evidence']])(
    'does not copy invalid evidence into a final receipt', (summary, reason) => {
      const receipt = finalizeAdaptiveReceipt({
        adaptive: { ...adaptive(), summary }, hasValidSummary: false, winningPair: PAIR,
      });
      expect(receipt).toMatchObject({
        reason, selected: PAIR, ordinary: PAIR, generation: null, incumbent: null,
      });
    },
  );

  it('keeps an existing adaptive receipt and deeply freezes it', () => {
    const receipt = { role: 'explore', selected: PAIR, costs: { [PAIR]: 1 } };
    expect(finalizeAdaptiveReceipt({ receipt })).toBe(receipt);
    expect(Object.isFrozen(receipt.costs)).toBe(true);
  });
});
