'use strict';

const { resolveModelIdentity } = require('./model-identity');
const { resolveCentralTariff, fresh } = require('./catalogue-contract/pricing-resolution');

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
          Object.entries(tariff.components).some(([field, item]) =>
            typeof item.price === 'object' ? field !== 'cacheWrite'
              : !Number.isFinite(Number(item.price) * (tariff.unit === 'USD_PER_TOKEN' ? 1e6 : 1)) ||
                (Number(item.price) === 0 && /[1-9]/.test(item.price)))) {
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

module.exports = { getCentralPricingFact, resolveCentralPricing, validateTariffs, fresh };
