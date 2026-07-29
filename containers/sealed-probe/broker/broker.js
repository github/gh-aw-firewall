'use strict';

const crypto = require('crypto');
const {
  CANONICAL_ERROR_JSON,
  canonicalOkJson,
  parseAndValidateProbeOutput,
  queryBitsForSchema,
  validateSealedProbeRequest,
} = require('./protocol');
const { createLedger } = require('./ledger');
const { createRealClock, waitForBucket } = require('./scheduler');
const defaultWorkspace = require('./workspace');
const defaultRunner = require('./probe-runner');

/**
 * The trusted sealed-probe broker (protocol v2).
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
 *  5. build a fresh private writable copy and launch the probe with a fixed
 *     argument vector, using a monotonic clock for every timing decision;
 *  6. strictly validate the result against the approved schema and
 *     canonically re-serialize it — raw probe bytes/stdout/stderr/exit
 *     status never reach the caller;
 *  7. destroy the private copy, then respond at the first timing bucket
 *     boundary at or after all secret-dependent processing completed (see
 *     `./scheduler`).
 *
 * Every failure at every step produces the identical canonical
 * `{"status":"error"}`. The reason is recorded in the protected audit log,
 * which is never mounted into the agent or a probe.
 *
 * Invocations are serialized. That bounds concurrent resource use and removes
 * any cross-invocation race in workspace creation/teardown/ledger access.
 */

function createBroker(params) {
  const { config, seedMap, runId, audit } = params;
  const workspace = params.workspace || defaultWorkspace;
  const runner = params.runner || defaultRunner;
  const clock = params.clock || createRealClock();
  const ledger = params.ledger || createLedger(seedMap);

  let invocationsUsed = 0;
  let tail = Promise.resolve();

  /**
   * Executes one request and reports its canonical result through
   * `respond` (called exactly once). The invocations run only through
   * validation, ledger debit, workspace creation, probe launch, and result
   * validation actually reach the point where the response must be
   * time-bucketed; everything rejected before that responds immediately.
   */
  async function execute(request, respond) {
    const invocationId = crypto.randomBytes(12).toString('hex');
    let responded = false;
    const safeRespond = (json) => {
      if (responded) return;
      responded = true;
      respond(json);
    };

    const validation = validateSealedProbeRequest(request);
    if (!validation.valid) {
      audit.failure(invocationId, 'invalid-request', validation.errors.join('; '));
      safeRespond(CANONICAL_ERROR_JSON);
      return;
    }
    const { privateRepo, schema, script } = validation.request;
    const repoKey = privateRepo.toLowerCase();

    const seed = seedMap.get(repoKey);
    if (!seed) {
      audit.failure(invocationId, 'repo-not-allowed', privateRepo);
      safeRespond(CANONICAL_ERROR_JSON);
      return;
    }

    // Compute and debit the charge for THIS invocation's schema *before*
    // copying a seed or launching Python. Every invocation may declare a
    // different schema; there is no separate per-query cap — only whether
    // this charge fits the repository's remaining run balance.
    const charge = queryBitsForSchema(schema);
    if (!ledger.tryDebit(repoKey, charge)) {
      audit.failure(invocationId, 'bit-budget-exhausted', `repo=${privateRepo} charge=${charge}`);
      safeRespond(CANONICAL_ERROR_JSON);
      return;
    }

    // From here on the charge is committed (never refunded) and every
    // response must be time-bucketed: workspace creation and probe
    // execution both run against secret repository content, so their
    // latency alone is a signal.
    const startMs = clock.nowMs();

    let layout;
    let failureReason;
    let canonicalResult;

    try {
      layout = workspace.createInvocationWorkspace({
        config,
        invocationId,
        seedId: seed.seedId,
        script,
      });
    } catch (error) {
      failureReason = ['workspace-create-failed', error.message];
    }

    if (layout) {
      const remainingMs = config.timeoutSeconds * 1000 - (clock.nowMs() - startMs);
      if (remainingMs <= 0) {
        failureReason = ['timeout', 'workspace-creation-overran-deadline'];
      } else {
        try {
          const run = await runner.runProbeContainer({ config, runId, invocationId, timeoutMs: remainingMs });
          if (run.timedOut) {
            failureReason = ['timeout'];
          } else if (run.exitCode !== 0) {
            failureReason = ['non-zero-exit', `exit=${run.exitCode}`];
          } else {
            const raw = workspace.readProbeOutput(layout.outPath);
            if (raw === undefined) {
              // Covers a missing file, an oversized file, invalid UTF-8, and
              // any non-regular replacement (symlink/FIFO/device/socket).
              failureReason = ['unreadable-output'];
            } else {
              const parsed = parseAndValidateProbeOutput(raw, schema);
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

    // Teardown is part of the observable operation: repository size and tree
    // shape can affect deletion time, and queued requests must not expose that
    // duration outside the charged timing bucket. Destroy by invocation id
    // even when creation threw after materializing only part of the workspace.
    if (!safeDestroy(invocationId)) {
      failureReason = ['cleanup-failed'];
      canonicalResult = undefined;
    }

    const elapsedMs = clock.nowMs() - startMs;
    const { bucketMs, overflowed } = await waitForBucket(startMs, elapsedMs, clock);

    if (overflowed) {
      // Fail closed: processing (not the script itself, whose timeout
      // preserves a final-bucket post-processing margin) overran every
      // configured bucket — pathological infrastructure latency. Never emit a
      // successful result at unbucketed timing.
      audit.failure(invocationId, 'timing-bucket-overflow', failureReason ? failureReason.join(':') : undefined);
      safeRespond(CANONICAL_ERROR_JSON);
    } else if (canonicalResult !== undefined) {
      audit.invocation({
        invocationId,
        repo: privateRepo,
        sensitivity: seed.sensitivity,
        bits: charge,
        bucketMs,
      });
      safeRespond(canonicalOkJson(canonicalResult));
    } else {
      audit.failure(invocationId, failureReason ? failureReason[0] : 'unknown', failureReason ? failureReason[1] : undefined);
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
    /**
     * Handles one request. `respond` is called exactly once with the
     * canonical result JSON, as soon as it is ready to send (which, for any
     * invocation that reached workspace creation, is exactly at a timing
     * bucket boundary — never earlier). The returned promise resolves once
     * all broker-side bookkeeping for the invocation (including workspace
     * cleanup) is complete; it carries no value and exists only to let the
     * caller serialize/await broker shutdown.
     *
     * Requests are queued so at most one probe runs at a time.
     */
    handle(request, respond) {
      let responded = false;
      const safeRespond = (json) => {
        if (responded) return;
        responded = true;
        respond(json);
      };

      // The invocation-count cap is operational and independent of the bit
      // ledger: it is consumed per *response*, not per launch, so every
      // response the agent observes — including a rejection — counts
      // against it.
      if (invocationsUsed >= config.maxInvocations) {
        audit.failure('budget', 'invocation-count-exhausted', `max=${config.maxInvocations}`);
        safeRespond(CANONICAL_ERROR_JSON);
        return Promise.resolve();
      }
      invocationsUsed += 1;

      const queued = tail.then(() => execute(request, safeRespond)).catch((error) => {
        audit.failure('queue', 'unexpected-error', error && error.message);
        safeRespond(CANONICAL_ERROR_JSON);
      });
      tail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },

    /** @internal Exposed for tests. */
    get invocationsUsed() {
      return invocationsUsed;
    },

    /** @internal Exposed for tests. */
    ledger,
  };
}

module.exports = { createBroker };
