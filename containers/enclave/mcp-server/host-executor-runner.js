'use strict';

const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { createHostExecutorClient } = require('./host-executor-client');
const { finiteSchemaHash } = require('../../bounded-execution/schema-hash');
const { parseAndValidateFiniteOutput } = require('../../bounded-execution/finite-disclosure');

/**
 * Internal broker adapter. The public startup proof deliberately stays closed
 * until the supported-host real-KVM gate is validated; no environment can
 * enable it. Repository staging and result files belong exclusively to AWF.
 */
function createHostExecutorRunner(config, deps = {}) {
  if (config.executorBackend !== 'cloud-hypervisor'
      || !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(config.entryId || '')) {
    throw new Error('Invalid trusted host executor configuration');
  }
  const client = createHostExecutorClient({
    socketPath: config.hostExecutorSocketPath,
    capabilityPath: config.hostExecutorCapabilityPath,
    runId: config.runId,
    timeoutMs: deps.requestTimeoutMs,
  });
  const nowMs = deps.nowMs || (() => performance.now());
  const pollMs = deps.pollMs || 25;
  const drainMs = deps.drainMs || 10_000;
  let closed = false;

  function checked(response) {
    if (!response || !response.ok) throw new Error('Host executor did not confirm lifecycle state');
    return response;
  }

  return {
    hostOwned: true,
    async assertAvailable() {
      throw new Error('Cloud Hypervisor enclave broker execution is disabled pending supported-host real-KVM validation');
    },
    async reconcileRun() {
      if (closed) throw new Error('Host executor lifecycle is unresolved');
    },
    async runInvocation({
      invocationId, seedId, privateRepo, payload, schema, admissionId, executorKind, deadlineMs, signal,
    }) {
      if (closed) throw new Error('Host executor admissions are closed');
      const identity = { entryId: config.entryId, invocationId };
      let cancelPromise;
      let cancelledAt;
      let timedOut = false;
      let invoked = false;
      let registered = false;
      const cancel = () => {
        if (!registered || cancelPromise) return;
        cancelledAt = nowMs();
        // Capture rejection immediately: cancellation can race an in-flight
        // invoke/status exchange, but is still awaited before settlement.
        cancelPromise = client.cancel({ ...identity, cancelGeneration: 1 })
          .then((response) => ({ response }), () => ({ failed: true }));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        cancel();
      }, Math.max(0, deadlineMs - nowMs()));
      signal?.addEventListener('abort', cancel);
      try {
        if (signal?.aborted || nowMs() >= deadlineMs) {
          return { status: 'cancelled', timedOut: nowMs() >= deadlineMs, exitCode: 1 };
        }
        invoked = true;
        let response = checked(await client.invoke({
          ...identity,
          executorKind,
          ...(seedId === undefined ? { selector: privateRepo } : { seedId }),
          payload,
          schema,
          schemaHash: finiteSchemaHash(schema),
          admissionId,
        }));
        registered = true;
        if (signal?.aborted || timedOut) cancel();
        let previousState = response.state;
        let previousGeneration = response.cancelGeneration;
        while (response.state === 'running' || response.state === 'cancelling') {
          if (signal?.aborted || nowMs() >= deadlineMs) {
            timedOut ||= nowMs() >= deadlineMs;
            cancel();
          }
          if (cancelledAt !== undefined && nowMs() - cancelledAt >= drainMs) {
            throw new Error('Host executor cancellation did not terminate');
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          response = checked(await client.status(identity));
          if (response.cancelGeneration < previousGeneration
              || (previousState === 'cancelling' && response.state === 'running')) {
            throw new Error('Host executor lifecycle regressed');
          }
          previousState = response.state;
          previousGeneration = response.cancelGeneration;
        }
        if (cancelPromise) {
          const cancellation = await cancelPromise;
          if (cancellation.failed) throw new Error('Host executor cancellation is unresolved');
          const confirmed = checked(cancellation.response);
          if (confirmed.cancelGeneration !== 1) {
            throw new Error('Host executor cancellation is unresolved');
          }
        }
        if (response.state !== 'terminal') throw new Error('Host executor terminal state is unavailable');
        const digest = crypto.createHash('sha256')
          .update(JSON.stringify([response.outcome, response.result ?? null])).digest('hex');
        if (digest !== response.resultDigest) throw new Error('Host executor result digest is invalid');
        const parsed = response.outcome === 'success'
          ? parseAndValidateFiniteOutput(response.result, schema) : undefined;
        const settled = checked(await client.settle({ ...identity, resultDigest: digest }));
        if (settled.state !== 'settled' || settled.resultDigest !== digest
            || settled.outcome !== response.outcome
            || settled.cancelGeneration !== response.cancelGeneration) {
          throw new Error('Host executor settlement is unresolved');
        }
        if (response.outcome === 'success' && !parsed?.ok) {
          throw new Error('Host executor result schema is invalid');
        }
        if (signal?.aborted || cancelPromise || response.outcome === 'cancelled') {
          return { status: 'cancelled', timedOut, exitCode: 1 };
        }
        return {
          status: 'completed',
          timedOut: timedOut || response.outcome === 'timeout',
          exitCode: response.outcome === 'success' ? 0 : 1,
          rawResult: parsed?.canonical,
        };
      } catch {
        closed = true;
        // Invoke may have reached the host even if its reply was lost.
        registered = invoked;
        cancel();
        if (cancelPromise) await cancelPromise;
        // No raw host error (or result) crosses the finite-disclosure boundary.
        throw new Error('Host executor lifecycle is unresolved');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

module.exports = { createHostExecutorRunner };
