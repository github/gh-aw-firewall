'use strict';

const { selectAdaptive, validSummary } = require('./adaptive-select');
const { getCatalogueLoader } = require('./catalogue-loader');
const { getModelMultiplierCapBlockState } = require('./guards/max-model-multiplier-guard');
const { resolvePrimaryRank, routingPairName, shortlistPrimaryOptions } = require('./routing-candidates');
const { pinRequestEligibility, proxyEligibilityStore } = require('./model-eligibility');
const { classifyRouting } = require('./routing-classify');
const {
  assertPlanningRequestSize,
  toRouteCandidates,
  validateRouteResponse,
} = require('./routing-contract');
const { createRoutingError, RoutingError, toRoutingFailure } = require('./routing-errors');
const { DEFAULT_CODING_TIERS, orderFallbackChoices } = require('./routing-fallback-order');
const { recordSelection, recordFailure } = require('./routing-observation-records');
const { writeAdaptiveSelection } = require('./routing-persistence');
const { createSystemClock } = require('./routing-planner');
const {
  countCatalogueOverlap, createRoutingStages, deepFreezeJson, mapPlannerFailure, validateRoutingDependencies,
} = require('./routing-stages');

const ROUTING_BOOTSTRAP_TIMEOUT_MS = 90_000;
const ROUTER_PHASE_RESERVE_MS = 5_000;
const CLASSIFIER_ATTEMPT_TIMEOUT_MS = 30_000;
const CLASSIFIER_MAX_ATTEMPTS = 2;
const PURPOSE = 'routing_classification';

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

// Controller-owned reasons written when a valid summary yields to ordinary routing or fallback;
// kept out of ADAPTIVE_REASONS because that list is the pure selector's oracle vocabulary.
const ADAPTIVE_FALLBACK_REASONS = Object.freeze({
  SELECTION_REJECTED: 'selection_rejected',
  ROUTER_FALLBACK: 'router_fallback',
});

function createOrdinaryAdaptiveReceipt({ job, summary }, pair, reason) {
  return {
    event: 'adaptive_selection',
    v: 2,
    workflow: job.workflow,
    run: { id: job.run_id, attempt: job.attempt },
    generation: summary.generation,
    mode: summary.mode,
    scope: summary.scope,
    role: 'ordinary',
    explore_allowed: summary.explore.allowed === true && job.attempt === 1,
    selected: pair,
    ordinary: pair,
    would: null,
    incumbent: { before: summary.incumbent, after: summary.incumbent },
    costs: {},
    concurrency: {
      turn: summary.explore.turn,
      in_flight: summary.explore.in_flight,
      capacity: null,
    },
    reason,
  };
}

function computeRouterDeadline(now, deadline) {
  const remaining = Math.max(0, deadline - now);
  if (remaining <= 1) return deadline;
  const reserve = Math.min(ROUTER_PHASE_RESERVE_MS, Math.max(1, Math.floor(remaining / 4)));
  return Math.max(now + 1, deadline - reserve);
}

function modelEffortPair(choice) {
  return {
    model: choice.model,
    ...(Object.hasOwn(choice, 'effort') ? { effort: choice.effort } : {}),
  };
}

function createSelection(choice, mapping, metadata = {}) {
  const selectionSource = metadata.selectionSource || 'router';
  const fallbackReason = metadata.fallbackReason ?? null;
  const fallbackTier = metadata.fallbackTier ?? null;
  return deepFreezeJson({
    schema: 'awf-routing-selection/v1',
    engine: 'copilot',
    provider: mapping.provider,
    choice: { id: choice.id, ...modelEffortPair(choice) },
    wire_model: mapping.wireModel,
    endpoint: {
      responses: '/responses',
      'chat-completions': '/chat/completions',
      messages: '/v1/messages',
    }[mapping.protocol],
    selection_source: selectionSource,
    fallback_reason: fallbackReason,
    fallback_tier: fallbackTier,
  });
}

function createRoutingController(dependencies) {
  const {
    config,
    planner,
    catalogue,
    policy = {},
    loadConversation,
    executor,
    observer,
    routerIdentity = {},
    clock = createSystemClock(),
    random = Math.random,
    eligibilityStore = proxyEligibilityStore,
    eligibilityScope,
    codingTiers = DEFAULT_CODING_TIERS,
    adaptive,
    priceRoute = () => null,
    writeAdaptiveReceipt = writeAdaptiveSelection,
  } = dependencies;

  let runPromise;

  async function execute(options = {}) {
    const eligibilityRequest = { awfEligibility: eligibilityStore.pin(), awfEligibilityScope: eligibilityScope };
    pinRequestEligibility(eligibilityRequest);
    const startedAt = clock.now();
    const jobDeadline = Number.isFinite(options.jobDeadlineMs) ? options.jobDeadlineMs : Infinity;
    const deadline = Math.min(startedAt + ROUTING_BOOTSTRAP_TIMEOUT_MS, jobDeadline);
    const signal = options.signal;

    const stages = createRoutingStages({ signal, deadline, clock, random });
    const { runPhase } = stages;
    let catalogueOverlap = null;

    try {
      validateRoutingDependencies(dependencies);
      const pool = await stages.getCandidates(catalogue, config, policy, eligibilityRequest);
      const conversation = await stages.getConversation(loadConversation, config.task.conversationFile);

      let rawCapabilities = null;
      let classification = null;
      let successfulClassifier = null;
      let degradedReason = null;
      let actualAttempts = 0;
      let route = null;
      let resolvedTopKRank = null;
      let fallbackReason = null;

      const routerDeadline = computeRouterDeadline(clock.now(), deadline);
      const routerStages = createRoutingStages({ signal, deadline: routerDeadline, clock, random });
      try {
        rawCapabilities = await routerStages.getCapabilities(planner, config, routerIdentity);
        catalogueOverlap = countCatalogueOverlap(rawCapabilities, pool.choices);
        const classified = await classifyRouting({
          conversation, pool, planner, executor, observer, eligibilityRequest,
          callPlanner: routerStages.callPlanner, signal, deadline: routerDeadline, clock,
          attemptTimeoutMs: CLASSIFIER_ATTEMPT_TIMEOUT_MS, maxAttempts: CLASSIFIER_MAX_ATTEMPTS, purpose: PURPOSE,
          onAttempt: count => { actualAttempts = count; },
        });
        ({ classification, successfulClassifier, degradedReason, actualAttempts } = classified);

        const routeRequest = {
          objective: config.objective,
          conversation,
          models: toRouteCandidates(pool),
          ...(classification === null ? {} : { classification }),
        };
        assertPlanningRequestSize(routeRequest);
        deepFreezeJson(routeRequest);

        let rawRoute;
        const routeTrace = Object.freeze({
          attributes: Object.freeze({
            'gh_aw_router.goal': config.objective.goal,
            'gh_aw_router.mode': config.objective.mode,
            'gh_aw_router.classification.present': classification !== null,
          }),
          // Only a response that passes validation contributes a selection.
          describeResult: response => {
            const choice = validateRouteResponse(response, pool.choices).ranked_choices[0];
            return {
              'gh_aw_router.selected.model': choice.model,
              ...(typeof choice.effort === 'string' ? { 'gh_aw_router.selected.effort': choice.effort } : {}),
            };
          },
        });
        try {
          rawRoute = await routerStages.callPlanner(({ signal: phaseSignal, timeoutMs }) =>
            planner.route(routeRequest, { signal: phaseSignal, timeoutMs, trace: routeTrace }));
        } catch (error) {
          mapPlannerFailure(error, 'route');
        }
        route = validateRouteResponse(rawRoute, pool.choices);
        if (config.topK !== undefined) {
          resolvedTopKRank = resolvePrimaryRank(route.ranked_choices, pool);
        }
      } catch (error) {
        if (signal?.aborted) throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
        if (error instanceof RoutingError && error.code === 'routing_timeout' && clock.now() >= deadline) {
          throw error;
        }
        if (error instanceof RoutingError &&
            (ROUTER_FALLBACK_CODES.has(error.code) || SKIPPABLE_CHOICE_GUARD_CODES.has(error.code))) {
          fallbackReason = error.code;
          if (actualAttempts > 0 && degradedReason === null) degradedReason = error.code;
          route = null;
          resolvedTopKRank = null;
        } else {
          throw error;
        }
      }
      // The cap matches native wire IDs, not router IDs.
      const withinModelCap = ({ id }) => {
        const { wireModel, provider } = pool.byId[id];
        return !getModelMultiplierCapBlockState(wireModel, provider);
      };

      const ROUTER_METADATA = Object.freeze({ selectionSource: 'router', fallbackReason: null, fallbackTier: null });
      const checkedChoices = new Map();
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
      const assertActive = () => {
        if (signal?.aborted) throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
        if (clock.now() >= deadline) throw createRoutingError('routing_timeout', 'Model routing exceeded its deadline');
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
              awfEligibilityScope: eligibilityRequest.awfEligibilityScope, awfCatalogue,
            }));
          const passed = { ok: true, choice, selection: candidateSelection };
          checkedChoices.set(choice.id, passed);
          return passed;
        } catch (error) {
          if (error instanceof RoutingError && SKIPPABLE_CHOICE_GUARD_CODES.has(error.code)) {
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

      const hasValidSummary = Boolean(adaptive) && validSummary(adaptive.summary, adaptive.job);
      let winner = null;
      let adaptiveReceipt = null;
      let adaptiveOrdinaryChoice = null;
      if (route && hasValidSummary) {
        // The workflow's evidence chooses among guard-passing pairs; the ordinary pick is the first
        // router choice that passes the same per-model guards used without a summary.
        // A pair the router ranks twice is one candidate, which its first passing choice stands for.
        const byPair = new Map();
        for (const { id } of route.ranked_choices) {
          const entry = pool.byId[id];
          const pair = routingPairName(entry);
          if (byPair.has(pair)) continue;
          const result = await checkChoice(entry.choice, ROUTER_METADATA);
          if (result.ok) byPair.set(pair, result);
        }
        if (byPair.size > 0) {
          assertActive();
          const [ordinaryPair, ordinaryWinner] = byPair.entries().next().value;
          adaptiveOrdinaryChoice = ordinaryWinner.choice;
          const candidateReceipt = selectAdaptive({
            summary: adaptive.summary,
            rank: [...byPair.keys()],
            ordinary: ordinaryPair,
            job: adaptive.job,
            price: (pair, tokens) => (byPair.has(pair)
              ? priceRoute(pool.byId[byPair.get(pair).choice.id], tokens, { catalogue: getPinnedPricingCatalogue() })
              : null),
          });
          const adaptiveWinner = byPair.get(candidateReceipt.selected);
          if (adaptiveWinner) {
            winner = { choice: adaptiveWinner.choice, selection: adaptiveWinner.selection };
            adaptiveReceipt = candidateReceipt;
          }
        }
      }

      if (!winner && route) {
        winner = await selectFirstPassing(route.ranked_choices.map(choice => ({
          choice,
          metadata: ROUTER_METADATA,
        })));
      }

      if (!winner) {
        if (!fallbackReason) fallbackReason = firstChoiceError?.code || 'no_route';
        const effectiveMode = config.objective.mode === 'auto' &&
          classification?.mode && classification.mode !== 'unknown'
          ? classification.mode
          : config.objective.mode;
        const fallbackCandidates = orderFallbackChoices(pool, {
          objective: { ...config.objective, mode: effectiveMode },
          codingTiers,
        });
        winner = await selectFirstPassing(fallbackCandidates.map(entry => ({
          choice: entry.choice,
          metadata: { selectionSource: 'fallback', fallbackReason, fallbackTier: entry.tier },
        })));
      }

      if (!winner) {
        throw firstChoiceError || createRoutingError('no_route', 'No eligible model passed selection guards');
      }

      assertActive();
      const { choice: selectedChoice, selection } = winner;
      if (adaptive) {
        if (!adaptiveReceipt) {
          const winningPair = routingPairName(pool.byId[selectedChoice.id]);
          adaptiveReceipt = hasValidSummary
            ? createOrdinaryAdaptiveReceipt(
              adaptive,
              winningPair,
              route ? ADAPTIVE_FALLBACK_REASONS.SELECTION_REJECTED : ADAPTIVE_FALLBACK_REASONS.ROUTER_FALLBACK,
            )
            : selectAdaptive({
              // Normalize malformed object summaries so invalid_evidence never echoes live binding
              // fields next to incumbent: null.
              summary: adaptive.summary === null || adaptive.summary === undefined ? null : 'invalid',
              rank: [winningPair],
              ordinary: winningPair,
              job: adaptive.job,
              price: () => null,
            });
        }
        adaptiveReceipt = deepFreezeJson(adaptiveReceipt);
        // Recorded before the primary starts, once the final guard has accepted the selection.
        writeAdaptiveReceipt(adaptiveReceipt);
      }

      const useAdaptiveRouteOptions = Boolean(adaptiveReceipt && adaptiveReceipt.role !== 'ordinary');
      let routeOptions;
      if (selection.selection_source === 'router' && config.topK !== undefined && resolvedTopKRank) {
        const startIndex = useAdaptiveRouteOptions
          ? 0
          : resolvedTopKRank.findIndex(choice => choice.id === selectedChoice.id);
        const remainingRank = startIndex >= 0 ? resolvedTopKRank.slice(startIndex) : resolvedTopKRank;
        const permitted = useAdaptiveRouteOptions
          ? remainingRank.filter(choice => checkedChoices.get(choice.id)?.ok === true)
          : remainingRank.filter(choice => checkedChoices.get(choice.id)?.ok !== false && withinModelCap(choice));
        routeOptions = deepFreezeJson({
          ordinaryPick: modelEffortPair(useAdaptiveRouteOptions ? adaptiveOrdinaryChoice : selectedChoice),
          options: shortlistPrimaryOptions(permitted, config.topK).map(modelEffortPair),
        });
      }
      recordSelection(observer, {
        config, selection, classification, successfulClassifier, rawCapabilities, route,
        conversation, degradedReason, actualAttempts, pool, catalogueOverlap, clock, startedAt,
      });

      return Object.freeze({
        ok: true,
        selection,
        ...(routeOptions ? { routeOptions } : {}),
        ...(adaptiveReceipt ? { adaptiveReceipt } : {}),
        degradedClassification: classification === null,
        ...(degradedReason ? { degradedReason } : {}),
      });
    } catch (error) {
      const normalized = error instanceof RoutingError
        ? error
        : createRoutingError('routing_configuration_error', 'Model routing failed before selection');
      const failure = toRoutingFailure(normalized);
      recordFailure(observer, { config, failure, catalogueOverlap, clock, startedAt });
      return Object.freeze({ ok: false, failure });
    }
  }

  return Object.freeze({
    run(options) {
      if (!runPromise) runPromise = execute(options);
      return runPromise;
    },
  });
}

module.exports = {
  CLASSIFIER_ATTEMPT_TIMEOUT_MS,
  CLASSIFIER_MAX_ATTEMPTS,
  PURPOSE,
  ROUTER_PHASE_RESERVE_MS,
  ROUTING_BOOTSTRAP_TIMEOUT_MS,
  createRoutingController,
};
