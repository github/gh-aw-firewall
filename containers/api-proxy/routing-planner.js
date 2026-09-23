'use strict';

const { setTimeout: delay } = require('timers/promises');
const { createRoutingError } = require('./routing-errors');

const PLANNER_ATTEMPT_TIMEOUT_MS = 5_000;
const PLANNER_MAX_ATTEMPTS = 3;
// Transport failures which can resolve on their own while the router is starting,
// restarting, or briefly unreachable. `ENOTFOUND` is deliberately excluded: the router
// is addressed through a fixed internal alias, so a missing name is configuration drift
// rather than a transient outage and must fail immediately.
const RETRYABLE_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

function createSystemClock() {
  return {
    now: () => Date.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: timer => clearTimeout(timer),
    async sleep(delayMs, signal) {
      try {
        await delay(delayMs, undefined, { signal });
      } catch (error) {
        if (error.name === 'AbortError') throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
        throw error;
      }
    },
  };
}

function isRetryablePlannerError(error) {
  if (error?.transient === true) return true;
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 500) return true;
  return RETRYABLE_ERROR_CODES.has(error?.code);
}

function ensureActive(signal, deadline, clock) {
  if (signal?.aborted) throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
  if (clock.now() >= deadline) throw createRoutingError('routing_timeout', 'Model routing exceeded its deadline');
}

function runBoundedOperation(operation, {
  signal, deadline, clock = createSystemClock(), timeoutMs: requestedTimeoutMs, timeoutError,
}) {
  ensureActive(signal, deadline, clock);
  const remainingMs = deadline - clock.now();
  const timeoutMs = Math.min(requestedTimeoutMs, remainingMs);
  const deadlineLimited = remainingMs <= requestedTimeoutMs;
  const attemptController = new AbortController();
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const onAbort = () => {
    attemptController.abort();
    rejectCancellation(createRoutingError('routing_cancelled', 'Model routing was cancelled'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = clock.setTimer(() => {
      attemptController.abort();
      reject(deadlineLimited
        ? createRoutingError('routing_timeout', 'Model routing exceeded its deadline')
        : timeoutError());
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => operation({ signal: attemptController.signal, timeoutMs })),
    timeout,
    cancellation,
  ]).finally(() => {
    clock.clearTimer(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

async function callPlannerWithRetry(operation, options) {
  const clock = options.clock || createSystemClock();
  const random = options.random || Math.random;
  let lastError;
  for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt++) {
    ensureActive(options.signal, options.deadline, clock);
    try {
      return await runBoundedOperation(operation, {
        ...options,
        clock,
        timeoutMs: PLANNER_ATTEMPT_TIMEOUT_MS,
        timeoutError: () => {
          const error = new Error('Router request timed out');
          error.code = 'ETIMEDOUT';
          error.transient = true;
          return error;
        },
      });
    } catch (error) {
      lastError = error;
      ensureActive(options.signal, options.deadline, clock);
      if (!isRetryablePlannerError(error)) throw error;
      if (attempt === PLANNER_MAX_ATTEMPTS) break;
      const baseDelay = Math.min(100 * (2 ** (attempt - 1)), 1_000);
      const retryDelay = Math.min(1_000, baseDelay + Math.floor(baseDelay * 0.2 * random()));
      if (clock.now() + retryDelay >= options.deadline) {
        throw createRoutingError('routing_timeout', 'Model routing exceeded its deadline');
      }
      await clock.sleep(retryDelay, options.signal);
    }
  }
  const unavailable = createRoutingError('router_unavailable', 'The router remained unavailable after bounded retries');
  unavailable.cause = lastError;
  throw unavailable;
}

module.exports = {
  PLANNER_ATTEMPT_TIMEOUT_MS, PLANNER_MAX_ATTEMPTS, callPlannerWithRetry,
  createSystemClock, isRetryablePlannerError, runBoundedOperation,
};
