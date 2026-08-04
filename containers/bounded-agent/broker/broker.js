'use strict';

const crypto = require('crypto');
const {
  CANONICAL_ERROR_JSON,
  canonicalOkJson,
  parseAndValidateQueryOutput,
  queryBitsForSchema,
} = require('./protocol');
const { validateBoundedAgentRequest } = require('./framing');
const { createLedger } = require('./ledger');
const { createRealClock, waitForBucket } = require('./scheduler');
const defaultWorkspace = require('./workspace');

const ENCLAVE_EXIT_CATEGORIES = Object.freeze({
  10: 'enclave-configuration-invalid',
  11: 'enclave-input-invalid',
  20: 'enclave-deadline-exceeded',
  21: 'enclave-provider-http-error',
  22: 'enclave-provider-transport-error',
  23: 'enclave-provider-response-invalid',
  24: 'enclave-engine-failed',
  30: 'enclave-result-write-failed',
  31: 'enclave-model-loop-exhausted',
});

/**
 * The trusted bounded-agent broker.
 *
 * Responsibilities, in order, for every request:
 *
 *  1. consume one unit of the per-run *invocation* budget (`maxInvocations`,
 *     an operational cap independent of the bits below) — atomically, since
 *     Node's single-threaded event loop makes the check-and-increment
 *     indivisible because there is no `await` between them;
 *  2. validate the request — repository selector, finite response schema, and
 *     byte-bounded task text — against the fixed protocol, rejecting every
 *     unknown or forbidden control, *before* anything is created;
 *  3. compute that schema's maximum complete-transcript information charge
 *     (status bit + schema bits + timing bits) and atomically debit it from
 *     the repository's per-run bit ledger **before** any workspace is
 *     materialized or any container is launched;
 *  4. map the normalized repo id through AWF's static seed map to an opaque,
 *     immutable seed the caller never sees or names;
 *  5. launch a fresh, uniquely named, labelled enclave with a fixed argument
 *     vector on the dedicated bounded-agent network;
 *  6. strictly validate the enclave's dedicated bounded result file against
 *     the approved schema and canonically re-serialize it — raw enclave bytes,
 *     stdout, stderr, transcript, and exit status never reach the caller;
 *  7. destroy the private workspace, then respond at the first timing bucket
 *     boundary at or after all secret-dependent processing completed.
 *
 * Every failure at every step produces the identical canonical
 * `{"status":"error"}`. The reason is recorded in the protected audit log,
 * which is never mounted into the agent or an enclave — and even there, the
 * repository, the task, the transcript, the raw result, host paths, tokens,
 * and provider payloads are never recorded.
 *
 * Invocations are serialized. That bounds concurrent resource use and removes
 * any cross-invocation race in workspace creation/teardown/ledger access.
 */

function createBroker(params) {
  const { config, seedMap, runId, audit } = params;
  const workspace = params.workspace || defaultWorkspace;
  if (!params.runner) {
    throw new Error('createBroker requires a trusted EnclaveRunner');
  }
  const runner = params.runner;
  const clock = params.clock || createRealClock();
  // A ledger built from this broker's own seed map. Bounded agents never share
  // a ledger with bounded queries: the two brokers are separate processes with
  // separate seed maps and separate private roots.
  const ledger = params.ledger || createLedger(seedMap);
  const telemetry = params.telemetry || { emit() {} };

  let invocationsUsed = 0;
  let tail = Promise.resolve();
  let accepting = true;

  function emitInvocationTelemetry(category) {
    telemetry.emit({
      primaryBackend: config.primaryBackend,
      boundedAgentBackend: config.backend,
      lifecycleClass: 'invocation',
      capabilityState: 'supported',
      category,
    });
  }

  async function execute(request, respond) {
    const invocationId = crypto.randomBytes(12).toString('hex');
    let responded = false;
    const safeRespond = (json) => {
      if (responded) return;
      responded = true;
      respond(json);
    };

    const validation = validateBoundedAgentRequest(request, { maxTaskBytes: config.maxTaskBytes });
    if (!validation.valid) {
      audit.failure(invocationId, 'invalid-request', validation.errors.join('; '));
      emitInvocationTelemetry('invalid-request');
      safeRespond(CANONICAL_ERROR_JSON);
      return;
    }
    const { privateRepo, schema, task } = validation.request;
    const repoKey = privateRepo.toLowerCase();

    const seed = seedMap.get(repoKey);
    if (!seed) {
      // Deliberately does not record which repository was requested.
      audit.failure(invocationId, 'repo-not-allowed');
      emitInvocationTelemetry('repo-not-allowed');
      safeRespond(CANONICAL_ERROR_JSON);
      return;
    }

    // Compute and debit the charge for THIS invocation's schema *before*
    // creating a workspace or launching an enclave. The charge covers the
    // status and timing channels as well as the schema payload.
    const charge = queryBitsForSchema(schema);
    if (!ledger.tryDebit(repoKey, charge)) {
      audit.failure(invocationId, 'bit-budget-exhausted', `charge=${charge}`);
      emitInvocationTelemetry('bit-budget-exhausted');
      safeRespond(CANONICAL_ERROR_JSON);
      return;
    }

    // From here on the charge is committed (never refunded) and every response
    // must be time-bucketed: enclave execution runs against secret repository
    // content, so its latency alone is a signal.
    const startMs = clock.nowMs();

    let layout;
    let failureReason;
    let canonicalResult;

    try {
      layout = workspace.createInvocationWorkspace({ config, invocationId, task, schema });
    } catch (error) {
      failureReason = ['workspace-create-failed', error.message];
    }

    if (layout) {
      const remainingMs = config.timeoutSeconds * 1000 - (clock.nowMs() - startMs);
      if (remainingMs <= 0) {
        failureReason = ['timeout', 'workspace-creation-overran-deadline'];
      } else {
        try {
          const run = await runner.runEnclaveContainer({
            config,
            runId,
            invocationId,
            seedId: seed.seedId,
            timeoutMs: remainingMs,
          });
          if (run.timedOut) {
            failureReason = ['timeout'];
          } else if (run.exitCode !== 0) {
            failureReason = [ENCLAVE_EXIT_CATEGORIES[run.exitCode] || 'non-zero-exit'];
          } else {
            const raw = workspace.readEnclaveOutput(layout.outPath, config.maxOutputBytes);
            if (raw === undefined) {
              // Covers a missing file, an oversized file, invalid UTF-8, and
              // any non-regular replacement (symlink/FIFO/device/socket).
              failureReason = ['unreadable-output'];
            } else {
              const parsed = parseAndValidateQueryOutput(raw, schema);
              if (!parsed.ok) {
                failureReason = ['nonconformant-output'];
              } else {
                canonicalResult = parsed.canonical;
              }
            }
          }
        } catch (error) {
          failureReason = ['launch-failed', error.message];
        }
      }
    }

    // Teardown is part of the observable operation and must complete before the
    // timing bucket is chosen.
    if (layout) {
      workspace.preserveInvocationSession(
        layout.sessionLogPath,
        config.auditDir,
        invocationId,
      );
    }
    if (!safeDestroy(invocationId)) {
      failureReason = ['cleanup-failed'];
      canonicalResult = undefined;
    }

    const elapsedMs = clock.nowMs() - startMs;
    const { bucketMs, overflowed } = await waitForBucket(startMs, elapsedMs, clock);

    if (overflowed) {
      // Fail closed: processing overran every configured bucket. Never emit a
      // successful result at unbucketed timing.
      audit.failure(invocationId, 'timing-bucket-overflow', failureReason ? failureReason[0] : undefined);
      emitInvocationTelemetry('timing-bucket-overflow');
      safeRespond(CANONICAL_ERROR_JSON);
    } else if (canonicalResult !== undefined) {
      audit.invocation({
        invocationId,
        // The repository name is deliberately absent; only its trusted
        // sensitivity class and the charge are recorded.
        sensitivity: seed.sensitivity,
        bits: charge,
        bucketMs,
      });
      emitInvocationTelemetry('success');
      safeRespond(canonicalOkJson(canonicalResult));
    } else {
      const category = failureReason ? failureReason[0] : 'unknown';
      audit.failure(invocationId, category, failureReason ? failureReason[1] : undefined);
      emitInvocationTelemetry(category);
      safeRespond(CANONICAL_ERROR_JSON);
    }
  }

  function safeDestroy(invocationId) {
    try {
      workspace.destroyInvocationWorkspace(config.workDir, invocationId);
      return true;
    } catch (error) {
      audit.failure(invocationId, 'cleanup-failed', error.message);
      return false;
    }
  }

  return {
    /** Stops admitting new invocations while letting admitted work drain. */
    close() {
      accepting = false;
    },

    /**
     * Handles one request. `respond` is called exactly once with the canonical
     * result JSON. Requests are queued so at most one enclave runs at a time.
     */
    handle(request, respond) {
      let responded = false;
      const safeRespond = (json) => {
        if (responded) return;
        responded = true;
        respond(json);
      };

      if (!accepting) {
        safeRespond(CANONICAL_ERROR_JSON);
        return Promise.resolve();
      }

      // The invocation-count cap is operational and independent of the bit
      // ledger: it is consumed per *response*, so every response the agent
      // observes — including a rejection — counts against it.
      if (invocationsUsed >= config.maxInvocations) {
        audit.failure('budget', 'invocation-count-exhausted', `max=${config.maxInvocations}`);
        emitInvocationTelemetry('invocation-count-exhausted');
        safeRespond(CANONICAL_ERROR_JSON);
        return Promise.resolve();
      }
      invocationsUsed += 1;

      const queued = tail.then(() => execute(request, safeRespond)).catch((error) => {
        audit.failure('queue', 'unexpected-error', error && error.message);
        emitInvocationTelemetry('unexpected-error');
        safeRespond(CANONICAL_ERROR_JSON);
      });
      tail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },

    /** Resolves when every admitted invocation has finished broker-side work. */
    drain() {
      return tail;
    },

    /** @internal Exposed for tests. */
    get invocationsUsed() {
      return invocationsUsed;
    },

    /** @internal Exposed for tests. Never surfaced on the wire. */
    ledger,
  };
}

module.exports = { createBroker };
