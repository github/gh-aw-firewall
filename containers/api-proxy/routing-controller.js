'use strict';

const { selectAdaptive } = require('./adaptive-select');
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
const { recordSelection, recordFailure } = require('./routing-observation-records');
const { writeAdaptiveSelection } = require('./routing-persistence');
const { createSystemClock } = require('./routing-planner');
const {
  countCatalogueOverlap, createRoutingStages, deepFreezeJson, mapPlannerFailure, validateRoutingDependencies,
} = require('./routing-stages');

const ROUTING_BOOTSTRAP_TIMEOUT_MS = 90_000;
const CLASSIFIER_ATTEMPT_TIMEOUT_MS = 30_000;
const CLASSIFIER_MAX_ATTEMPTS = 2;
const PURPOSE = 'routing_classification';

function modelEffortPair(choice) {
  return {
    model: choice.model,
    ...(Object.hasOwn(choice, 'effort') ? { effort: choice.effort } : {}),
  };
}

function createSelection(choice, mapping) {
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
    const { runPhase, callPlanner } = stages;
    let catalogueOverlap = null;

    try {
      validateRoutingDependencies(dependencies);
      const rawCapabilities = await stages.getCapabilities(planner, config, routerIdentity);
      const pool = await stages.getCandidates(catalogue, config, policy, eligibilityRequest);
      catalogueOverlap = countCatalogueOverlap(rawCapabilities, pool.choices);
      const conversation = await stages.getConversation(loadConversation, config.task.conversationFile);
      const { classification, successfulClassifier, degradedReason, actualAttempts } = await classifyRouting({
        conversation, pool, planner, executor, observer, eligibilityRequest,
        callPlanner, signal, deadline, clock,
        attemptTimeoutMs: CLASSIFIER_ATTEMPT_TIMEOUT_MS, maxAttempts: CLASSIFIER_MAX_ATTEMPTS, purpose: PURPOSE,
      });

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
        rawRoute = await callPlanner(({ signal: phaseSignal, timeoutMs }) =>
          planner.route(routeRequest, { signal: phaseSignal, timeoutMs, trace: routeTrace }));
      } catch (error) {
        mapPlannerFailure(error, 'route');
      }
      const route = validateRouteResponse(rawRoute, pool.choices);
      // Ordinary routing uses choice IDs; only the opt-in options contract requires unique pairs.
      const ordinaryPick = route.ranked_choices[0];
      let withinCap;
      if (config.topK !== undefined || adaptive) {
        // The cap matches native wire IDs, not router IDs. It must not steer the primary past a guard veto.
        withinCap = resolvePrimaryRank(route.ranked_choices, pool).filter(({ id }) => {
          const { wireModel, provider } = pool.byId[id];
          return !getModelMultiplierCapBlockState(wireModel, provider);
        });
      }
      let selectedChoice = ordinaryPick;
      let adaptiveReceipt;
      if (adaptive) {
        // The workflow's evidence chooses among the eligible pairs; the ordinary pick stays the router's.
        const byPair = new Map(withinCap.map(choice => [routingPairName(pool.byId[choice.id]), choice]));
        adaptiveReceipt = selectAdaptive({
          summary: adaptive.summary,
          rank: [...byPair.keys()],
          ordinary: routingPairName(pool.byId[ordinaryPick.id]),
          job: adaptive.job,
          price: (pair, tokens) => (byPair.has(pair) ? priceRoute(pool.byId[byPair.get(pair).id], tokens) : null),
        });
        selectedChoice = byPair.get(adaptiveReceipt.selected) ?? ordinaryPick;
      }
      const selection = createSelection(selectedChoice, pool.byId[selectedChoice.id]);
      let routeOptions;
      if (config.topK !== undefined) {
        routeOptions = deepFreezeJson({
          ordinaryPick: modelEffortPair(ordinaryPick),
          options: shortlistPrimaryOptions(withinCap, config.topK).map(modelEffortPair),
        });
      }

      await runPhase(({ signal: phaseSignal }) =>
        executor.checkBeforePrimary({
          selection, signal: phaseSignal, awfEligibility: eligibilityRequest.awfEligibility,
          awfEligibilityScope: eligibilityRequest.awfEligibilityScope,
        }));
      // Recorded before the primary starts, once the final guard has accepted the selection.
      if (adaptiveReceipt) writeAdaptiveReceipt(deepFreezeJson(adaptiveReceipt));

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
  ROUTING_BOOTSTRAP_TIMEOUT_MS,
  createRoutingController,
};
