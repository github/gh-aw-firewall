'use strict';

const { resolveModelIdentity } = require('./model-identity');
const { resolveCentralTariff, fresh } = require('./catalogue-contract/pricing-resolution');
const { resolveIdentity } = require('./catalogue-contract/resolution');
const { identity } = require('./catalogue-contract/identity');
const exact = require('./catalogue-contract/exact-pricing');
const maintainedPricing = require('./model-information.pricing.generated.json');
const fallbackPricing = require('./model-information.fallback-pricing.generated.json');

function indexPrices(providers) {
  return new Map(Object.entries(providers).map(([provider, records]) => [provider, {
    records,
    models: Object.keys(records).map(rawId => ({ identity: identity(provider, rawId) })),
  }]));
}

const maintainedPrices = indexPrices({ copilot: maintainedPricing });
const compatibilityPrices = indexPrices(fallbackPricing.compatibility.providers);
const importedPrices = new Map(Object.entries(fallbackPricing.imported).map(([backend, records]) => {
  const namespaces = Object.create(null);
  for (const [qualifiedId, pricing] of Object.entries(records)) {
    const slash = qualifiedId.indexOf('/');
    const namespace = qualifiedId.slice(0, slash);
    namespaces[namespace] ??= Object.create(null);
    namespaces[namespace][qualifiedId.slice(slash + 1)] = pricing;
  }
  return [backend, indexPrices(namespaces)];
}));

function findBundledPrice(provider, model, index, policy = {}) {
  if (!index || typeof model !== 'string') return null;
  const resolved = resolveIdentity(model, {
    provider, channel: provider === 'copilot' ? 'copilot-api' : 'native-api',
  }, index, { providerPrefix: false, ...policy });
  return resolved.matchKind === 'unmatched' ? null : index.records[resolved.identity.rawId];
}

function getMaintainedPricingFact(provider, model) {
  const compatibility = !maintainedPrices.has(provider);
  const index = (compatibility ? compatibilityPrices : maintainedPrices).get(provider);
  if (!index) return null;
  const requested = resolveModelIdentity(model, provider, { policy: { providerPrefix: false } });
  const pricing = findBundledPrice(provider, requested.wireId, index, {
    // This is the curated source's historical spelling policy, not wire naming.
    separators: true, stripDate: true,
  });
  if (!pricing) return null;
  const { longContext, ...defaultPricing } = pricing;
  const { threshold, ...longPrices } = longContext || {};
  return { source: 'curated', default: exact.rates(defaultPricing),
    metadata: { pricingCatalogVersion: fallbackPricing.catalogRevision,
      ...(compatibility ? { pricingCatalogId: fallbackPricing.compatibility.policy } : {}) },
    ...(longContext ? { longContext: longPrices, threshold } : {}) };
}

function getImportedPricingFact(provider, model) {
  if (typeof model !== 'string' || !model.includes('/')) return null;
  const slash = model.indexOf('/');
  const namespace = model.slice(0, slash);
  const imported = findBundledPrice(namespace, model.slice(slash + 1),
    importedPrices.get(provider)?.get(namespace), {
    separators: true, stripDate: true,
  });
  if (!imported) return null;
  if (imported.currency !== 'USD' || imported.unit !== 'USD_PER_1M_TOKENS' ||
      imported.sourceNamespace !== namespace) throw new Error('catalogue_tariff_unsupported');
  const pricing = Object.fromEntries(Object.entries(imported.components).map(([field, item]) => {
    if (typeof item.price === 'object') return [field, null];
    return [field, exact.decimal(item.price)];
  }));
  // Retain the explicit legacy missing-cache policy; zero is a supplied price.
  if (!Object.hasOwn(pricing, 'cachedInput')) {
    pricing.cachedInput = exact.multiply(pricing.input, exact.decimal('0.1'));
  }
  if (!Object.hasOwn(pricing, 'cacheWrite')) pricing.cacheWrite = null;
  return { source: 'models.dev', default: exact.fromExact(pricing), metadata: {
    pricingCatalogId: imported.provenance.source,
    pricingCatalogVersion: imported.provenance.revision,
    observedAt: imported.provenance.at,
  } };
}

const fields = ['input', 'output', 'cachedInput', 'cacheWrite', 'reasoning'];

function validateTariffs(snapshot) {
  for (const model of snapshot.models) {
    for (const tariff of model.tariffs || []) {
      if (!['USD_PER_1M_TOKENS', 'USD_PER_TOKEN'].includes(tariff.unit) ||
          !['default', 'long_context', 'post_promotion'].includes(tariff.tier) ||
          Object.keys(tariff.components).some(field => !fields.includes(field)) ||
          ['input', 'output', 'cachedInput', 'cacheWrite'].some(field => !Object.hasOwn(tariff.components, field)) ||
          (tariff.tier === 'long_context' && tariff.promptTokensAbove === undefined) ||
          (tariff.tier !== 'long_context' && tariff.promptTokensAbove !== undefined) ||
          Object.entries(tariff.components).some(([field, item]) => {
            if (typeof item.price === 'object') return field !== 'cacheWrite';
            exact.decimal(item.price);
            return false;
          })) {
        throw new Error('catalogue_tariff_unsupported');
      }
    }
  }
}

function getCentralPricingFact(provider, model, capture, context = {}) {
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
  return { record, source: capture.source, revision: capture.revision };
}

function resolveCentralPricing(provider, model, inputTokens, capture, context = {}) {
  const fact = getCentralPricingFact(provider, model, capture, context);
  if (!fact) return null;
  const selected = resolveCentralTariff({
    scope: { provider, channel: context.channel || 'copilot-api', deployment: context.deployment },
    inputTokens, time: capture.time, maxAge: capture.maxAge,
  }, fact);
  return selected ? { ...selected.result, pricing: Object.freeze(selected.result.pricing) } : null;
}

module.exports = {
  getCentralPricingFact, resolveCentralPricing, validateTariffs, fresh,
  getMaintainedPricingFact, getImportedPricingFact,
};
