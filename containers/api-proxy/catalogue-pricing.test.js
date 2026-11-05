'use strict';

jest.mock('./model-information.naming.generated.json', () => ({
  models: [{
    identity: {
      key: 'copilot/canonical-model', provider: 'copilot', rawId: 'canonical-model',
      lookupId: 'canonical-model',
      aliases: [{
        id: 'friendly-model', match: 'exact',
        scope: { provider: 'copilot', channel: 'copilot-api' },
      }],
    },
  }],
  rules: [],
}), { virtual: true });

const { resolveCentralPricing, validateTariffs, getMedianPricingFact } = require('./catalogue-pricing');
const { computeTokenBudgetUsage } = require('./token-budget-log');

const provenance = { at: '2026-10-23T00:00:00Z' };
function capture(rawId = 'canonical-model', price = '2', deployment) {
  return {
    source: 'fixture', revision: `revision-${price}`,
    time: Date.parse('2026-10-23T12:00:00Z'), maxAge: 86400000,
    snapshot: { models: [{
      identity: {
        provider: 'copilot', key: `copilot/${rawId}`, rawId,
        lookupId: rawId.replace(/[._]/g, '-'),
        aliases: [{ id: 'feed-only-alias', scope: { provider: 'copilot', channel: 'copilot-api' }, match: 'exact' }],
      },
      provenance,
      tariffs: [{
        unit: 'USD_PER_1M_TOKENS', tier: 'default', provenance,
        scope: { provider: 'copilot', channel: 'copilot-api', deployment },
        components: Object.fromEntries(['input', 'output', 'cachedInput', 'cacheWrite']
          .map(field => [field, { price, provenance }])),
      }],
    }] },
  };
}

test('pricing uses maintained canonical identity and preserves imported field authority', () => {
  const pinned = capture();
  for (const name of ['canonical-model', 'friendly-model', 'copilot/friendly-model?effort=high']) {
    expect(resolveCentralPricing('copilot', name, 0, pinned))
      .toMatchObject({ pricing: { input: 2 }, pricingCatalogVersion: 'revision-2' });
  }
  expect(resolveCentralPricing('copilot', 'canonical-model', 0, capture('friendly-model'))).toBeNull();
  expect(resolveCentralPricing('copilot', 'friendly-model', 0, capture('friendly-model')))
    .toMatchObject({ pricing: { input: 2 } });
  const usage = computeTokenBudgetUsage({
    logRequest: () => {}, requestId: 'identity', provider: 'copilot', catalogue: pinned,
  }, { input_tokens: 1000000 }, 'friendly-model');
  expect(usage).toMatchObject({
    ai_credits_this_response: 200,
    ai_credits_pricing_source: 'central_feed',
    ai_credits_pricing_catalog_version: 'revision-2',
  });
  expect(resolveCentralPricing('copilot', 'friendly-model', 0, capture('canonical-model', '4')))
    .toMatchObject({ pricing: { input: 4 }, pricingCatalogVersion: 'revision-4' });
  expect(resolveCentralPricing('copilot', 'friendly-model', 0, pinned).pricing.input).toBe(2);
});

test('feed names cannot extend naming coverage or enable global lookup normalization', () => {
  expect(resolveCentralPricing('copilot', 'feed-only-alias', 0, capture())).toBeNull();
  expect(resolveCentralPricing('copilot', 'unknown-model', 0, capture('unknown.model')))
    .toMatchObject({ pricing: { input: 2 } });
  expect(resolveCentralPricing('copilot', 'unknown_model', 0, capture('unknown.model'))).toBeNull();
  expect(resolveCentralPricing('copilot', 'UNKNOWN.MODEL', 0, capture('unknown.model'))).toBeNull();
  expect(resolveCentralPricing('copilot', 'unknown.model', 0, capture('unknown.model')))
    .toMatchObject({ pricing: { input: 2 } });
  expect(resolveCentralPricing('copilot', 'canonical-model', 0, capture('other-model'))).toBeNull();
  expect(resolveCentralPricing('copilot', 'canonical-model', 0, capture('copilot/canonical-model'))).toBeNull();
  expect(resolveCentralPricing('copilot', 'openai/canonical-model', 0, capture())).toBeNull();
  const mismatched = capture();
  mismatched.snapshot.models[0].identity.key = 'copilot/other-model';
  mismatched.snapshot.models[0].identity.lookupId = 'other-model';
  expect(resolveCentralPricing('copilot', 'canonical-model', 0, mismatched)).toBeNull();
  const foreign = capture();
  foreign.snapshot.models[0].identity = {
    provider: 'openai', key: 'openai/canonical-model',
    rawId: 'canonical-model', lookupId: 'canonical-model',
  };
  expect(resolveCentralPricing('copilot', 'canonical-model', 0, foreign)).toBeNull();
});

test('preserves exact v1 stored lookup pricing without changing naming or fallback identities', () => {
  const oldSnapshot = capture('gpt-5.3-codex');
  const entry = oldSnapshot.snapshot.models[0];
  const requested = 'gpt-5-3-codex';
  expect(entry.identity.rawId === requested || entry.identity.lookupId === requested ||
    entry.identity.key === requested).toBe(true);
  expect(resolveCentralPricing('copilot', requested, 0, oldSnapshot))
    .toMatchObject({ pricing: { input: 2 } });
  for (const name of ['gpt_5_3_codex', 'GPT-5-3-CODEX', 'gpt-5-3-codex?effort=high']) {
    expect(resolveCentralPricing('copilot', name, 0, oldSnapshot)).toBeNull();
  }
  expect(resolveCentralPricing('openai', requested, 0, oldSnapshot)).toBeNull();
  const { resolveFallbackEntry } = require('./model-fallback-chain');
  expect(resolveFallbackEntry(requested, 'copilot').model).toBe(requested);
  const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');
  expect(isModelPermittedByPolicy(requested, ['gpt-5.3-codex'], null, 'copilot')).toBe(false);
  oldSnapshot.snapshot.models.push(structuredClone(entry));
  expect(resolveCentralPricing('copilot', requested, 0, oldSnapshot)).toBeNull();
});

test('native provider IDs remain distinct from qualified request selectors during pricing', () => {
  const snapshot = capture('gpt-5.3-codex', '2');
  snapshot.snapshot.models.push(capture('copilot/gpt-5.3-codex', '9').snapshot.models[0]);

  expect(resolveCentralPricing(
    'copilot', 'copilot/gpt-5.3-codex', 0, snapshot, { nativeInput: true },
  )).toMatchObject({ pricing: { input: 9 } });
  expect(resolveCentralPricing(
    'copilot', 'copilot/gpt-5.3-codex', 0, snapshot,
  )).toMatchObject({ pricing: { input: 2 } });
});

test('pricing preserves provider, channel, deployment, freshness and ambiguity boundaries', () => {
  expect(resolveCentralPricing('openai', 'canonical-model', 0, capture())).toBeNull();
  expect(resolveCentralPricing('copilot', 'canonical-model', 0, capture(), { channel: 'native-api' })).toBeNull();
  const deployed = capture('canonical-model', '2', 'prod');
  expect(resolveCentralPricing('copilot', 'canonical-model', 0, deployed)).toBeNull();
  expect(resolveCentralPricing('copilot', 'canonical-model', 0, deployed, { deployment: 'prod' })).not.toBeNull();
  expect(resolveCentralPricing('copilot', 'friendly-model', 0, deployed, { deployment: 'prod' })).toBeNull();
  const stale = capture();
  stale.time += 86400000;
  expect(resolveCentralPricing('copilot', 'friendly-model', 0, stale)).toBeNull();
  const ambiguous = capture();
  ambiguous.snapshot.models.push(capture().snapshot.models[0]);
  expect(resolveCentralPricing('copilot', 'friendly-model', 0, ambiguous)).toBeNull();
});

test('rejects tariffs whose unit-converted numeric rate is unrepresentable', () => {
  const snapshot = capture();
  const tariff = snapshot.snapshot.models[0].tariffs[0];
  tariff.unit = 'USD_PER_TOKEN';
  for (const component of Object.values(tariff.components)) component.price = '9'.repeat(310);

  expect(() => validateTariffs(snapshot.snapshot)).toThrow('catalogue_tariff_unsupported');
});

test.each(['stale', 'retired', 'removed', 'expired', 'future', 'component', 'deployment', 'channel', 'byok'])(
  'family donor selection excludes %s evidence, independently of request availability', exclusion => {
    const pinned = capture('median-a', '2');
    const a = pinned.snapshot.models[0];
    a.identity.family = 'declared-family';
    const b = structuredClone(capture('median-b', '100').snapshot.models[0]);
    b.identity.family = 'declared-family';
    const missing = structuredClone(capture('median-missing').snapshot.models[0]);
    missing.identity.family = 'declared-family';
    missing.tariffs = [];
    if (exclusion === 'stale') b.provenance = { ...provenance, stale: true };
    if (['retired', 'removed'].includes(exclusion)) b.lifecycle = { status: exclusion };
    if (exclusion === 'expired') b.tariffs[0].effectiveUntil = new Date(pinned.time).toISOString();
    if (exclusion === 'future') b.tariffs[0].effectiveFrom = '2027-01-01T00:00:00Z';
    if (exclusion === 'component') b.tariffs[0].components.input.provenance = { ...provenance, stale: true };
    if (exclusion === 'deployment') b.tariffs[0].scope.deployment = 'private';
    if (exclusion === 'channel') b.tariffs[0].scope.channel = 'cli';
    pinned.snapshot.models.push(b, missing);
    const before = structuredClone(pinned);
    const fact = getMedianPricingFact('copilot', 'median-missing', 100, {
      catalogue: pinned, runtimeCatalog: {}, centralAllowed: exclusion !== 'byok',
    });
    expect(fact.metadata.estimate).toMatchObject(exclusion === 'byok'
      ? { basis: 'backend', sources: ['curated'] }
      : { basis: 'family', donorCount: 1, sources: ['central_feed'] });
    if (exclusion !== 'byok') expect(fact.default.input).toBe(2);
    expect(pinned).toEqual(before);
  },
);

test('new captures change family medians and fingerprints without changing pinned estimates', () => {
  const pinned = capture('canonical-model', '2');
  pinned.snapshot.models[0].identity.family = 'declared-family';
  const missing = structuredClone(capture('median-missing').snapshot.models[0]);
  missing.identity.family = 'declared-family';
  missing.tariffs = [];
  pinned.snapshot.models.push(missing);
  const options = { catalogue: pinned, centralAllowed: true, runtimeCatalog: {} };
  const first = getMedianPricingFact('copilot', 'median-missing', 0, options);
  const next = structuredClone(pinned);
  next.revision = 'r2';
  next.snapshot.models[0].tariffs[0].components.input.price = '8';
  const second = getMedianPricingFact('copilot', 'median-missing', 0, { ...options, catalogue: next });
  expect(first.default.input).toBe(2);
  expect(second.default.input).toBe(8);
  expect(second.metadata.pricingCatalogVersion).not.toBe(first.metadata.pricingCatalogVersion);
  expect(getMedianPricingFact('copilot', 'median-missing', 0, options)).toEqual(first);
});
