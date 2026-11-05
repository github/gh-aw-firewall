'use strict';

const components = ['input', 'cachedInput', 'cacheWrite', 'output'];
const exact = require('./exact-pricing');

function reached(sources, name) {
  if (!Object.hasOwn(sources, name)) throw new Error('pricing_resolution_incomplete_sources');
  const source = sources[name];
  const fact = typeof source === 'function' ? source() : source;
  if (fact === undefined) throw new Error('pricing_resolution_invalid_source');
  return fact;
}

function selectPricingFact(fact, tokens, preferredTier) {
  if (!fact) return null;
  const long = !!fact.longContext && (preferredTier
    ? preferredTier === 'long_context' : tokens > fact.threshold);
  let pricing;
  try {
    pricing = exact.rates(long ? fact.longContext : fact.default);
  } catch {
    throw new Error('pricing_resolution_invalid_tariff');
  }
  return {
    ...fact.metadata,
    ...(long ? fact.longMetadata : fact.defaultMetadata),
    pricing,
    source: fact.source,
    tier: long ? 'long_context' : (fact.tier || 'default'),
  };
}

function fresh(provenance, time, maxAge) {
  const at = Date.parse(provenance?.at);
  return Number.isFinite(at) && at <= time && time - at <= maxAge &&
    provenance.stale !== true && (!provenance.freshness || provenance.freshness === 'fresh') &&
    (!provenance.freshUntil || Date.parse(provenance.freshUntil) > time);
}

function resolveCentralTariff(capture, fact) {
  if (!fact || !capture.scope || capture.scope.provider !== 'copilot' ||
      capture.scope.channel !== 'copilot-api') return null;
  const { record, source, revision } = fact;
  const { time, maxAge, inputTokens, scope } = capture;
  if (!record || record.identity.provider !== scope.provider ||
      !fresh(record.provenance, time, maxAge)) return null;
  const scoped = (record.tariffs || []).filter(tariff =>
    tariff.scope.provider === scope.provider && tariff.scope.channel === scope.channel &&
    tariff.scope.deployment === scope.deployment);
  const effective = tariff => !tariff.effectiveFrom || Date.parse(tariff.effectiveFrom) <= time;
  // An expired or stale long tier must not silently fall back to the base tier.
  const requiresLong = scoped.some(tariff => tariff.tier === 'long_context' &&
    inputTokens > tariff.promptTokensAbove && effective(tariff));
  const eligible = scoped.filter(tariff => effective(tariff) &&
    (!tariff.effectiveUntil || Date.parse(tariff.effectiveUntil) > time) &&
    fresh(tariff.provenance, time, maxAge) &&
    Object.values(tariff.components).every(item => fresh(item.provenance, time, maxAge)) &&
    (requiresLong
      ? tariff.tier === 'long_context' && inputTokens > tariff.promptTokensAbove
      : tariff.tier !== 'long_context'));
  if (eligible.length !== 1) return null;
  const tariff = eligible[0];
  return {
    result: {
      source: 'central_feed', tier: tariff.tier,
      pricingCatalogId: source, pricingCatalogVersion: revision,
      observedAt: tariff.provenance.at,
      pricing: exact.fromExact(Object.fromEntries(Object.entries(tariff.components).map(([field, item]) => [
        field, typeof item.price === 'object' ? null :
          exact.multiply(exact.decimal(item.price),
            exact.decimal(tariff.unit === 'USD_PER_TOKEN' ? 1_000_000 : 1)),
      ]))),
    },
    componentSources: Object.fromEntries(Object.entries(tariff.components).map(([field, item]) => [
      field, { source: 'central_feed', tier: tariff.tier, observedAt: item.provenance.at,
        pricingCatalogId: source, pricingCatalogVersion: revision },
    ])),
  };
}

/**
 * Authoritative tariff selection over normalized facts or lazy source readers.
 * Each reached source is read once. Matching remains adapter-owned.
 */
function resolvePricing(capture) {
  const { sources, inputTokens } = capture;
  let result = selectPricingFact(reached(sources, 'operator'), inputTokens);
  if (!result) result = selectPricingFact(reached(sources, 'configured'), inputTokens);
  let componentSources;
  let missingModelPricing = false;
  if (!result) {
    const runtime = selectPricingFact(reached(sources, 'runtime'), inputTokens);
    const completeFreshRuntime = runtime && components.every(field =>
      Object.hasOwn(runtime.pricing, field)) &&
      (capture.time === null || fresh({ at: runtime.observedAt }, capture.time, capture.maxAge));
    if (completeFreshRuntime) {
      result = runtime;
    } else {
      const central = resolveCentralTariff(capture, reached(sources, 'central'));
      result = central?.result || null;
      componentSources = central?.componentSources;
      if (!result) {
        const tokens = runtime ? 0 : inputTokens;
        const preferredTier = runtime?.tier;
        for (const name of ['curated', 'imported', 'selector', 'configuredDefault', 'median', 'sentinel']) {
          if (name === 'configuredDefault') missingModelPricing = true;
          if (name === 'median' && !Object.hasOwn(sources, name)) continue;
          result = selectPricingFact(reached(sources, name), tokens, preferredTier);
          if (result) break;
        }
        if (runtime) {
          const pricing = {};
          componentSources = {};
          for (const field of components) {
            const fromRuntime = Object.hasOwn(runtime.pricing, field);
            const selected = fromRuntime ? runtime : result;
            if (!selected || !Object.hasOwn(selected.pricing, field)) {
              return outcome(capture, null, undefined, missingModelPricing);
            }
            pricing[field] = exact.rate(selected.pricing, field);
            componentSources[field] = componentProvenance(selected);
          }
          if (result?.estimate) {
            const selected = Object.hasOwn(runtime.pricing, 'reasoning') ? runtime : result;
            pricing.reasoning = exact.rate(selected.pricing, 'reasoning');
            componentSources.reasoning = componentProvenance(selected);
          }
          // Keep the historical four-component merge for non-estimate fallbacks.
          result = { ...runtime, pricing: exact.fromExact(pricing),
            ...(result?.estimate ? {
              estimate: result.estimate, accountingPolicy: result.accountingPolicy,
              usedFallbackPricing: true,
            } : {}) };
        }
      }
    }
  }
  return outcome(capture, result, componentSources, missingModelPricing);
}

// Donors are already scope-, freshness- and tier-selected, never policy outputs.
function medianPricingFact(donors, family) {
  const eligible = donors.filter(donor => donor.result &&
    ['operator', 'shared_catalog', 'provider', 'central_feed', 'curated', 'models.dev']
      .includes(donor.result.source));
  const relatives = family ? eligible.filter(donor => donor.family === family) : [];
  const selected = relatives.length ? relatives : eligible;
  if (!selected.length) return null;
  const pricing = {};
  const componentDonors = {};
  for (const field of [...components, 'reasoning']) {
    const values = selected.map(({ result }) => {
      const key = field === 'reasoning' && result.pricing.reasoning === undefined ? 'output' : field;
      return result.pricing[key] == null ? null : exact.rate(result.pricing, key);
    }).filter(value => value !== null).sort(exact.compare);
    componentDonors[field] = values.length;
    if (!values.length) {
      if (field !== 'cacheWrite') return null;
      pricing[field] = null;
      continue;
    }
    const middle = Math.floor(values.length / 2);
    pricing[field] = values.length % 2 ? values[middle]
      : exact.divide(exact.add(values[middle - 1], values[middle]), exact.decimal(2));
  }
  const basis = relatives.length ? 'family' : 'backend';
  return {
    source: 'median_estimate', default: exact.fromExact(pricing),
    metadata: {
      accountingPolicy: `${basis}_median_estimate`, usedFallbackPricing: true,
      estimate: {
        basis, ...(relatives.length && /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(family) ? { family } : {}),
        donorCount: selected.length,
        componentDonors,
        sources: [...new Set(selected.flatMap(donor => [
          donor.result.source,
          ...Object.values(donor.componentSources || {}).map(component => component.source),
        ]))].sort(),
      },
    },
  };
}

function componentProvenance(result) {
  const provenance = { source: result.source, tier: result.tier };
  for (const field of ['observedAt', 'apiVersion', 'pricingCatalogId', 'pricingCatalogVersion', 'estimate']) {
    if (result[field] !== undefined) provenance[field] = result[field];
  }
  return provenance;
}

function outcome(capture, result, componentSources, missingModelPricing) {
  if (result) {
    for (const field of [...components, 'reasoning']) {
      if (field === 'reasoning' && !Object.hasOwn(result.pricing, field)) continue;
      const value = result.pricing[field];
      if (field === 'cacheWrite' && value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('pricing_resolution_invalid_tariff');
      }
    }
  }
  return {
    identity: capture.identity,
    scope: capture.scope,
    capturedAt: capture.time,
    result,
    missingModelPricing,
    componentSources: componentSources || Object.fromEntries(
      Object.keys(result?.pricing || {}).filter(field => field !== 'threshold').map(field => [
        field, componentProvenance(result),
      ]),
    ),
  };
}

module.exports = { resolvePricing, selectPricingFact, resolveCentralTariff, fresh, medianPricingFact };
