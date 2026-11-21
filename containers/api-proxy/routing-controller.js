'use strict';

const { getModelMultiplierCapBlockState } = require('./guards/max-model-multiplier-guard');
const { resolvePrimaryRank, shortlistPrimaryOptions } = require('./routing-candidates');
const { pinRequestEligibility, proxyEligibilityStore } = require('./model-eligibility');
const { classifyRouting } = require('./routing-classify');
const {
  assertPlanningRequestSize,
  toRouteCandidates,
  validateRouteResponse,
} = require('./routing-contract');
const { createRoutingError, RoutingError, toRoutingFailure } = require('./routing-errors');
const { recordSelection, recordFailure } = require('./routing-observation-records');
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
      const selection = createSelection(ordinaryPick, pool.byId[ordinaryPick.id]);
      let routeOptions;
      if (config.topK !== undefined) {
        const fullRank = resolvePrimaryRank(route.ranked_choices, pool);
        // The cap matches native wire IDs, not router IDs. It must not steer the primary past a guard veto.
        const withinCap = fullRank.filter(({ id }) => {
          const { wireModel, provider } = pool.byId[id];
          return !getModelMultiplierCapBlockState(wireModel, provider);
        });
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

      recordSelection(observer, {
        config, selection, classification, successfulClassifier, rawCapabilities, route,
        conversation, degradedReason, actualAttempts, pool, catalogueOverlap, clock, startedAt,
      });

      return Object.freeze({
        ok: true,
        selection,
        ...(routeOptions ? { routeOptions } : {}),
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
