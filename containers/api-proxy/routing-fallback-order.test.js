'use strict';

const {
  DEFAULT_CODING_TIERS,
  DEFAULT_TIER_ORDER,
  ROBUST_TIER_ORDER,
  orderFallbackChoices,
  selectFallbackEffort,
  toLookupId,
} = require('./routing-fallback-order');

const EIGHT_MODEL_FIXTURE = Object.freeze([
  { wireModel: 'std-dated', efforts: ['low', 'medium', 'high'], tier: 'standard', releaseDate: '2026-10-01' },
  { wireModel: 'prem-dated', efforts: ['low', 'medium', 'high'], tier: 'premium', releaseDate: '2026-10-15' },
  { wireModel: 'light-dated', efforts: ['low', 'medium'], tier: 'lightweight', releaseDate: '2026-11-01' },
  { wireModel: 'other-dated', efforts: ['medium'], tier: 'none', releaseDate: '2026-11-10' },
  { wireModel: 'unclass-dated', efforts: ['low', 'medium'], tier: undefined, releaseDate: '2026-11-05' },
  { wireModel: 'std-undated', efforts: ['medium'], tier: 'standard', releaseDate: undefined },
  { wireModel: 'claude-effortless', efforts: [], tier: 'lightweight', releaseDate: '2025-10-15' },
  // Same tier and release date as std-dated, and no medium effort: breaks ties by exact wire ID and picks high.
  { wireModel: 'alpha-no-medium', efforts: ['low', 'high'], tier: 'standard', releaseDate: '2026-10-01' },
]);

const FIXTURE_CODING_TIERS = Object.freeze(
  Object.fromEntries(
    EIGHT_MODEL_FIXTURE
      .filter(model => model.tier !== undefined || model.releaseDate !== undefined)
      .map(model => [
        toLookupId(model.wireModel, 'copilot'),
        {
          ...(model.tier !== undefined ? { tier: model.tier } : {}),
          ...(model.releaseDate !== undefined ? { releaseDate: model.releaseDate } : {}),
        },
      ]),
  ),
);

function buildPoolForSubset(models) {
  const choices = [];
  const byId = Object.create(null);
  let seq = 1;
  for (const model of models) {
    const efforts = model.efforts.length === 0 ? [undefined] : model.efforts;
    for (const effort of efforts) {
      const id = `choice-${String(seq++).padStart(4, '0')}`;
      const choice = Object.freeze({
        id,
        model: `github-copilot/${model.wireModel}`,
        ...(effort === undefined ? {} : { effort }),
      });
      choices.push(choice);
      byId[id] = Object.freeze({
        choice,
        provider: 'copilot',
        wireModel: model.wireModel,
        ...(effort === undefined ? {} : { effort }),
        protocol: effort === undefined ? 'chat-completions' : 'responses',
      });
    }
  }
  return Object.freeze({ choices: Object.freeze(choices), byId: Object.freeze(byId) });
}

function expectedEffortFor(efforts) {
  if (efforts.length === 0) return undefined;
  if (efforts.includes('medium')) return 'medium';
  const ladder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const med = ladder.indexOf('medium');
  return [...efforts].sort((a, b) => {
    const da = Math.abs(ladder.indexOf(a) - med);
    const db = Math.abs(ladder.indexOf(b) - med);
    if (da !== db) return da - db;
    return ladder.indexOf(b) - ladder.indexOf(a);
  })[0];
}

describe('routing fallback order', () => {
  it('exhaustively orders every subset of the 8-model fixture under both objectives and input orders', () => {
    const count = EIGHT_MODEL_FIXTURE.length;
    const totalSubsets = 1 << count;
    const byWireModel = new Map(EIGHT_MODEL_FIXTURE.map(model => [model.wireModel, model]));

    for (const mode of ['balanced', 'robust']) {
      const tierOrder = mode === 'robust' ? ROBUST_TIER_ORDER : DEFAULT_TIER_ORDER;
      const tierRank = new Map(tierOrder.map((tier, index) => [tier, index]));

      for (let mask = 0; mask < totalSubsets; mask++) {
        const subset = EIGHT_MODEL_FIXTURE.filter((_, bit) => (mask & (1 << bit)) !== 0);
        const forwardPool = buildPoolForSubset(subset);
        const reversedPool = buildPoolForSubset([...subset].reverse());

        const forward = orderFallbackChoices(forwardPool, {
          codingTiers: FIXTURE_CODING_TIERS,
          objective: { goal: 'cost', mode },
        });
        const reversed = orderFallbackChoices(reversedPool, {
          codingTiers: FIXTURE_CODING_TIERS,
          objective: { goal: 'cost', mode },
        });
        const repeat = orderFallbackChoices(forwardPool, {
          codingTiers: FIXTURE_CODING_TIERS,
          objective: { goal: 'cost', mode },
        });

        // Deterministic and invariant under reversed input order.
        const project = list => list.map(({ wireModel, tier, releaseDate, choice }) => ({
          wireModel,
          tier,
          releaseDate,
          effort: choice.effort,
        }));
        expect(project(forward)).toEqual(project(repeat));
        expect(project(forward)).toEqual(project(reversed));

        // Output is a permutation of the subset's models with the right effort per model.
        expect(forward.map(entry => entry.wireModel).sort())
          .toEqual(subset.map(model => model.wireModel).sort());

        for (const entry of forward) {
          const spec = byWireModel.get(entry.wireModel);
          expect(entry.tier).toBe(spec.tier ?? 'unclassified');
          expect(entry.releaseDate).toBe(spec.releaseDate ?? null);
          expect(entry.choice.effort).toBe(expectedEffortFor(spec.efforts));
        }

        // Pairwise order: tier order, then newest releaseDate first (undated after dated), then wire ID.
        for (let i = 1; i < forward.length; i++) {
          const prev = forward[i - 1];
          const curr = forward[i];
          const prevTier = tierRank.get(prev.tier);
          const currTier = tierRank.get(curr.tier);
          expect(prevTier).toBeLessThanOrEqual(currTier);
          if (prevTier === currTier) {
            if (prev.releaseDate === null) {
              expect(curr.releaseDate).toBeNull();
              expect(prev.wireModel < curr.wireModel).toBe(true);
            } else if (curr.releaseDate !== null) {
              expect(prev.releaseDate >= curr.releaseDate).toBe(true);
              if (prev.releaseDate === curr.releaseDate) {
                expect(prev.wireModel < curr.wireModel).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  test.each([
    [['low', 'medium', 'high', 'xhigh'], 'medium'],
    [['low', 'high'], 'high'],
    [['low', 'xhigh'], 'low'],
    [['none', 'low'], 'low'],
    [['high', 'xhigh', 'max'], 'high'],
    [['minimal', 'xhigh'], 'xhigh'],
    [['none', 'max'], 'max'],
    [[], undefined],
  ])('selects fallback effort for %p -> %p', (efforts, expected) => {
    expect(selectFallbackEffort(efforts)).toBe(expected);
  });

  it('orders GPT-6.2 Sol before GPT-6.2 Astra on the same date, reversing for robust', () => {
    const pool = buildPoolForSubset([
      { wireModel: 'gpt-6.2-astra', efforts: ['low', 'medium', 'high'] },
      { wireModel: 'gpt-6.2-sol', efforts: ['low', 'medium', 'high'] },
    ]);

    for (const mode of ['balanced', 'economy', 'auto']) {
      const ordered = orderFallbackChoices(pool, { objective: { goal: 'cost', mode } });
      expect(ordered.map(entry => ({
        wireModel: entry.wireModel, tier: entry.tier, effort: entry.choice.effort,
      }))).toEqual([
        { wireModel: 'gpt-6.2-sol', tier: 'standard', effort: 'medium' },
        { wireModel: 'gpt-6.2-astra', tier: 'premium', effort: 'medium' },
      ]);
    }

    const robust = orderFallbackChoices(pool, { objective: { goal: 'cost', mode: 'robust' } });
    expect(robust.map(entry => ({
      wireModel: entry.wireModel, tier: entry.tier, effort: entry.choice.effort,
    }))).toEqual([
      { wireModel: 'gpt-6.2-astra', tier: 'premium', effort: 'medium' },
      { wireModel: 'gpt-6.2-sol', tier: 'standard', effort: 'medium' },
    ]);
  });

  it('normalizes lookup IDs across casing, dots, underscores, and provider prefixes', () => {
    expect(toLookupId('gpt-5.3-codex', 'copilot')).toBe('gpt-5-3-codex');
    expect(toLookupId('GPT_5.3_Codex', 'copilot')).toBe('gpt-5-3-codex');
    expect(toLookupId('github-copilot/gpt-5.3-codex', 'copilot')).toBe('gpt-5-3-codex');
    expect(DEFAULT_CODING_TIERS['gpt-5-3-codex']).toEqual({
      tier: 'standard',
      releaseDate: '2026-02-05',
    });
  });

  it('places standard Codex ahead of a newer lightweight nano', () => {
    const pool = buildPoolForSubset([
      { wireModel: 'gpt-6.1-nano', efforts: ['low', 'medium', 'high'] },
      { wireModel: 'gpt-5.3-codex', efforts: ['low', 'medium', 'high'] },
    ]);
    const tiers = {
      ...DEFAULT_CODING_TIERS,
      'gpt-6-1-nano': { tier: 'lightweight', releaseDate: '2026-11-20' },
    };
    const ordered = orderFallbackChoices(pool, { codingTiers: tiers, objective: 'balanced' });
    expect(ordered.map(entry => entry.wireModel)).toEqual(['gpt-5.3-codex', 'gpt-6.1-nano']);
  });
});
