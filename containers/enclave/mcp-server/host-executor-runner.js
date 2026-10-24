'use strict';

const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { createHostExecutorClient } = require('./host-executor-client');
const { finiteSchemaHash } = require('../../bounded-execution/schema-hash');
const { parseAndValidateFiniteOutput, serializeFiniteSchema } = require('../../bounded-execution/finite-disclosure');

const FAILURE_REASONS = new Map([
  ['Host executor invoke contains an unsupported field', 'unsupported-field'],
  ['Host executor invoke needs exactly one of seedId or selector', 'seed-selector-exclusive'],
  ...['entryId', 'invocationId', 'executorKind', 'seedId', 'selector', 'payload', 'schema',
    'schemaHash', 'admissionId'].map((name) => [`Host executor request ${name} is invalid`, `invalid-${name}`]),
  ['Host executor did not confirm lifecycle state', 'rejected'],
  ['Host executor request is oversized', 'request-oversized'],
  ['Host executor request timed out', 'timeout'],
  ['Host executor is unavailable', 'unavailable'],
  ['Host executor response is oversized', 'response-oversized'],
  ['Host executor response is truncated', 'response-truncated'],
  ['Host executor response is malformed', 'response-malformed'],
  ['Host executor lifecycle regressed', 'lifecycle-regressed'],
  ['Host executor cancellation did not terminate', 'cancel-drain-timeout'],
  ['Host executor deadline did not terminate', 'deadline-drain-timeout'],
  ['Host executor cancellation is unresolved', 'cancel-unresolved'],
  ['Host executor terminal state is unavailable', 'terminal-unavailable'],
  ['Host executor result digest is invalid', 'digest-mismatch'],
  ['Host executor result schema is invalid', 'schema-mismatch'],
  ['Host executor settlement is unresolved', 'settlement-unresolved'],
]);

/**
 * Internal broker adapter. AWF constructs the listener only after trusted
 * prerequisite checks. Repository staging and result files belong to AWF.
 */
function usesHostExecutor(config) {
  return config.executorTransport === 'host'
    || config.executorBackend === 'docker' || config.executorBackend === 'cloud-hypervisor';
}

function createHostExecutorRunner(config, deps = {}) {
  if (!usesHostExecutor(config)
      || !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(config.entryId || '')) {
    throw new Error('Invalid trusted host executor configuration');
  }
  const requestTimeoutMs = deps.requestTimeoutMs ?? 4_000;
  const pollMs = deps.pollMs ?? 10_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
      || !Number.isSafeInteger(pollMs) || pollMs < 1
      || requestTimeoutMs + pollMs > 14_000) {
    throw new Error('Invalid trusted host executor polling bounds');
  }
  let sequence = 0;
  const started = performance.now();
  function diagnose(record) {
    if (!deps.audit || sequence > 4096) return;
    sequence += 1;
    deps.audit.lifecycle('host-executor', {
      sequence, elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      ...(sequence === 4097 ? { phase: 'diagnostics', status: 'limit-reached' } : record),
    });
  }
  const client = createHostExecutorClient({
    socketPath: config.hostExecutorSocketPath,
    capabilityPath: config.hostExecutorCapabilityPath,
    runId: config.runId,
    timeoutMs: requestTimeoutMs,
    onDiagnostic: diagnose,
  });
  const nowMs = deps.nowMs || (() => performance.now());
  const drainMs = deps.drainMs || 10_000;
  let closed = false;

  function checked(response) {
    if (!response || !response.ok) throw new Error('Host executor did not confirm lifecycle state');
    return response;
  }

  return {
    hostOwned: true,
    async assertAvailable() {
      if (closed) throw new Error('Host executor admissions are closed');
      try {
        diagnose({ phase: 'availability', status: 'started' });
        const response = await client.status({
          entryId: config.entryId,
          invocationId: crypto.randomBytes(16).toString('hex'),
        });
        if (!response || response.ok || response.error !== 'unknown-invocation') {
          throw new Error('Host executor did not confirm authenticated startup');
        }
        diagnose({ phase: 'availability', status: 'passed' });
      } catch {
        diagnose({ phase: 'availability', status: 'failed' });
        closed = true;
        throw new Error('Enclave host executor is unavailable; no runtime fallback');
      }
    },
    async reconcileRun() {
      diagnose({ phase: 'reconcile', status: closed ? 'failed' : 'passed' });
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
      let phase = 'admission';
      const progress = (next) => {
        phase = next;
        diagnose({ invocationId, phase, status: 'started' });
      };
      const cancel = () => {
        if (!registered || cancelPromise) return;
        cancelledAt = nowMs();
        // Capture rejection immediately: cancellation can race an in-flight
        // invoke/status exchange, but is still awaited before settlement.
        cancelPromise = client.cancel({ ...identity, cancelGeneration: 1 })
          .then((response) => {
            diagnose({ invocationId, phase: 'cancel', status: response.ok ? 'confirmed' : 'rejected' });
            return { response };
          }, () => {
            diagnose({ invocationId, phase: 'cancel', status: 'failed' });
            return { failed: true };
          });
      };
      const timer = setTimeout(() => {
        timedOut = true;
      }, Math.max(0, deadlineMs - nowMs()));
      signal?.addEventListener('abort', cancel);
      try {
        progress('admission');
        if (signal?.aborted || nowMs() >= deadlineMs) {
          return { status: 'cancelled', timedOut: nowMs() >= deadlineMs, exitCode: 1 };
        }
        invoked = true;
        progress('invoke');
        const wireSchema = serializeFiniteSchema(schema);
        let response = checked(await client.invoke({
          ...identity,
          executorKind,
          ...(seedId === undefined ? { selector: privateRepo } : { seedId }),
          payload,
          schema: wireSchema,
          schemaHash: finiteSchemaHash(wireSchema),
          admissionId,
        }));
        registered = true;
        if (signal?.aborted && response.state !== 'terminal') cancel();
        let previousState = response.state;
        let previousGeneration = response.cancelGeneration;
        while (response.state === 'running' || response.state === 'cancelling') {
          if (signal?.aborted) cancel();
          const now = nowMs();
          if (cancelledAt !== undefined && now - cancelledAt >= drainMs) {
            throw new Error('Host executor cancellation did not terminate');
          }
          if (cancelledAt === undefined && now >= deadlineMs + drainMs) {
            throw new Error('Host executor deadline did not terminate');
          }
          // The host owns deadline interruption. A broker cancel here would
          // race its timer and durably misclassify a timeout as cancellation.
          const pollDeadlineMs = cancelledAt !== undefined ? cancelledAt + drainMs
            : now < deadlineMs ? deadlineMs : deadlineMs + drainMs;
          const remainingMs = Math.max(0, pollDeadlineMs - now);
          await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
          progress('status');
          response = checked(await client.status(identity));
          if (response.cancelGeneration < previousGeneration
              || (previousState === 'cancelling' && response.state === 'running')) {
            throw new Error('Host executor lifecycle regressed');
          }
          previousState = response.state;
          previousGeneration = response.cancelGeneration;
          if (response.state !== 'terminal' && nowMs() >= deadlineMs) {
            timedOut = true;
          }
        }
        if (cancelPromise) {
          progress('cancel-confirmation');
          const cancellation = await cancelPromise;
          if (cancellation.failed) throw new Error('Host executor cancellation is unresolved');
          const confirmed = checked(cancellation.response);
          if (confirmed.cancelGeneration !== 1) {
            throw new Error('Host executor cancellation is unresolved');
          }
        }
        progress('terminal');
        if (response.state !== 'terminal') throw new Error('Host executor terminal state is unavailable');
        progress('digest');
        const digest = crypto.createHash('sha256')
          .update(JSON.stringify([response.outcome, response.result ?? null])).digest('hex');
        if (digest !== response.resultDigest) throw new Error('Host executor result digest is invalid');
        progress('schema');
        const parsed = response.outcome === 'success'
          ? parseAndValidateFiniteOutput(response.result, schema) : undefined;
        if (response.outcome === 'success' && !parsed?.ok) {
          throw new Error('Host executor result schema is invalid');
        }
        progress('settle');
        const settled = checked(await client.settle({ ...identity, resultDigest: digest }));
        if (settled.state !== 'settled' || settled.resultDigest !== digest
            || settled.outcome !== response.outcome
            || settled.cancelGeneration !== response.cancelGeneration) {
          throw new Error('Host executor settlement is unresolved');
        }
        diagnose({ invocationId, phase: 'settle', status: 'passed', outcome: response.outcome });
        if (signal?.aborted || cancelPromise || response.outcome === 'cancelled') {
          return { status: 'cancelled', timedOut, exitCode: 1 };
        }
        return {
          status: 'completed',
          timedOut: timedOut || response.outcome === 'timeout',
          exitCode: response.outcome === 'success' ? 0 : 1,
          rawResult: parsed?.canonical,
        };
      } catch (error) {
        diagnose({ invocationId, phase, status: 'failed', registered, invoked, timedOut,
          aborted: Boolean(signal?.aborted), reason: FAILURE_REASONS.get(error?.message) || 'unknown' });
        closed = true;
        // Invoke may have reached the host even if its reply was lost.
        registered = invoked;
        cancel();
        if (cancelPromise) await cancelPromise;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
      // No raw host error (or result), including an Error cause, crosses this boundary.
      throw new Error('Host executor lifecycle is unresolved');
    },
  };
}

module.exports = { createHostExecutorRunner, usesHostExecutor };
