'use strict';

const { buildRoutingCandidates, resolvePrimaryRank } = require('./routing-candidates');
const {
  assertPlanningRequestSize, toRouteCandidates, validateCapabilities, validateConversation, validateRouteResponse,
} = require('./routing-contract');
const { createRoutingError, RoutingError } = require('./routing-errors');
const { callPlannerWithRetry, runBoundedOperation } = require('./routing-planner');

function deepFreezeJson(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

function requireDependency(dependencies, name, method) {
  if (!dependencies[name] || typeof dependencies[name][method] !== 'function') {
    throw createRoutingError('routing_configuration_error', `Routing dependency ${name}.${method} is unavailable`);
  }
}

function validateRoutingDependencies(dependencies) {
  requireDependency(dependencies, 'planner', 'health');
  requireDependency(dependencies, 'planner', 'capabilities');
  requireDependency(dependencies, 'planner', 'classify');
  requireDependency(dependencies, 'planner', 'route');
  requireDependency(dependencies, 'catalogue', 'getSnapshot');
  requireDependency(dependencies, 'executor', 'execute');
  requireDependency(dependencies, 'executor', 'checkBeforePrimary');
  if (typeof dependencies.loadConversation !== 'function') {
    throw createRoutingError('routing_configuration_error', 'Routing conversation loader is unavailable');
  }
}

function mapPlannerFailure(error, phase) {
  if (error instanceof RoutingError) throw error;
  // Both planning phases report an unservable model pool this way.
  if (error?.statusCode === 422 && error.body?.code === 'no_route') {
    throw createRoutingError('no_route', 'The router found no eligible model choice');
  }
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400) {
    throw createRoutingError('routing_contract_error', `The router rejected the ${phase} request`);
  }
  // The planner does not retry these, for example ENOTFOUND for the fixed router alias.
  if (typeof error?.code === 'string') {
    throw createRoutingError('routing_configuration_error', `The router could not be reached for the ${phase} request`);
  }
  throw createRoutingError('routing_contract_error', `The router returned an invalid ${phase} result`);
}

// Reported for drift diagnosis only. Narrowing the pool by the catalogue is what the router must decide.
function countCatalogueOverlap(capabilities, choices) {
  const known = new Set((capabilities?.execution_catalogue?.models ?? []).map(entry => entry?.model));
  return choices.filter(choice => known.has(choice.model)).length;
}

function createRoutingStages({ signal, deadline, clock, random }) {
  const runPhase = operation => runBoundedOperation(operation, {
    signal,
    deadline,
    clock,
    timeoutMs: Math.max(1, deadline - clock.now()),
    timeoutError: () => createRoutingError('routing_timeout', 'Model routing exceeded its deadline'),
  });
  const callPlanner = operation => callPlannerWithRetry(operation, {
    signal, deadline, clock, random,
  });

  return {
    runPhase,
    callPlanner,
    async getRoute(planner, config, pool, conversation, classification) {
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
      const resolvedTopKRank = config.topK !== undefined ? resolvePrimaryRank(route.ranked_choices, pool) : null;
      return { route, resolvedTopKRank };
    },
    async getCapabilities(planner, config, routerIdentity) {
      let health;
      try {
        health = await callPlanner(({ signal: phaseSignal, timeoutMs }) =>
          planner.health({ signal: phaseSignal, timeoutMs }));
      } catch (error) {
        mapPlannerFailure(error, 'health');
      }
      if (health !== 204) {
        throw createRoutingError('routing_contract_error', 'The router health response is invalid');
      }
      let rawCapabilities;
      try {
        rawCapabilities = await callPlanner(({ signal: phaseSignal, timeoutMs }) =>
          planner.capabilities({ signal: phaseSignal, timeoutMs }));
      } catch (error) {
        mapPlannerFailure(error, 'capabilities');
      }
      // Checks router identity and objective support. The execution catalogue does not narrow the pool.
      validateCapabilities(rawCapabilities, config.objective, routerIdentity);
      return rawCapabilities;
    },
    async getCandidates(catalogue, config, policy, eligibilityRequest) {
      const snapshot = await runPhase(({ signal: phaseSignal }) =>
        catalogue.getSnapshot({
          signal: phaseSignal, provider: config.provider || 'copilot', scope: eligibilityRequest.awfEligibilityScope,
        }));
      return buildRoutingCandidates({
        catalogue: snapshot,
        policy,
        candidateModels: config.candidateModels,
        endpoints: config.endpoints,
        eligibilityRequest,
      });
    },
    async getConversation(loadConversation, conversationFile) {
      const loadedConversation = await runPhase(({ signal: phaseSignal }) =>
        loadConversation(conversationFile, { signal: phaseSignal }));
      validateConversation(loadedConversation);
      return deepFreezeJson(JSON.parse(JSON.stringify(loadedConversation)));
    },
  };
}

module.exports = {
  countCatalogueOverlap, createRoutingStages, deepFreezeJson, mapPlannerFailure, validateRoutingDependencies,
};
