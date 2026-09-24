'use strict';

const { buildRoutingCandidates } = require('./routing-candidates');
const { extractClassifierOutput, preflightClassifierRequest } = require('./routing-classifier');
const {
  assertPlanningRequestSize,
  toRouteCandidates,
  validateCapabilities,
  validateClassifierOutput,
  validateClassifyResponse,
  validateConversation,
  validateRouteResponse,
} = require('./routing-contract');
const { createRoutingError, RoutingError, toRoutingFailure } = require('./routing-errors');
const { callPlannerWithRetry, createSystemClock, runBoundedOperation } = require('./routing-planner');

const ROUTING_BOOTSTRAP_TIMEOUT_MS = 90_000;
const CLASSIFIER_ATTEMPT_TIMEOUT_MS = 30_000;
const CLASSIFIER_MAX_ATTEMPTS = 2;
const PURPOSE = 'routing_classification';

function deepFreezeJson(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

function safeRecord(observer, record) {
  try {
    observer?.record?.(Object.freeze(record));
  } catch {
    // Observability must not change the routing decision.
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

function isClassifierAvailabilityFailure(result) {
  return result?.availabilityFailure === true ||
    (Number.isInteger(result?.statusCode) && result.statusCode >= 500);
}

function classifierTimeoutError() {
  const error = new Error('Classifier request timed out');
  error.code = 'ETIMEDOUT';
  return error;
}

function createSelection(choice, mapping) {
  return deepFreezeJson({
    schema: 'awf-routing-selection/v1',
    engine: 'copilot',
    provider: 'copilot',
    choice: {
      id: choice.id,
      model: choice.model,
      ...(Object.hasOwn(choice, 'effort') ? { effort: choice.effort } : {}),
    },
    wire_model: mapping.wireModel,
  });
}

function requireDependency(dependencies, name, method) {
  if (!dependencies[name] || typeof dependencies[name][method] !== 'function') {
    throw createRoutingError('routing_configuration_error', `Routing dependency ${name}.${method} is unavailable`);
  }
}

// Reported for drift diagnosis only. Narrowing the pool by the catalogue is what the router must decide.
function countCatalogueOverlap(capabilities, choices) {
  const known = new Set((capabilities?.execution_catalogue?.models ?? []).map(entry => entry?.model));
  return choices.filter(choice => known.has(choice.model)).length;
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
  } = dependencies;

  let runPromise;

  async function execute(options = {}) {
    const startedAt = clock.now();
    const jobDeadline = Number.isFinite(options.jobDeadlineMs) ? options.jobDeadlineMs : Infinity;
    const deadline = Math.min(startedAt + ROUTING_BOOTSTRAP_TIMEOUT_MS, jobDeadline);
    const signal = options.signal;

    const runPhase = operation => runBoundedOperation(operation, {
      signal,
      deadline,
      clock,
      timeoutMs: Math.max(1, deadline - clock.now()),
      timeoutError: () => createRoutingError('routing_timeout', 'Model routing exceeded its deadline'),
    });
    const callPlanner = operation => callPlannerWithRetry(operation, {
      signal,
      deadline,
      clock,
      random,
    });
    let catalogueOverlap = null;

    try {
      requireDependency(dependencies, 'planner', 'health');
      requireDependency(dependencies, 'planner', 'capabilities');
      requireDependency(dependencies, 'planner', 'classify');
      requireDependency(dependencies, 'planner', 'route');
      requireDependency(dependencies, 'catalogue', 'getSnapshot');
      requireDependency(dependencies, 'executor', 'execute');
      requireDependency(dependencies, 'executor', 'checkBeforePrimary');
      if (typeof loadConversation !== 'function') {
        throw createRoutingError('routing_configuration_error', 'Routing conversation loader is unavailable');
      }

      const health = await callPlanner(({ signal: phaseSignal, timeoutMs }) =>
        planner.health({ signal: phaseSignal, timeoutMs }));
      if (health !== 204) {
        throw createRoutingError('routing_contract_error', 'The router health response is invalid');
      }

      const rawCapabilities = await callPlanner(({ signal: phaseSignal, timeoutMs }) =>
        planner.capabilities({ signal: phaseSignal, timeoutMs }));
      // Checks router identity and objective support. The execution catalogue does not narrow the pool.
      validateCapabilities(rawCapabilities, config.objective, routerIdentity);

      const snapshot = await runPhase(({ signal: phaseSignal }) => catalogue.getSnapshot({ signal: phaseSignal }));
      const pool = buildRoutingCandidates({ catalogue: snapshot, policy });
      catalogueOverlap = countCatalogueOverlap(rawCapabilities, pool.choices);

      const loadedConversation = await runPhase(({ signal: phaseSignal }) =>
        loadConversation(config.task.conversationFile, { signal: phaseSignal }));
      validateConversation(loadedConversation);
      const conversation = deepFreezeJson(JSON.parse(JSON.stringify(loadedConversation)));

      const classifyRequest = deepFreezeJson({ conversation, models: pool.choices });
      assertPlanningRequestSize(classifyRequest);

      let classification = null;
      let degradedReason = null;
      let classifierPlan;
      try {
        const rawPlan = await callPlanner(({ signal: phaseSignal, timeoutMs }) =>
          planner.classify(classifyRequest, { signal: phaseSignal, timeoutMs }));
        classifierPlan = validateClassifyResponse(rawPlan, pool.choices);
      } catch (error) {
        mapPlannerFailure(error, 'classify');
      }

      let actualAttempts = 0;
      let capacityExclusions = 0;
      for (const choice of classifierPlan.ranked_choices) {
        if (actualAttempts >= CLASSIFIER_MAX_ATTEMPTS) break;
        const mapping = pool.byId[choice.id];
        const preflight = preflightClassifierRequest(mapping, classifierPlan);
        if (!preflight.eligible) {
          capacityExclusions++;
          continue;
        }

        actualAttempts++;
        safeRecord(observer, {
          stage: 'classification',
          purpose: PURPOSE,
          attempt: actualAttempts,
          classifier_model: mapping.choice.model,
          classifier_effort: mapping.effort ?? null,
        });
        let result;
        try {
          result = await runBoundedOperation(
            ({ signal: phaseSignal, timeoutMs }) => executor.execute({
              path: preflight.request.path,
              body: preflight.request.body,
              purpose: PURPOSE,
            }, { signal: phaseSignal, timeoutMs }),
            {
              signal,
              deadline,
              clock,
              timeoutMs: CLASSIFIER_ATTEMPT_TIMEOUT_MS,
              timeoutError: classifierTimeoutError,
            },
          );
        } catch (error) {
          if (error instanceof RoutingError) throw error;
          if (error?.code === 'ETIMEDOUT') continue;
          throw createRoutingError('provider_unavailable', 'Classifier execution was rejected by the provider path');
        }

        if (result?.terminal) {
          throw createRoutingError(
            result.terminal.code,
            result.terminal.detail || 'Classifier execution was rejected by a native guard',
          );
        }
        if (isClassifierAvailabilityFailure(result)) continue;
        if (!Number.isInteger(result?.statusCode) || result.statusCode < 200 || result.statusCode >= 300) {
          throw createRoutingError('provider_unavailable', 'Classifier execution failed in the provider path');
        }

        const rawOutput = extractClassifierOutput(mapping.protocol, result.body);
        classification = rawOutput === null ? null : validateClassifierOutput(rawOutput);
        if (classification === null) degradedReason = 'invalid_classifier_output';
        break;
      }

      if (classification === null && degradedReason === null) {
        degradedReason = actualAttempts === 0 && capacityExclusions > 0
          ? 'classifier_capacity_exhausted'
          : 'classifier_attempts_exhausted';
      }

      const routeRequest = {
        objective: config.objective,
        conversation,
        models: toRouteCandidates(pool),
        ...(classification === null ? {} : { classification }),
      };
      assertPlanningRequestSize(routeRequest);
      deepFreezeJson(routeRequest);

      let rawRoute;
      try {
        rawRoute = await callPlanner(({ signal: phaseSignal, timeoutMs }) =>
          planner.route(routeRequest, { signal: phaseSignal, timeoutMs }));
      } catch (error) {
        mapPlannerFailure(error, 'route');
      }
      const route = validateRouteResponse(rawRoute, pool.choices);
      const selectedChoice = route.ranked_choices[0];
      const selection = createSelection(selectedChoice, pool.byId[selectedChoice.id]);

      await runPhase(({ signal: phaseSignal }) =>
        executor.checkBeforePrimary({ selection, signal: phaseSignal }));

      safeRecord(observer, {
        stage: 'selection',
        objective: config.objective,
        selected_id: selection.choice.id,
        selected_model: selection.choice.model,
        selected_effort: selection.choice.effort ?? null,
        degraded_classification: classification === null,
        degraded_reason: degradedReason,
        classifier_attempts: actualAttempts,
        eligible_choices: pool.choices.length,
        catalogue_overlap: catalogueOverlap,
        latency_ms: Math.max(0, clock.now() - startedAt),
      });

      return Object.freeze({
        ok: true,
        selection,
        degradedClassification: classification === null,
        ...(degradedReason ? { degradedReason } : {}),
      });
    } catch (error) {
      const normalized = error instanceof RoutingError
        ? error
        : createRoutingError('routing_configuration_error', 'Model routing failed before selection');
      const failure = toRoutingFailure(normalized);
      safeRecord(observer, {
        stage: 'failure',
        objective: config.objective,
        code: failure.code,
        // Routing failure details are authored literals, already sanitized by toRoutingFailure.
        detail: failure.detail,
        catalogue_overlap: catalogueOverlap,
        latency_ms: Math.max(0, clock.now() - startedAt),
      });
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
