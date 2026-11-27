'use strict';

const { normalizeId } = require('./catalogue-contract/identity');
const { stripRedundantProviderPrefix } = require('./model-utils');

const DEFAULT_CODING_TIERS = Object.freeze(
  require('./model-information.coding-tiers.generated.json'),
);

const DEFAULT_TIER_ORDER = Object.freeze([
  'standard',
  'premium',
  'unclassified',
  'lightweight',
  'none',
]);

const ROBUST_TIER_ORDER = Object.freeze([
  'premium',
  'standard',
  'unclassified',
  'lightweight',
  'none',
]);

const VALID_TIERS = new Set(['standard', 'premium', 'lightweight', 'none']);

const EFFORT_LADDER = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const MEDIUM_INDEX = EFFORT_LADDER.indexOf('medium');

const PROVIDER_CANONICAL = Object.freeze({
  copilot: 'github-copilot',
  openai: 'openai',
  anthropic: 'anthropic',
});

function toLookupId(wireModel, provider) {
  if (typeof wireModel !== 'string' || !wireModel) return '';
  const canonical = provider && Object.hasOwn(PROVIDER_CANONICAL, provider)
    ? PROVIDER_CANONICAL[provider]
    : null;
  const bare = canonical ? stripRedundantProviderPrefix(wireModel, canonical) : wireModel;
  const stripped = bare.includes('/') ? bare.slice(bare.indexOf('/') + 1) : bare;
  return normalizeId(stripped, { caseInsensitive: true, separators: true });
}

function getTierOrder(objective) {
  const mode = typeof objective === 'string' ? objective : objective?.mode;
  return mode === 'robust' ? ROBUST_TIER_ORDER : DEFAULT_TIER_ORDER;
}

function lookupTierInfo(wireModel, provider, codingTiers) {
  const lookupId = toLookupId(wireModel, provider);
  const entry = codingTiers && Object.hasOwn(codingTiers, lookupId) ? codingTiers[lookupId] : null;
  const tier = VALID_TIERS.has(entry?.tier) ? entry.tier : 'unclassified';
  const releaseDate = typeof entry?.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDate)
    ? entry.releaseDate
    : null;
  return { tier, releaseDate };
}

function compareEffortPreference(left, right) {
  const leftIndex = typeof left === 'string' ? EFFORT_LADDER.indexOf(left) : -1;
  const rightIndex = typeof right === 'string' ? EFFORT_LADDER.indexOf(right) : -1;
  if (leftIndex === -1 && rightIndex === -1) return 0;
  if (leftIndex === -1) return 1;
  if (rightIndex === -1) return -1;
  const leftDistance = Math.abs(leftIndex - MEDIUM_INDEX);
  const rightDistance = Math.abs(rightIndex - MEDIUM_INDEX);
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  // Higher effort wins on a tie (for example high over low).
  return rightIndex - leftIndex;
}

function selectFallbackEffort(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  const known = efforts.filter(effort => typeof effort === 'string' && EFFORT_LADDER.includes(effort));
  if (known.length === 0) return undefined;
  return [...known].sort(compareEffortPreference)[0];
}

function chooseFallbackChoiceForModel(choices) {
  const sorted = [...choices].sort((left, right) => {
    const effortCmp = compareEffortPreference(left.effort, right.effort);
    if (effortCmp !== 0) return effortCmp;
    const leftId = String(left.id ?? '');
    const rightId = String(right.id ?? '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  return sorted[0];
}

function resolveWireModel(choice, mapping) {
  if (typeof mapping?.wireModel === 'string' && mapping.wireModel) return mapping.wireModel;
  if (typeof choice.model === 'string') {
    return choice.model.includes('/') ? choice.model.slice(choice.model.indexOf('/') + 1) : choice.model;
  }
  return '';
}

/**
 * Order a pool's choices for routing fallback.
 *
 * Returns one choice per model (at medium effort, else nearest offered effort
 * with the higher effort breaking ties, else no effort), ordered by coding
 * tier, newest releaseDate first (undated after dated), and exact wire model ID.
 * Native-provider exact-ID protocol eligibility is already enforced when
 * building the candidate pool.
 *
 * @param {{ choices: Array<object>, byId?: Record<string, object> }} pool
 * @param {{ codingTiers?: Record<string, { tier?: string, releaseDate?: string }>, objective?: string | { mode?: string } }} [options]
 * @returns {ReadonlyArray<{ choice: object, wireModel: string, tier: string, releaseDate: string | null }>}
 */
function orderFallbackChoices(pool, options = {}) {
  const choices = Array.isArray(pool?.choices) ? pool.choices : [];
  const byId = pool?.byId || null;
  const codingTiers = options.codingTiers === undefined ? DEFAULT_CODING_TIERS : options.codingTiers;
  const tierOrder = getTierOrder(options.objective);
  const tierRank = new Map(tierOrder.map((tier, index) => [tier, index]));

  const byWireModel = new Map();
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const mapping = byId && choice.id ? byId[choice.id] : null;
    const wireModel = resolveWireModel(choice, mapping);
    if (!wireModel) continue;
    const provider = mapping?.provider || null;
    if (!byWireModel.has(wireModel)) {
      byWireModel.set(wireModel, { wireModel, provider, choices: [] });
    }
    byWireModel.get(wireModel).choices.push(choice);
  }

  const ordered = [];
  for (const group of byWireModel.values()) {
    const choice = chooseFallbackChoiceForModel(group.choices);
    const { tier, releaseDate } = lookupTierInfo(group.wireModel, group.provider, codingTiers);
    ordered.push(Object.freeze({
      choice,
      wireModel: group.wireModel,
      tier,
      releaseDate,
    }));
  }

  ordered.sort((left, right) => {
    const tierDiff = tierRank.get(left.tier) - tierRank.get(right.tier);
    if (tierDiff !== 0) return tierDiff;
    if (left.releaseDate !== right.releaseDate) {
      if (left.releaseDate === null) return 1;
      if (right.releaseDate === null) return -1;
      return left.releaseDate > right.releaseDate ? -1 : 1;
    }
    return left.wireModel < right.wireModel ? -1 : left.wireModel > right.wireModel ? 1 : 0;
  });

  return Object.freeze(ordered);
}

module.exports = {
  DEFAULT_CODING_TIERS,
  DEFAULT_TIER_ORDER,
  EFFORT_LADDER,
  ROBUST_TIER_ORDER,
  getTierOrder,
  orderFallbackChoices,
  selectFallbackEffort,
  toLookupId,
};
