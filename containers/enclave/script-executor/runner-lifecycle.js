'use strict';

const REQUIRED_ADAPTER_METHODS = Object.freeze([
  'assertAvailable',
  'launchInvocation',
  'collectResult',
  'cancelInvocation',
  'cleanupInvocation',
  'reconcileRun',
]);

const ALLOWED_INVOCATION_KEYS = new Set([
  'runId',
  'invocationId',
  'seedId',
  'deadlineMs',
  'signal',
  'binding',
]);

function assertAdapter(adapter) {
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (!adapter || typeof adapter[method] !== 'function') {
      throw new Error(`Enclave runtime adapter is missing lifecycle method: ${method}`);
    }
  }
}

function validateInvocationRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Enclave invocation must be a trusted broker request');
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_INVOCATION_KEYS.has(key)) {
      throw new Error(`Enclave invocation contains forbidden runtime control: ${key}`);
    }
  }
  if (typeof request.deadlineMs !== 'number' || !Number.isFinite(request.deadlineMs)) {
    throw new Error('Enclave invocation deadline is invalid');
  }
  if (request.signal !== undefined
      && (typeof request.signal !== 'object'
        || typeof request.signal.addEventListener !== 'function'
        || typeof request.signal.removeEventListener !== 'function')) {
    throw new Error('Enclave invocation cancellation signal is invalid');
  }
}

function boundedResult(result, cancelled) {
  if (cancelled) {
    return Object.freeze({ status: 'cancelled', exitCode: 124, timedOut: false });
  }
  if (!result || !Number.isSafeInteger(result.exitCode) || typeof result.timedOut !== 'boolean') {
    throw new Error('Enclave runtime returned an invalid result');
  }
  return Object.freeze({
    status: result.timedOut ? 'timed-out' : 'completed',
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
}

/**
 * Wraps one trusted runtime adapter in the lifecycle contract used by both
 * enclave executor kinds. Runtime handles stay in a WeakMap and never enter an
 * MCP request, response, audit record, or workspace.
 */
function createRunnerLifecycle(adapter, deps = {}) {
  assertAdapter(adapter);
  const nowMs = deps.nowMs || Date.now;
  const records = new WeakMap();
  const active = new Map();

  function invocationKey(runId, invocationId) {
    return `${runId}\0${invocationId}`;
  }

  function recordFor(handle) {
    const record = records.get(handle);
    if (!record) throw new Error('Unknown enclave invocation handle');
    return record;
  }

  async function cleanupRecord(record) {
    if (!record.cleanupPromise) {
      record.cleanupPromise = Promise.resolve()
        .then(() => adapter.cleanupInvocation(record.runtimeHandle))
        .finally(() => {
          active.delete(record.key);
        });
    }
    return record.cleanupPromise;
  }

  async function cancelRecord(record) {
    record.cancelled = true;
    if (!record.cancelPromise) {
      record.cancelPromise = Promise.resolve()
        .then(() => adapter.cancelInvocation(record.runtimeHandle));
    }
    return record.cancelPromise;
  }

  const lifecycle = {
    assertAvailable() {
      return adapter.assertAvailable();
    },

    async launchInvocation(request) {
      validateInvocationRequest(request);
      if (request.deadlineMs - nowMs() <= 0) {
        throw new Error('Enclave invocation deadline elapsed before launch');
      }
      const key = invocationKey(request.runId, request.invocationId);
      if (active.has(key)) throw new Error('Enclave invocation is already active');

      let runtimeHandle;
      try {
        runtimeHandle = await adapter.launchInvocation({
          runId: request.runId,
          invocationId: request.invocationId,
          seedId: request.seedId,
          deadlineMs: request.deadlineMs,
          binding: request.binding,
        });
      } catch (launchError) {
        try {
          await adapter.cleanupInvocation({
            runId: request.runId,
            invocationId: request.invocationId,
          });
        } catch (cleanupError) {
          throw cleanupError;
        }
        throw launchError;
      }

      const handle = Object.freeze({});
      const record = {
        key,
        runtimeHandle,
        cancelled: false,
        cancelPromise: undefined,
        cleanupPromise: undefined,
      };
      records.set(handle, record);
      active.set(key, record);
      return handle;
    },

    async collectResult(handle) {
      const record = recordFor(handle);
      const result = await adapter.collectResult(record.runtimeHandle);
      return boundedResult(result, record.cancelled);
    },

    cancelInvocation(handle) {
      return cancelRecord(recordFor(handle));
    },

    cleanupInvocation(handle) {
      return cleanupRecord(recordFor(handle));
    },

    reconcileRun(runId) {
      return adapter.reconcileRun(runId);
    },

    async runInvocation(request) {
      const handle = await lifecycle.launchInvocation(request);
      const signal = request.signal;
      let cancellation;
      let result;
      let operationError;
      let cancellationError;
      const onAbort = () => {
        cancellation = lifecycle.cancelInvocation(handle);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        try {
          result = await lifecycle.collectResult(handle);
        } catch (error) {
          operationError = error;
        }
        if (cancellation) {
          try {
            await cancellation;
          } catch (error) {
            cancellationError = error;
          }
        }
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        await lifecycle.cleanupInvocation(handle);
      }
      if (cancellationError) throw cancellationError;
      if (operationError) throw operationError;
      return boundedResult(result, signal?.aborted === true);
    },
  };

  return Object.freeze(lifecycle);
}

module.exports = {
  REQUIRED_ADAPTER_METHODS,
  createRunnerLifecycle,
};
