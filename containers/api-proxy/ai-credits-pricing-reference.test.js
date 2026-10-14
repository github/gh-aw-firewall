'use strict';

const curatedPricing = require('./ai-credits-pricing');
const referenceCatalog = require('./ai-credits-pricing-reference.json');

const RATE_FIELDS = ['input', 'cachedInput', 'cacheWrite', 'output'];

function findReferencePrice(model) {
  for (const provider of Object.values(referenceCatalog.providers)) {
    if (provider.models[model]) return provider.models[model];
  }
  return null;
}

function compareCuratedPricing(curated) {
  const mismatches = [];
  const unreferencedModels = [];

  for (const [model, curatedPrice] of Object.entries(curated)) {
    const referencePrice = findReferencePrice(model);
    if (!referencePrice) {
      unreferencedModels.push(model);
      continue;
    }

    for (const rate of RATE_FIELDS) {
      if (curatedPrice[rate] !== referencePrice[rate]) {
        mismatches.push(
          `${model} ${rate}: curated ${curatedPrice[rate]}, reference ${referencePrice[rate]}`,
        );
      }
    }
  }

  return { mismatches, unreferencedModels };
}

function assertCuratedPricingMatchesReference(curated) {
  const { mismatches, unreferencedModels } = compareCuratedPricing(curated);
  if (mismatches.length > 0) {
    throw new Error(`Curated AI-credit prices differ from reference:\n${mismatches.join('\n')}`);
  }
  return unreferencedModels;
}

describe('curated AI-credit pricing reference', () => {
  it('every curated entry matches the reference price', () => {
    const unreferencedModels = assertCuratedPricingMatchesReference(curatedPricing);

    if (unreferencedModels.length > 0) {
      console.log(`Curated models without reference prices: ${unreferencedModels.join(', ')}`);
    }
  });

  it('reports the model and rate when a curated entry differs from the reference', () => {
    const changedPricing = {
      ...curatedPricing,
      'claude-sonnet-5': { ...curatedPricing['claude-sonnet-5'], output: 15 },
    };

    expect(() => assertCuratedPricingMatchesReference(changedPricing))
      .toThrow('claude-sonnet-5 output: curated 15, reference 10');
  });
});
