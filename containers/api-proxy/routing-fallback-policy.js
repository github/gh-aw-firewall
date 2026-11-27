'use strict';

const { getCatalogueLoader } = require('./catalogue-loader');
const { getModelMultiplierCapBlockState } = require('./guards/max-model-multiplier-guard');
const { createRoutingError, RoutingError } = require('./routing-errors');
const { orderFallbackChoices } = require('./routing-fallback-order');
const { createSelection } = require('./routing-selection-receipts');

const ROUTER_FALLBACK_CODES = new Set([
  'no_route',
  'router_unavailable',
  'routing_contract_error',
  'routing_configuration_error',
  'routing_timeout',
]);

const SKIPPABLE_CHOICE_GUARD_CODES = new Set([
  'model_multiplier_cap_exceeded',
  'model_multiplier_cap_unverifiable',
  'pricing_resolution_error',
  'retired_model',
  'model_policy_violation',
  'no_route',
]);

const ROUTER_METADATA = Object.freeze({ selectionSource: 'router', fallbackReason: null, fallbackTier: null });

function resolveRouterFallback(error, { signal, clock, deadline }) {
  if (signal?.aborted) throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
  if (error instanceof RoutingError && error.code === 'routing_timeout' && clock.now() >= deadline) {
    throw error;
  }
  if (error instanceof RoutingError &&
      (ROUTER_FALLBACK_CODES.has(error.code) || SKIPPABLE_CHOICE_GUARD_CODES.has(error.code))) {
    return error.code;
  }
  throw error;
}

function createFallbackCandidates(pool, { objective, classification, codingTiers, fallbackReason }) {
  const effectiveMode = objective.mode === 'auto' &&
    classification?.mode && classification.mode !== 'unknown'
    ? classification.mode
    : objective.mode;
  return orderFallbackChoices(pool, {
    objective: { ...objective, mode: effectiveMode },
    codingTiers,
  }).map(entry => ({
    choice: entry.choice,
    metadata: { selectionSource: 'fallback', fallbackReason, fallbackTier: entry.tier },
  }));
}

// The cap matches native wire IDs, not router IDs.
function withinModelCap({ id }, pool) {
  const { wireModel, provider } = pool.byId[id];
  return !getModelMultiplierCapBlockState(wireModel, provider);
}

function createGuardedSelection({ pool, executor, runPhase, eligibilityRequest, assertActive }) {
  const checkedChoices = new Map();
  const pricingCache = new Map();
  let firstChoiceError = null;
  let pinnedPricingCatalogue;
  let hasPinnedPricingCatalogue = false;
  const getPinnedPricingCatalogue = () => {
    if (!hasPinnedPricingCatalogue) {
      pinnedPricingCatalogue = getCatalogueLoader().capture();
      hasPinnedPricingCatalogue = true;
    }
    return pinnedPricingCatalogue;
  };

  async function checkChoice(choice, metadata) {
    if (checkedChoices.has(choice.id)) {
      return checkedChoices.get(choice.id);
    }
    const candidateSelection = createSelection(choice, pool.byId[choice.id], metadata);
    const awfCatalogue = getPinnedPricingCatalogue();
    try {
      await runPhase(({ signal: phaseSignal }) =>
        executor.checkBeforePrimary({
          selection: candidateSelection, signal: phaseSignal, awfEligibility: eligibilityRequest.awfEligibility,
          awfEligibilityScope: eligibilityRequest.awfEligibilityScope, awfCatalogue, awfPricingCache: pricingCache,
        }));
      const passed = { ok: true, choice, selection: candidateSelection };
      checkedChoices.set(choice.id, passed);
      return passed;
    } catch (error) {
      if (error instanceof RoutingError && SKIPPABLE_CHOICE_GUARD_CODES.has(error.code)) {
        assertActive();
        firstChoiceError ||= error;
        const rejected = { ok: false, error };
        checkedChoices.set(choice.id, rejected);
        return rejected;
      }
      throw error;
    }
  }

  async function selectFirstPassing(candidates) {
    for (const { choice, metadata } of candidates) {
      if (checkedChoices.has(choice.id)) continue;
      const result = await checkChoice(choice, metadata);
      if (result.ok) return { choice: result.choice, selection: result.selection };
    }
    return null;
  }

  return {
    checkedChoices,
    checkChoice,
    selectFirstPassing,
    getPinnedPricingCatalogue,
    getFirstChoiceError: () => firstChoiceError,
  };
}

module.exports = {
  ROUTER_METADATA,
  createFallbackCandidates,
  createGuardedSelection,
  resolveRouterFallback,
  withinModelCap,
};
