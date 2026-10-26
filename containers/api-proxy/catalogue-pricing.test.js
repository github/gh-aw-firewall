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

const { resolveCentralPricing } = require('./catalogue-pricing');
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
