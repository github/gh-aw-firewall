'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const { sourceFiles, targetFile, planCopilotPricing } =
  require('../../../scripts/model-information/copilot-pricing.cjs');
const { documentText } = require('../../../scripts/model-information/maintain.cjs');
const capture = require('../../../scripts/model-information/fixtures/copilot-pricing-2026-11-06.capture.json');
const ids = ['gpt-6.1-terra', 'gemini-3.8-flash', 'gemini-4-argon', 'mai-code-1.1-flash'];

function reviewedCopilotFixture() {
  const documents = Object.fromEntries([...sourceFiles, targetFile].map(file => [
    file, JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')),
  ]));
  // Replay captured evidence independently of later data-only additions and their capture dates.
  for (const file of sourceFiles) {
    documents[file].models = documents[file].models.filter(model => !ids.includes(model.identity.rawId));
  }
  const bytes = item => {
    const fragment = fs.readFileSync(path.join(root, 'scripts/model-information/fixtures', item.file));
    if (createHash('sha256').update(fragment).digest('hex') !== item.fragmentSha256) {
      throw new Error(`Copilot fixture fragment hash mismatch: ${item.id}`);
    }
    return fragment;
  };
  const [pricing, models] = capture.sources;
  const plan = planCopilotPricing(documents, pricing, models, bytes(pricing), bytes(models), documentText);
  const reviewed = sourceFiles.flatMap(file => (plan.updates.get(file) || documents[file]).models)
    .filter(model => ids.includes(model.identity.rawId));
  const rates = tariff => Object.fromEntries(Object.entries(tariff.components)
    .map(([field, item]) => [field, typeof item.price === 'object' ? null : item.price]));
  const projection = Object.fromEntries(reviewed.map(model => {
    const dated = model.tariffs.some(tariff => tariff.effectiveFrom || tariff.effectiveUntil);
    const base = model.tariffs.find(tariff => tariff.tier === 'default');
    const long = model.tariffs.find(tariff => tariff.tier === 'long_context');
    return [model.identity.rawId, dated ? { tariffs: model.tariffs } : {
      ...rates(base), ...(long ? { longContext: {
        ...rates(long), threshold: long.promptTokensAbove,
      } } : {}),
    }];
  }));
  return { plan, reviewed, projection, capture: pricing, ids };
}

function copilotPromotionContractFixture() {
  const { tariff, provenance } =
    require('../../../scripts/model-information/fixtures/copilot-promotion-contract.v1.json');
  const components = prices => Object.fromEntries(['input', 'cachedInput', 'cacheWrite', 'output']
    .map((field, index) => [field, {
      price: prices[index] === null ? { unavailable: true } : String(prices[index]),
      provenance: structuredClone(provenance),
    }]));
  const base = {
    scope: { provider: 'copilot', channel: 'copilot-api' },
    currency: 'USD', unit: 'USD_PER_1M_TOKENS', tier: 'default',
    components: components(tariff.default), provenance: structuredClone(provenance),
    promotion: 'promotional rate per #10029', effectiveUntil: tariff.promotionUntil,
    successor: 'post_promotion',
  };
  return {
    schemaVersion: 1,
    identity: { provider: 'copilot', rawId: 'gemini-3.8-flash',
      key: 'copilot/gemini-3.8-flash', lookupId: 'gemini-3-8-flash' },
    lifecycle: { status: 'active' }, modelType: 'completion', provenance: structuredClone(provenance),
    tariffs: [base, {
      scope: { ...base.scope }, currency: base.currency, unit: base.unit,
      tier: 'post_promotion', effectiveFrom: tariff.promotionUntil,
      components: components(tariff.successor), provenance: structuredClone(provenance),
    }],
  };
}

module.exports = { reviewedCopilotFixture, copilotPromotionContractFixture };
