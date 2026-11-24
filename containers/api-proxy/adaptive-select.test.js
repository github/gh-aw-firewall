'use strict';

const vectors = require('./fixtures/adaptive/fw2-selector.json');
const { ADAPTIVE_REASONS, selectAdaptive, validSummary } = require('./adaptive-select');

// The vectors give each fake model's credits per token; AWF prices real models from its tariffs.
function priceFrom(tariffs) {
  return (pair, tokens) => {
    const tariff = tariffs[pair.slice(pair.indexOf('/') + 1, pair.lastIndexOf('@'))];
    if (!tariff) return null;
    let output = tokens.output * tariff.output;
    if (tariff.reasoning !== null && tokens.reasoning !== null) {
      output = (tokens.output - tokens.reasoning) * tariff.output + tokens.reasoning * tariff.reasoning;
    }
    return tokens.input * tariff.input + tokens.cache_read * tariff.cache_read +
      tokens.cache_write * tariff.cache_write + output;
  };
}

// Numbers agree to a relative tolerance of 1e-9 (vectors.arithmetic); everything else exactly.
function expectSame(actual, expected, path = 'receipt') {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const scale = Math.max(Math.abs(expected), Math.abs(actual));
    if (Math.abs(actual - expected) > Math.max(1e-12, 1e-9 * scale)) {
      throw new Error(`${path}: expected ${expected}, received ${actual}`);
    }
    return;
  }
  if (expected === null || typeof expected !== 'object') {
    if (actual !== expected) throw new Error(`${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    return;
  }
  expect(Array.isArray(actual)).toBe(Array.isArray(expected));
  expect(Object.keys(actual ?? {}).sort()).toEqual(Object.keys(expected).sort());
  for (const key of Object.keys(expected)) expectSame(actual[key], expected[key], `${path}.${key}`);
}

describe('adaptive selection oracle vectors', () => {
  const timelineSteps = vectors.timelines.flatMap(timeline =>
    timeline.steps.map((step, index) => [`${timeline.name} run ${index}`, step, timeline.tariffs]));

  it.each(timelineSteps)('%s', (_name, step, tariffs) => {
    const receipt = selectAdaptive({ summary: step.summary, rank: step.rank, job: step.job, price: priceFrom(tariffs) });
    expectSame(receipt, step.receipt);
  });

  it.each(vectors.cases.map(vector => [vector.name, vector]))('%s', (_name, vector) => {
    const receipt = selectAdaptive({
      summary: vector.summary, rank: vector.rank, job: vector.job, price: priceFrom(vectors.tariffs),
    });
    expectSame(receipt, vector.receipt);
  });

  it('uses only the documented reasons, and the vectors use each one', () => {
    const used = new Set([
      ...vectors.cases.map(vector => vector.receipt.reason),
      ...vectors.timelines.flatMap(timeline => timeline.steps.map(step => step.receipt.reason)),
    ]);
    expect([...used].sort()).toEqual([...ADAPTIVE_REASONS].sort());
    expect(Object.keys(vectors.reasons).sort()).toEqual([...ADAPTIVE_REASONS].sort());
  });
});

describe('selectAdaptive input handling', () => {
  const job = { workflow: 'pr-sous-chef', run_id: '45000000812', attempt: 1 };
  const rank = ['github-copilot/model-a@high', 'github-copilot/model-b@high'];
  const price = () => null;

  it.each([
    ['a string', 'invalid'],
    ['a pair without counts', { ...vectors.cases.find(c => c.name === 'cheaper-test').summary, pairs: [{ pair: rank[1] }] }],
    ['a malformed pair name', { ...vectors.cases.find(c => c.name === 'cheaper-test').summary, incumbent: 'model-b' }],
    ['duplicate pairs', (() => {
      const summary = vectors.cases.find(c => c.name === 'cheaper-test').summary;
      return { ...summary, pairs: [summary.pairs[0], summary.pairs[0]] };
    })()],
  ])('routes ordinarily when the summary is %s', (_name, summary) => {
    expect(selectAdaptive({ summary, rank, job, price })).toMatchObject({
      role: 'ordinary', selected: rank[0], reason: 'invalid_evidence', concurrency: null,
    });
  });

  it('honours an ordinary pick that is not first in the eligible rank', () => {
    const receipt = selectAdaptive({ summary: null, rank, ordinary: rank[1], job, price });
    expect(receipt).toMatchObject({ role: 'ordinary', selected: rank[1], ordinary: rank[1], reason: 'summary_missing' });
  });

  it('accepts a caller-resolved concrete level only when summary.level is "auto"', () => {
    const base = vectors.cases.find(c => c.name === 'cheaper-test');
    const autoSummary = { ...base.summary, level: 'auto' };
    const tariffs = priceFrom(vectors.tariffs);

    expect(selectAdaptive({ summary: autoSummary, rank: base.rank, job: base.job, price: tariffs }))
      .toMatchObject({ role: 'ordinary', reason: 'invalid_evidence' });
    expect(selectAdaptive({ summary: autoSummary, rank: base.rank, job: base.job, price: tariffs, level: 'balanced' }))
      .toEqual(base.receipt);
    expect(selectAdaptive({ summary: autoSummary, rank: base.rank, job: base.job, price: tariffs, level: 'auto' }))
      .toMatchObject({ role: 'ordinary', reason: 'invalid_evidence' });
    expect(selectAdaptive({ summary: base.summary, rank: base.rank, job: base.job, price: tariffs, level: 'economy' }))
      .toMatchObject({ role: 'ordinary', reason: 'invalid_evidence' });
  });
});

describe('cost estimate guards', () => {
  const job = { workflow: 'pr-sous-chef', run_id: '45000000812', attempt: 1 };
  const baseSummary = vectors.cases.find(c => c.name === 'cheaper-test').summary;
  const tokens = baseSummary.pairs[0].tokens;

  const makeSummary = pairs => ({
    ...baseSummary,
    incumbent: 'github-copilot/model-b@high',
    pairs,
  });

  const makePair = (pair, overrides = {}) => ({
    pair,
    wins: 1.98,
    losses: 0,
    runs: 2,
    credits: 10,
    model_credits: 10,
    bills: 2,
    tokens,
    streak: 0,
    tests: 0,
    suspended: null,
    ...overrides,
  });

  it('refuses to estimate a cheaper rival when incumbent model_credits exceeds credits', () => {
    const summary = makeSummary([
      makePair('github-copilot/model-b@high', { credits: 10, model_credits: 28 }),
    ]);
    const rank = ['github-copilot/model-a@high', 'github-copilot/model-b@high'];
    const ratioPrice = pair => (pair === rank[0] ? 1 : 10);

    expect(validSummary(summary, job)).toBe(true);
    const receipt = selectAdaptive({ summary, rank, job, price: ratioPrice });
    expect(receipt).toMatchObject({
      role: 'serve',
      selected: 'github-copilot/model-b@high',
      ordinary: 'github-copilot/model-a@high',
      incumbent: { before: 'github-copilot/model-b@high', after: 'github-copilot/model-b@high' },
      reason: 'no_challenger',
    });
    expect(receipt.costs).toEqual({
      'github-copilot/model-b@high': { credits: 10, basis: 'measured' },
    });
  });

  it('keeps valid measured rival costs while refusing estimates from an inconsistent incumbent', () => {
    const summary = makeSummary([
      makePair('github-copilot/model-b@high', { credits: 10, model_credits: 28 }),
      makePair('github-copilot/model-a@high', { wins: 1, runs: 1, credits: 4, model_credits: 4, bills: 1, tests: 1 }),
    ]);
    const rank = [
      'github-copilot/model-c@high',
      'github-copilot/model-a@high',
      'github-copilot/model-b@high',
    ];
    const ratioPrice = pair => (pair === 'github-copilot/model-c@high' ? 1 : 10);

    const receipt = selectAdaptive({ summary, rank, job, price: ratioPrice });
    expect(receipt).toMatchObject({
      role: 'test',
      selected: 'github-copilot/model-a@high',
      reason: 'challenger_hopeful_clears_need',
    });
    expect(receipt.costs).toEqual({
      'github-copilot/model-b@high': { credits: 10, basis: 'measured' },
      'github-copilot/model-a@high': { credits: 4, basis: 'measured' },
    });
  });

  it.each([
    ['an overflowing tariff ratio', { credits: 10, model_credits: 10 }, Number.MAX_VALUE, 1e-10],
    ['a negative rival tariff price', { credits: 10, model_credits: 10 }, -1, 10],
    ['a negative incumbent tariff price', { credits: 10, model_credits: 10 }, 1, -10],
    ['a NaN rival tariff price', { credits: 10, model_credits: 10 }, Number.NaN, 10],
    ['a negative rival tariff price with an unmeasured incumbent', { credits: null, model_credits: null, bills: 0 }, -5, 10],
  ])('refuses %s instead of recording a negative or non-finite estimate', (_label, incOverrides, rivalPrice, incPrice) => {
    const summary = makeSummary([
      makePair('github-copilot/model-b@high', incOverrides),
    ]);
    const rank = ['github-copilot/model-a@high', 'github-copilot/model-b@high'];
    const customPrice = pair => (pair === rank[0] ? rivalPrice : incPrice);

    expect(validSummary(summary, job)).toBe(true);
    const receipt = selectAdaptive({ summary, rank, job, price: customPrice });
    expect(receipt.role).toBe('serve');
    expect(receipt.selected).toBe('github-copilot/model-b@high');
    expect(receipt.costs).not.toHaveProperty('github-copilot/model-a@high');
    for (const entry of Object.values(receipt.costs)) {
      expect(Number.isFinite(entry.credits)).toBe(true);
      expect(entry.credits).toBeGreaterThanOrEqual(0);
    }
  });
});
