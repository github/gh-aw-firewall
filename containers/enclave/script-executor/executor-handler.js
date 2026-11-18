'use strict';

const {
  CANONICAL_ERROR_RESPONSE_JSON,
  validateEnclaveScriptRequest,
} = require('../../bounded-execution/finite-disclosure');
const { createEnclaveInformationBudgetLedger } = require('../../bounded-execution/sensitivity-ledger');
const { createRealClock, waitForBucket } = require('../../bounded-execution/fixed-timing');
const defaultWorkspace = require('./workspace');
const { createExecutorInvocation } = require('./executor-invocation');
const { createExecutorTelemetry } = require('./executor-telemetry');
const { createExecutorSettlement } = require('./executor-settlement');

/**
 * The trusted enclave executor request handler (protocol v2).
 *
 * Responsibilities, in order, for every request:
 *
 *  1. consume one unit of the per-run *invocation* budget (`maxInvocations`,
 *     an operational cap independent of the bits below) — atomically, since
 *     Node's single-threaded event loop makes the check-and-increment
 *     indivisible because there is no `await` between them;
 *  2. validate the request — including the finite response schema — against
 *     the fixed protocol *before* any repository is copied or any container
 *     is launched;
 *  3. compute that schema's maximum complete-transcript information charge
 *     and atomically debit it from the repository's per-run bit ledger
 *     (see `./ledger`); an invocation proceeds iff the charge fits the
 *     remaining balance — there is no separate per-query cap;
 *  4. map the normalized repo id through AWF's static seed map to an opaque
 *     seed directory the caller never sees or names;
 *  5. build a fresh private writable copy and launch the query with a fixed
 *     argument vector, using a monotonic clock for every timing decision;
 *  6. strictly validate the result against the approved schema and
 *     canonically re-serialize it — raw query bytes/stdout/stderr/exit
 *     status never reach the caller;
 *  7. destroy the private copy, then respond at the first timing bucket
 *     boundary at or after all secret-dependent processing completed (see
 *     `./scheduler`).
 *
 * Every failure at every step produces the identical canonical
 * `{"status":"error"}`. The reason is recorded in the protected audit log,
 * which is never mounted into the agent or a query.
 *
 * Invocations are serialized. That bounds concurrent resource use and removes
 * any cross-invocation race in workspace creation/teardown/ledger access.
 */

function createExecutorHandler(params) {
  const { config, seedMap, runId, audit } = params;
  const workspace = params.workspace || defaultWorkspace;
  if (!params.runner) {
    throw new Error('createExecutorHandler requires a trusted ScriptRunner');
  }
  const runner = params.runner;
  const clock = params.clock || createRealClock();
  const ledger = params.ledger || createEnclaveInformationBudgetLedger(seedMap);
  const telemetry = params.telemetry || { emit() {} };
  const executorKind = params.executorKind || 'script';
  const uniformTiming = params.uniformTiming === true;
  const responseJitterSource = params.responseJitterSource;
  if (executorKind !== 'script' && executorKind !== 'agent') {
    throw new Error('createExecutorHandler requires a known executor kind');
  }
  // Trusted executor-specific request grammar; callers cannot replace it.
  const validateRequest = params.validateRequest || validateEnclaveScriptRequest;
  // Name of the single free-form payload field this executor accepts.
  const payloadKey = params.payloadKey || 'script';
  // Optional trusted exit-status → protected-audit category map. Categories
  // never reach the caller; every failure is still the canonical error.
  const exitCategories = params.exitCategories || {};
  const { timing, diagnosticReason, emitInvocationTelemetry } = createExecutorTelemetry({
    config, clock, diagnosticAudit: params.diagnosticAudit, executorKind, exitCategories, telemetry,
  });

  // Optional dynamic repository admission client (ADR 0001). When present the
  // executor has no static seed catalog: each invocation's selector is routed
  // through AWF's canonical admission first, and only an admitted repository
  // yields a short-lived delegated bearer. Absent, the executor uses the
  // immutable static seed map exactly as before.
  const admission = params.admission;

  // Optional shared serialization lane. When several executors are exposed by
  // one server they share a lane so at most one sandbox — script or agent —
  // holds private repository content at a time.
  const lane = params.lane || { tail: Promise.resolve() };

  let invocationsUsed = 0;
  const state = { accepting: true };
  const settlement = createExecutorSettlement({ admission, audit, config, runner, workspace, state });
  const executeInvocation = createExecutorInvocation({
    config, seedMap, runId, audit, workspace, runner, clock, ledger, executorKind,
    uniformTiming, responseJitterSource, validateRequest, payloadKey, exitCategories,
    admission, lane, state, timing, diagnosticReason, emitInvocationTelemetry,
    markAdmitted: settlement.markAdmitted,
    settleDynamic: settlement.settleDynamic,
    safeDestroy: settlement.safeDestroy,
  });

  return {
    close: settlement.close,

    /**
     * Handles one request. `respond` is called exactly once with the
     * canonical result JSON, as soon as it is ready to send (which, for any
     * invocation that reached workspace creation, is exactly at a timing
     * bucket boundary — never earlier). The returned promise resolves once
     * all server-side bookkeeping for the invocation (including workspace
     * cleanup) is complete; it carries no value and exists only to let the
     * caller serialize/await handler shutdown.
     *
     * Requests are queued so at most one query runs at a time.
     */
    handle(request, respond, options = {}) {
      let responded = false;
      const safeRespond = (json) => {
        if (responded) return;
        responded = true;
        respond(json);
      };

      if (!state.accepting || lane.closed) {
        timing(undefined, clock.nowMs(), { phase: 'admission', status: 'rejected',
          reason: 'admissions-closed', accepting: state.accepting, laneClosed: lane.closed === true });
        safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
        return Promise.resolve();
      }

      // The invocation-count cap is operational and independent of the bit
      // ledger: it is consumed per *response*, not per launch, so every
      // response the agent observes — including a rejection — counts
      // against it.
      if (invocationsUsed >= config.maxInvocations) {
        timing(undefined, clock.nowMs(), { phase: 'admission', status: 'rejected',
          reason: 'invocation-count-exhausted' });
        audit.failure('budget', 'invocation-count-exhausted', `max=${config.maxInvocations}`);
        emitInvocationTelemetry('invocation-count-exhausted');
        if (uniformTiming) {
          const queued = lane.tail.then(async () => {
            const startMs = clock.nowMs();
            await waitForBucket(
              startMs,
              clock.nowMs() - startMs,
              clock,
              responseJitterSource,
            );
            safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
          });
          lane.tail = queued.then(
            () => undefined,
            () => undefined,
          );
          return queued;
        }
        safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
        return Promise.resolve();
      }
      invocationsUsed += 1;

      const queued = lane.tail.then(() => {
        if (!state.accepting || lane.closed || (runner.hostOwned && options.signal?.aborted)) {
          timing(undefined, clock.nowMs(), { phase: 'admission', status: 'rejected',
            reason: options.signal?.aborted ? 'cancelled' : 'admissions-closed',
            accepting: state.accepting, laneClosed: lane.closed === true, aborted: options.signal?.aborted === true });
          safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
          return;
        }
        return settlement.withCancellation(options.signal, (invocationId, signal) =>
          executeInvocation(request, safeRespond, invocationId, signal));
      }).catch((error) => {
        if (runner.hostOwned) {
          state.accepting = false;
          lane.closed = true;
        }
        audit.failure('queue', 'unexpected-error', error && error.message);
        emitInvocationTelemetry('unexpected-error');
        safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
      });
      lane.tail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },

    /** Resolves when every admitted invocation has finished server-side work. */
    drain() {
      return lane.tail;
    },

    /** @internal Exposed for tests. */
    get invocationsUsed() {
      return invocationsUsed;
    },

    /** @internal Exposed for tests. */
    ledger,
  };
}

module.exports = { createExecutorHandler };
