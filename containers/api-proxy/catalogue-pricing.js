'use strict';

const { resolveModelIdentity } = require('./model-identity');

const fields = ['input', 'output', 'cachedInput', 'cacheWrite', 'reasoning'];

function fresh(provenance, time, maxAge) {
  const observed = Date.parse(provenance?.at);
  return Number.isFinite(observed) && observed <= time && time - observed <= maxAge &&
    provenance.stale !== true && (!provenance.freshness || provenance.freshness === 'fresh') &&
    (!provenance.freshUntil || Date.parse(provenance.freshUntil) > time);
}

function validateTariffs(snapshot) {
  for (const model of snapshot.models) {
    for (const tariff of model.tariffs || []) {
      if (!['USD_PER_1M_TOKENS', 'USD_PER_TOKEN'].includes(tariff.unit) ||
          !['default', 'long_context', 'post_promotion'].includes(tariff.tier) ||
          Object.keys(tariff.components).some(field => !fields.includes(field)) ||
          ['input', 'output', 'cachedInput', 'cacheWrite'].some(field => !Object.hasOwn(tariff.components, field)) ||
          (tariff.tier === 'long_context' && tariff.promptTokensAbove === undefined) ||
          (tariff.tier !== 'long_context' && tariff.promptTokensAbove !== undefined) ||
          Object.entries(tariff.components).some(([field, item]) =>
            typeof item.price === 'object' ? field !== 'cacheWrite'
              : !Number.isFinite(Number(item.price) * (tariff.unit === 'USD_PER_TOKEN' ? 1e6 : 1)) ||
                (Number(item.price) === 0 && /[1-9]/.test(item.price)))) {
        throw new Error('catalogue_tariff_unsupported');
      }
    }
  }
}

function resolveCentralPricing(provider, model, inputTokens, capture, context = {}) {
  if (!capture) return null;
  // The Copilot adapter's upstream is copilot-api, including calls made by the CLI.
  const channel = context.channel || 'copilot-api';
  if (provider !== 'copilot' || channel !== 'copilot-api') return null;
  const scope = { provider, channel, deployment: context.deployment };
  const requested = resolveModelIdentity(model, provider, {
    scope,
    policy: { providerPrefix: context.nativeInput !== true },
  });
  const records = capture.snapshot.models.filter(entry => {
    if (entry.identity.provider !== provider) return false;
    const canonicalMatch = requested.identity
      ? requested.identity.key === entry.identity.key
      : requested.wireId === entry.identity.rawId;
    // Preserve the v1 pricing-only exact stored lookup spelling, without normalization.
    return canonicalMatch || entry.identity.lookupId === model;
  });
  // Feed identities are authoritative keys, not additional naming inputs.
  const record = records.length === 1 ? records[0] : null;
  if (!record || !fresh(record.provenance, capture.time, capture.maxAge)) return null;
  const scoped = (record.tariffs || []).filter(tariff =>
    tariff.scope.provider === provider && tariff.scope.channel === channel &&
    tariff.scope.deployment === context.deployment);
  const requiresLong = scoped.some(tariff => tariff.tier === 'long_context' &&
    inputTokens > tariff.promptTokensAbove &&
    (!tariff.effectiveFrom || Date.parse(tariff.effectiveFrom) <= capture.time));
  const candidates = scoped.filter(tariff =>
    (!tariff.effectiveFrom || Date.parse(tariff.effectiveFrom) <= capture.time) &&
    (!tariff.effectiveUntil || Date.parse(tariff.effectiveUntil) > capture.time) &&
    fresh(tariff.provenance, capture.time, capture.maxAge) &&
    Object.values(tariff.components).every(item => fresh(item.provenance, capture.time, capture.maxAge)));
  const base = candidates.filter(tariff => tariff.tier !== 'long_context');
  const long = candidates.filter(tariff => tariff.tier === 'long_context' && inputTokens > tariff.promptTokensAbove);
  const selected = requiresLong ? long : base;
  if (selected.length !== 1) return null;
  const tariff = selected[0];
  const pricing = Object.fromEntries(Object.entries(tariff.components).map(([field, item]) => [
    field, typeof item.price === 'object' ? null : Number(item.price) * (tariff.unit === 'USD_PER_TOKEN' ? 1e6 : 1),
  ]));
  return {
    pricing: Object.freeze(pricing), source: 'central_feed', tier: tariff.tier,
    pricingCatalogId: capture.source, pricingCatalogVersion: capture.revision,
    observedAt: tariff.provenance.at,
  };
}

module.exports = { resolveCentralPricing, validateTariffs, fresh };
