'use strict';

const curatedPricing = require('./ai-credits-pricing');
const referenceCatalog = require('./ai-credits-pricing-reference.json');

const RATE_FIELDS = ['input', 'cachedInput', 'cacheWrite', 'output'];
const LONG_CONTEXT_RATE_FIELDS = [...RATE_FIELDS, 'reasoning'];

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
      const referenceRate = rate === 'cachedInput' && referencePrice[rate] === undefined
        ? 0
        : referencePrice[rate];
      if (curatedPrice[rate] !== referenceRate) {
        mismatches.push(
          `${model} ${rate}: curated ${curatedPrice[rate]}, reference ${referenceRate}`,
        );
      }
    }

    if (curatedPrice.longContext) {
      const curatedTier = curatedPrice.longContext;
      const referenceTier = referencePrice.longContext;
      if (!referenceTier) {
        mismatches.push(`${model} longContext: missing from reference`);
        continue;
      }
      if (curatedTier.threshold !== referenceTier.threshold) {
        mismatches.push(
          `${model} longContext threshold: curated ${curatedTier.threshold}, reference ${referenceTier.threshold}`,
        );
      }
      for (const rate of LONG_CONTEXT_RATE_FIELDS) {
        const referenceRate = rate === 'cachedInput' && referenceTier[rate] === undefined
          ? 0
          : referenceTier[rate];
        if (curatedTier[rate] !== referenceRate) {
          mismatches.push(
            `${model} longContext ${rate}: curated ${curatedTier[rate]}, reference ${referenceRate}`,
          );
        }
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

  it('compares curated long-context thresholds and rates with the reference', () => {
    const changedPricing = {
      ...curatedPricing,
      'claude-haiku-5-5': {
        ...curatedPricing['claude-haiku-5-5'],
        longContext: {
          ...curatedPricing['claude-haiku-5-5'].longContext,
          output: 3,
        },
      },
    };

    expect(() => assertCuratedPricingMatchesReference(changedPricing))
      .toThrow('claude-haiku-5-5 longContext output: curated 3, reference 2.5');
  });
});
