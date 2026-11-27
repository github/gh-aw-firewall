'use strict';

const { selectAdaptive, validSummary } = require('./adaptive-select');
const { routingPairName, shortlistPrimaryOptions } = require('./routing-candidates');
const { pinRequestEligibility, proxyEligibilityStore } = require('./model-eligibility');
const { classifyRouting } = require('./routing-classify');
const {
  CLASSIFIER_ATTEMPT_TIMEOUT_MS, CLASSIFIER_MAX_ATTEMPTS, PURPOSE,
  ROUTER_PHASE_RESERVE_MS, computeRouterDeadline,
} = require('./routing-classifier-attempts');
const { createRoutingError, RoutingError, toRoutingFailure } = require('./routing-errors');
const { DEFAULT_CODING_TIERS } = require('./routing-fallback-order');
const {
  ROUTER_METADATA, createFallbackCandidates, createGuardedSelection, resolveRouterFallback, withinModelCap,
} = require('./routing-fallback-policy');
const { recordSelection, recordFailure } = require('./routing-observation-records');
const { writeAdaptiveSelection } = require('./routing-persistence');
const { createSystemClock } = require('./routing-planner');
const { finalizeAdaptiveReceipt, modelEffortPair, resolveAdaptiveLevel } = require('./routing-selection-receipts');
const {
  countCatalogueOverlap, createRoutingStages, deepFreezeJson, validateRoutingDependencies,
} = require('./routing-stages');

const ROUTING_BOOTSTRAP_TIMEOUT_MS = 90_000;

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

        ({ route, resolvedTopKRank } = await routerStages.getRoute(planner, config, pool, conversation, classification));
      } catch (error) {
        fallbackReason = resolveRouterFallback(error, { signal, clock, deadline });
        if (actualAttempts > 0 && degradedReason === null) degradedReason = error.code;
        route = null;
        resolvedTopKRank = null;
      }
      const assertActive = () => {
        if (signal?.aborted) throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
        if (clock.now() >= deadline) throw createRoutingError('routing_timeout', 'Model routing exceeded its deadline');
      };

      const {
        checkedChoices, checkChoice, selectFirstPassing, getPinnedPricingCatalogue, getFirstChoiceError,
      } = createGuardedSelection({ pool, executor, runPhase, eligibilityRequest, assertActive });

      const adaptiveLevel = adaptive
        ? resolveAdaptiveLevel(adaptive.summary, config.objective.mode, classification)
        : undefined;
      const hasValidSummary = Boolean(adaptive) && validSummary(adaptive.summary, adaptive.job, adaptiveLevel);
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
            level: adaptiveLevel,
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
        if (!fallbackReason) fallbackReason = getFirstChoiceError()?.code || 'no_route';
        winner = await selectFirstPassing(createFallbackCandidates(pool, {
          objective: config.objective, classification, codingTiers, fallbackReason,
        }));
      }

      if (!winner) {
        throw getFirstChoiceError() || createRoutingError('no_route', 'No eligible model passed selection guards');
      }

      assertActive();
      const { choice: selectedChoice, selection } = winner;
      if (adaptive) {
        adaptiveReceipt = finalizeAdaptiveReceipt({
          adaptive, receipt: adaptiveReceipt, hasValidSummary,
          winningPair: adaptiveReceipt ? undefined : routingPairName(pool.byId[selectedChoice.id]), route,
        });
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
          : remainingRank.filter(choice => checkedChoices.get(choice.id)?.ok !== false && withinModelCap(choice, pool));
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
