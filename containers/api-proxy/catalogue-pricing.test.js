'use strict';

jest.mock('./model-information.naming.generated.json', () => ({
  models: [{
    identity: {
      key: 'copilot/canonical-model', provider: 'copilot', rawId: 'canonical-model',
      lookupId: 'canonical-model', family: 'bundled-family',
      aliases: [{
        id: 'friendly-model', match: 'exact',
        scope: { provider: 'copilot', channel: 'copilot-api' },
      }],
    },
  }, {
    identity: {
      key: 'copilot/median-missing', provider: 'copilot', rawId: 'median-missing',
      lookupId: 'median-missing', family: 'bundled-family',
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

test('family-free feed captures retain bundled family evidence', () => {
  const pinned = capture();
  const missing = structuredClone(capture('median-missing').snapshot.models[0]);
  missing.tariffs = [];
  pinned.snapshot.models.push(missing);

  const fact = getMedianPricingFact('copilot', 'median-missing', 0, {
    catalogue: pinned, centralAllowed: true, runtimeCatalog: {},
  });
  expect(fact.metadata.estimate).toMatchObject({ basis: 'family', family: 'bundled-family' });
});

test('runtime provider freshness uses the pinned runtime capture time, not the feed time', () => {
  const { replaceRuntimeModels, captureRuntimePricing, clearRuntimeModels } =
    require('./runtime-model-catalog');
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00Z'));
  replaceRuntimeModels('copilot', [{
    id: 'canonical-model', observedAt: '2026-10-23T06:00:00Z',
    pricing: { default: { input: 5, cachedInput: 1, output: 5, cacheWrite: null } },
  }]);
  const runtimeCatalog = captureRuntimePricing();
  const pinned = capture();
  pinned.snapshot.models.push(capture('median-missing').snapshot.models[0]);

  const fact = getMedianPricingFact('copilot', 'median-missing', 0, {
    catalogue: pinned, centralAllowed: true, runtimeCatalog,
  });
  expect(fact.default.input).toBe(3.5);
  expect(fact.metadata.estimate.sources).toContain('provider');
  clearRuntimeModels('copilot');
});

describe('reviewed Copilot pricing projection', () => {
  let fixture;
  let pricing;
  let contract;
  let arithmetic;

  function loadProjection(projection) {
    jest.isolateModules(() => {
      jest.doMock('./model-information.pricing.generated.json', () => projection);
      jest.doMock('./model-information.naming.generated.json', () => ({
        models: [...fixture.reviewed.map(model => ({ identity: model.identity })),
          ...Object.keys(projection).filter(id => !fixture.ids.includes(id)).map(rawId => ({
            identity: { provider: 'copilot', rawId, lookupId: rawId.replace(/[._]/g, '-'),
              key: `copilot/${rawId}` },
          })), {
          identity: { provider: 'copilot', rawId: 'missing-model',
            lookupId: 'missing-model', key: 'copilot/missing-model' },
        }], rules: [],
      }));
      pricing = require('./catalogue-pricing');
      contract = require('./catalogue-contract/pricing-resolution');
      arithmetic = require('./catalogue-contract/exact-pricing');
    });
  }

  beforeEach(() => {
    fixture = require('./test-helpers/copilot-pricing-fixture').reviewedCopilotFixture();
    loadProjection(fixture.projection);
  });

  afterEach(() => {
    jest.dontMock('./model-information.pricing.generated.json');
    jest.dontMock('./model-information.naming.generated.json');
    jest.restoreAllMocks();
  });

  test('resolves four maintained Copilot tariffs without cross-backend imports', () => {
    const time = Date.parse(fixture.capture.retrievedAt);
    for (const model of fixture.reviewed) {
      const id = model.identity.rawId;
      const fact = pricing.getMaintainedPricingFact('copilot', id, { time });
      const selected = contract.selectPricingFact(fact, 0);
      const tariff = model.tariffs.find(item => item.tier === 'default');
      expect(selected).toMatchObject({
        source: 'curated', tier: 'default',
        pricing: Object.fromEntries(Object.entries(tariff.components).map(([field, item]) =>
          [field, typeof item.price === 'object' ? null : Number(item.price)])),
      });
      expect(pricing.getImportedPricingFact('copilot', id)).toBeNull();
      expect(pricing.getImportedPricingFact('copilot', `google/${id}`)).toBeNull();
    }
    const terra = pricing.getMaintainedPricingFact('copilot', 'gpt-6.1-terra');
    expect(contract.selectPricingFact(terra, 272000)).toMatchObject({
      tier: 'default', pricing: { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
    });
    expect(contract.selectPricingFact(terra, 272001)).toMatchObject({
      tier: 'long_context', pricing: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 7.5 },
    });
    expect(pricing.getImportedPricingFact('openrouter', 'google/gemini-3.8-flash')).not.toBeNull();
  });

  test('does not reuse an expired Copilot promo without a verified successor', () => {
    for (const id of ['gemini-3.8-flash', 'gemini-4-argon']) {
      const tariff = fixture.projection[id].tariffs[0];
      const end = Date.parse(tariff.effectiveUntil);
      expect(pricing.getMaintainedPricingFact('copilot', id, { time: end - 1 })).toMatchObject({
        source: 'curated', metadata: { observedAt: fixture.capture.retrievedAt },
      });
      for (const time of [end, end + 1]) {
        expect(pricing.getMaintainedPricingFact('copilot', id, { time })).toBeNull();
      }
      loadProjection({ [id]: fixture.projection[id] });
      expect(pricing.getMedianPricingFact('copilot', 'missing-model', 0, {
        catalogue: { time: end, maxAge: 86400000 }, runtimeCatalog: {}, centralAllowed: false,
      })).toBeNull();
      loadProjection(fixture.projection);
    }
  });

  test('selects a reviewed successor only within its effective interval', () => {
    // Immutable estimated contract tariffs are not successor evidence from the real pricing page.
    const staged = require('./test-helpers/copilot-pricing-fixture').copilotPromotionContractFixture();
    const successor = staged.tariffs.find(tariff => tariff.tier === 'post_promotion');
    const provenance = require('../../shared/model-information/fixtures.v1.json').model.provenance;
    successor.provenance = provenance;
    successor.effectiveUntil = '2027-02-01T00:00:00Z';
    successor.components.input.price = '1.5000000000000000000000000001';
    for (const component of Object.values(successor.components)) component.provenance = provenance;
    loadProjection({ 'gemini-3.8-flash': { tariffs: staged.tariffs } });
    const start = Date.parse(successor.effectiveFrom);
    expect(pricing.getMaintainedPricingFact('copilot', 'gemini-3.8-flash', { time: start - 1 }))
      .toMatchObject({ tier: 'default', metadata: { observedAt: staged.tariffs[0].provenance.at } });
    for (const time of [start, start + 1]) {
      const fact = pricing.getMaintainedPricingFact('copilot', 'gemini-3.8-flash', { time });
      expect(fact).toMatchObject({ tier: 'post_promotion', metadata: {
        observedAt: provenance.at, pricingCatalogId: provenance.source,
      } });
      expect(arithmetic.compare(arithmetic.rate(fact.default, 'input'),
        arithmetic.decimal('1.5000000000000000000000000001'))).toBe(0);
    }
    for (const time of [Date.parse(successor.effectiveUntil), Date.parse(successor.effectiveUntil) + 1]) {
      expect(pricing.getMaintainedPricingFact('copilot', 'gemini-3.8-flash', { time })).toBeNull();
    }
    expect(pricing.getMaintainedPricingFact('copilot', 'gemini-3.8-flash', {
      time: start, scope: { provider: 'copilot', channel: 'copilot-cli' },
    })).toBeNull();
  });

  test('selects dated long-context successors and excludes an expired long tier from median donors', () => {
    // Existing Sol contract rates exercise intervals; these are not new published-price rows.
    const model = structuredClone(require('../../shared/model-information/sources/copilot-main.json')
      .models.find(item => item.identity.rawId === 'gpt-6.1-sol'));
    const boundary = '2027-01-01T00:00:00Z';
    const until = '2027-02-01T00:00:00Z';
    const successorProvenance = require('../../shared/model-information/fixtures.v1.json').model.provenance;
    for (const tariff of model.tariffs) tariff.effectiveUntil = boundary;
    const successors = model.tariffs.map(tariff => ({
      ...structuredClone(tariff), tier: tariff.tier === 'default' ? 'post_promotion' : 'long_context',
      effectiveFrom: boundary, effectiveUntil: until, provenance: successorProvenance,
      components: Object.fromEntries(Object.entries(tariff.components).map(([field, item]) =>
        [field, { ...item, provenance: successorProvenance }])),
    }));
    loadProjection({ 'gpt-6.1-sol': { tariffs: [...model.tariffs, ...successors] } });
    const start = Date.parse(boundary);
    for (const time of [start - 1, start, start + 1]) {
      for (const inputTokens of [272000, 272001]) {
        const fact = pricing.getMaintainedPricingFact('copilot', 'gpt-6.1-sol', { time, inputTokens });
        const selected = contract.selectPricingFact(fact, inputTokens);
        expect(selected.tier).toBe(inputTokens > 272000 ? 'long_context'
          : time < start ? 'default' : 'post_promotion');
        expect(selected.observedAt).toBe(time < start
          ? model.tariffs[0].provenance.at : successorProvenance.at);
      }
    }
    // A surviving base tier must not donate at long context after its long tariff expires.
    successors[0].effectiveUntil = '2027-03-01T00:00:00Z';
    loadProjection({ 'gpt-6.1-sol': { tariffs: [...model.tariffs, ...successors] } });
    const expired = Date.parse(until);
    expect(pricing.getMaintainedPricingFact('copilot', 'gpt-6.1-sol', {
      time: expired, inputTokens: 272001,
    })).toBeNull();
    expect(pricing.getMedianPricingFact('copilot', 'missing-model', 272001, {
      catalogue: { time: expired, maxAge: 86400000 }, runtimeCatalog: {}, centralAllowed: false,
    })).toBeNull();
    expect(pricing.getMaintainedPricingFact('copilot', 'gpt-6.1-sol', {
      time: expired, inputTokens: 272000,
    })).not.toBeNull();
    expect(pricing.getMedianPricingFact('copilot', 'missing-model', 272000, {
      catalogue: { time: expired, maxAge: 86400000 }, runtimeCatalog: {}, centralAllowed: false,
    })).not.toBeNull();
  });

  test('uses the active successor threshold and honors a provider-selected tier', () => {
    const model = structuredClone(require('../../shared/model-information/sources/copilot-main.json')
      .models.find(item => item.identity.rawId === 'gpt-6.1-sol'));
    const boundary = '2027-01-01T00:00:00Z';
    const oldLong = model.tariffs.find(tariff => tariff.tier === 'long_context');
    oldLong.effectiveUntil = boundary;
    const successor = structuredClone(oldLong);
    successor.effectiveFrom = boundary;
    delete successor.effectiveUntil;
    successor.promptTokensAbove = 500000;
    model.tariffs.push(successor);
    loadProjection({ 'gpt-6.1-sol': { tariffs: model.tariffs } });

    const time = Date.parse(boundary);
    const defaultTier = pricing.getMaintainedPricingFact('copilot', 'gpt-6.1-sol', {
      time, inputTokens: 300000, preferredTier: 'default',
    });
    expect(contract.selectPricingFact(defaultTier, 300000, 'default')).toMatchObject({
      tier: 'default', pricing: { input: 2 },
    });
    const automatic = pricing.getMaintainedPricingFact('copilot', 'gpt-6.1-sol', {
      time, inputTokens: 300000,
    });
    expect(contract.selectPricingFact(automatic, 300000)).toMatchObject({
      tier: 'default', pricing: { input: 2 },
    });

    const providerLong = pricing.getMaintainedPricingFact('copilot', 'gpt-6.1-sol', {
      time, inputTokens: 300000, preferredTier: 'long_context',
    });
    expect(providerLong).toBeNull();
  });
});
