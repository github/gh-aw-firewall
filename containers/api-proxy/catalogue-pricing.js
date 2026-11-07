'use strict';

const { resolveModelIdentity } = require('./model-identity');
const { resolveCentralTariff, resolvePricing, selectPricingFact, medianPricingFact, fresh } =
  require('./catalogue-contract/pricing-resolution');
const { resolveIdentity } = require('./catalogue-contract/resolution');
const { identity, normalizeId } = require('./catalogue-contract/identity');
const { createHash } = require('node:crypto');
const exact = require('./catalogue-contract/exact-pricing');
const maintainedPricing = require('./model-information.pricing.generated.json');
const fallbackPricing = require('./model-information.fallback-pricing.generated.json');
const naming = require('./model-information.naming.generated.json');
const retired = require('./model-information.retired.generated.json');
const { getProviderPricingFact, getProviderPricingModelIds } = require('./provider-pricing-overlays');
const { getConfiguredPricingFact, getConfiguredPricingModelIds } = require('./model-pricing-catalog');
const { getRuntimePricingFact, captureRuntimePricing, getRuntimePricingCaptureTime } =
  require('./runtime-model-catalog');

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

function getMaintainedPricingFact(provider, model, context = {}) {
  const compatibility = !maintainedPrices.has(provider);
  const index = (compatibility ? compatibilityPrices : maintainedPrices).get(provider);
  if (!index) return null;
  const requested = resolveModelIdentity(model, provider, { policy: { providerPrefix: false } });
  const pricing = findBundledPrice(provider, requested.wireId, index, {
    // This is the curated source's historical spelling policy, not wire naming.
    separators: true, stripDate: true,
  });
  if (!pricing) return null;
  if (pricing.tariffs) {
    const scope = context.scope || { provider, channel: 'copilot-api' };
    const time = context.time ?? Date.now();
    const tokens = context.inputTokens ?? 0;
    const scoped = pricing.tariffs.filter(tariff =>
      tariff.scope.provider === scope.provider && tariff.scope.channel === scope.channel &&
      tariff.scope.deployment === scope.deployment);
    const effective = tariff => !tariff.effectiveFrom || Date.parse(tariff.effectiveFrom) <= time;
    const active = scoped.filter(tariff => effective(tariff) &&
      (!tariff.effectiveUntil || Date.parse(tariff.effectiveUntil) > time));
    const base = active.filter(tariff => tariff.tier !== 'long_context');
    const long = active.filter(tariff => tariff.tier === 'long_context');
    const eligibleLong = long.filter(tariff => tokens > tariff.promptTokensAbove);
    const expiredLong = scoped.filter(tariff => tariff.tier === 'long_context' &&
      effective(tariff) && tariff.effectiveUntil && Date.parse(tariff.effectiveUntil) <= time);
    const requiresLong = context.preferredTier === 'long_context' ||
      (context.preferredTier !== 'default' &&
        (long.length ? eligibleLong.length > 0 :
          expiredLong.some(tariff => tokens > tariff.promptTokensAbove)));
    if ((requiresLong ? eligibleLong : base).length !== 1) return null;
    const selected = base.length === 1 ? base[0] : eligibleLong[0];
    const rates = tariff => exact.rates(Object.fromEntries(Object.entries(tariff.components)
      .map(([field, item]) => [field, typeof item.price === 'object' ? null : item.price])));
    const metadata = tariff => ({
      pricingCatalogVersion: fallbackPricing.catalogRevision,
      pricingCatalogId: tariff.provenance.source,
      observedAt: tariff.provenance.at,
    });
    return {
      source: 'curated', tier: selected.tier,
      default: rates(selected), metadata: metadata(selected),
      ...(base.length === 1 && long.length === 1 ? {
        longContext: rates(long[0]), threshold: long[0].promptTokensAbove,
        longMetadata: metadata(long[0]),
      } : {}),
    };
  }
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

function validateConvertedTariffPrice(price, unit) {
  try {
    const parsed = exact.decimal(price);
    const converted = unit === 'USD_PER_TOKEN'
      ? exact.multiply(parsed, exact.decimal(1_000_000)) : parsed;
    exact.fromExact({ input: converted });
  } catch {
    throw new Error('catalogue_tariff_unsupported');
  }
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
          Object.entries(tariff.components).some(([field, item]) => {
            if (typeof item.price === 'object') return field !== 'cacheWrite';
            validateConvertedTariffPrice(item.price, tariff.unit);
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

function getMedianPricingFact(provider, model, inputTokens, options = {}) {
  if (!provider || model === 'unknown' || model.toLowerCase() === 'auto') return null;
  const scope = options.scope || {
    provider, channel: provider === 'copilot' ? 'copilot-api' : 'native-api',
  };
  const catalogue = options.centralAllowed ? options.catalogue : null;
  const runtime = options.runtimeCatalog || captureRuntimePricing();
  const runtimeTime = getRuntimePricingCaptureTime(runtime, provider);
  const time = options.catalogue?.time ?? runtimeTime;
  const maxAge = options.catalogue?.maxAge ?? 30 * 24 * 3600 * 1000;
  const declared = new Map(naming.models.map(record => [record.identity.key, record]));
  const models = new Map(declared);
  for (const record of catalogue?.snapshot.models || []) {
    // Feed family evidence may enrich pricing, but feed aliases cannot extend naming policy.
    const bundled = declared.get(record.identity.key);
    models.set(record.identity.key, { ...record, identity: {
      ...record.identity, family: record.identity.family ?? bundled?.identity.family,
      aliases: bundled?.identity.aliases || [],
    } });
  }
  const view = { models: [...models.values()], rules: naming.rules };
  const resolve = id => resolveIdentity(id, scope, view, {
    providerPrefix: false, caseInsensitive: true,
  });
  const requested = resolve(model);
  if (!requested.identity) return null;
  const family = resolved => resolved.family === undefined ? undefined
    : normalizeId(resolved.family, { caseInsensitive: true, separators: true });
  const ids = new Set([
    ...getProviderPricingModelIds(provider), ...getConfiguredPricingModelIds(provider),
    ...(runtime[provider] || []).map(record => record.id),
    ...(catalogue?.snapshot.models || []).filter(record => record.identity.provider === provider)
      .map(record => record.identity.rawId),
    ...Object.keys(maintainedPrices.get(provider)?.records ||
      compatibilityPrices.get(provider)?.records || {}),
    ...Object.keys(fallbackPricing.imported[provider] || {}),
  ]);
  const identities = new Map();
  for (const id of [...ids].sort()) {
    if (id === 'unknown' || id.toLowerCase() === 'auto') continue;
    const resolved = resolve(id);
    if (!resolved.identity) continue;
    let group = identities.get(resolved.identity.key);
    if (!group) {
      group = { resolved, ids: [] };
      identities.set(resolved.identity.key, group);
    }
    group.ids.push(id);
  }
  const donors = [];
  for (const { resolved, ids: sourceIds } of identities.values()) {
    const canonical = resolved.identity.rawId;
    sourceIds.sort((a, b) => (a === canonical ? -1 : b === canonical ? 1 : a.localeCompare(b)));
    const records = (catalogue?.snapshot.models || []).filter(record =>
      record.identity.key === resolved.identity.key);
    if ((provider === 'copilot' && Object.hasOwn(retired, canonical)) ||
        records.some(record => ['retired', 'removed'].includes(record.lifecycle?.status))) continue;
    const firstSource = getter => {
      for (const id of sourceIds) {
        const fact = getter(id);
        if (fact) return fact;
      }
      return null;
    };
    let runtimeFact;
    const resolution = resolvePricing({
      identity: resolved.identity, scope, inputTokens, time, runtimeTime, maxAge,
      allowMissingCacheWrite: true, sources: {
        operator: () => firstSource(id => getProviderPricingFact(provider, id, { preserveNamespace: true })),
        configured: () => firstSource(id => getConfiguredPricingFact(provider, id, { preserveNamespace: true })),
        runtime: () => {
          const fact = firstSource(id => getRuntimePricingFact(provider, id, runtime));
          runtimeFact = fact;
          const selected = selectPricingFact(fact, inputTokens);
          // Donors cannot reuse the historical stale-provider merge behavior.
          return selected && fresh({ at: selected.observedAt }, runtimeTime, maxAge) ? fact : null;
        },
        central: () => firstSource(id => getCentralPricingFact(provider, id, catalogue, {
          ...scope, nativeInput: true,
        })),
        curated: () => firstSource(id => getMaintainedPricingFact(provider, id, {
          scope, time, inputTokens, preferredTier: runtimeFact?.tier,
        })),
        imported: () => firstSource(id => getImportedPricingFact(provider, id)),
        selector: null, configuredDefault: null, median: null, sentinel: null,
      },
    });
    if (resolution.result) donors.push({
      key: resolved.identity.key, result: resolution.result, family: family(resolved),
      componentSources: resolution.componentSources,
    });
  }
  const fact = medianPricingFact(donors, family(requested));
  if (!fact) return null;
  const selected = fact.metadata.estimate.basis === 'family'
    ? donors.filter(donor => donor.family === family(requested)) : donors;
  const fingerprint = selected.map(({ key, result, componentSources }) => [
    key, result.source, result.tier, result.pricingCatalogId, result.pricingCatalogVersion,
    result.observedAt, componentSources, Object.keys(result.pricing).filter(field => field !== 'threshold')
      .sort().map(field => {
        const price = exact.rate(result.pricing, field);
        return [field, price === null ? null : `${price.n}/${price.d}`];
      }),
  ]);
  fact.metadata.pricingCatalogId = 'same_backend_median_v1';
  fact.metadata.pricingCatalogVersion = createHash('sha256')
    .update(JSON.stringify([scope, family(requested), fact.metadata.estimate.basis, fingerprint])).digest('hex');
  fact.metadata.estimate.tariffFingerprint = fact.metadata.pricingCatalogVersion;
  return fact;
}

module.exports = {
  getCentralPricingFact, resolveCentralPricing, validateTariffs, fresh,
  getMaintainedPricingFact, getImportedPricingFact,
  getMedianPricingFact,
};
