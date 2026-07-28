'use strict';

const crypto = require('crypto');
const {
  CANONICAL_ERROR_RESULT_JSON,
  canonicalizeSealedProbeResult,
  parseSealedProbeResult,
  validateSealedProbeRequest,
} = require('./protocol');
const defaultWorkspace = require('./workspace');
const defaultRunner = require('./probe-runner');

/**
 * The trusted sealed-probe broker.
 *
 * Responsibilities, in order, for every request:
 *
 *  1. consume one unit of the per-run invocation budget (atomically — Node's
 *     single-threaded event loop makes the check-and-increment indivisible
 *     because there is no `await` between them);
 *  2. validate the request against the fixed protocol *before* any repository
 *     is copied or any container is launched;
 *  3. map the normalized repo id through AWF's static seed map to an opaque
 *     seed directory the caller never sees or names;
 *  4. build a fresh private writable copy and launch the probe with a fixed
 *     argument vector;
 *  5. strictly validate and canonically re-serialize the result;
 *  6. destroy the copy.
 *
 * Every failure at every step produces the identical canonical
 * `{"result":"ERROR"}`. The reason is recorded in the protected audit log,
 * which is never mounted into the agent or a probe.
 *
 * Invocations are serialized. That bounds concurrent resource use and removes
 * any cross-invocation race in workspace creation/teardown.
 */

function createBroker(params) {
  const { config, seedMap, runId, audit } = params;
  const workspace = params.workspace || defaultWorkspace;
  const runner = params.runner || defaultRunner;

  let invocationsUsed = 0;
  let tail = Promise.resolve();

  async function execute(request) {
    const invocationId = crypto.randomBytes(12).toString('hex');

    const validation = validateSealedProbeRequest(request);
    if (!validation.valid) {
      audit.failure(invocationId, 'invalid-request', validation.errors.join('; '));
      return CANONICAL_ERROR_RESULT_JSON;
    }

    const seedId = seedMap.get(request.privateRepo.toLowerCase());
    if (!seedId) {
      audit.failure(invocationId, 'repo-not-allowed', request.privateRepo);
      return CANONICAL_ERROR_RESULT_JSON;
    }

    let layout;
    try {
      layout = workspace.createInvocationWorkspace({
        config,
        invocationId,
        seedId,
        script: request.script,
      });
    } catch (error) {
      audit.failure(invocationId, 'workspace-create-failed', error.message);
      safeDestroy(invocationId);
      return CANONICAL_ERROR_RESULT_JSON;
    }

    let result = CANONICAL_ERROR_RESULT_JSON;
    try {
      const run = await runner.runProbeContainer({ config, runId, invocationId });

      if (run.timedOut) {
        audit.failure(invocationId, 'timeout');
      } else if (run.exitCode !== 0) {
        audit.failure(invocationId, 'non-zero-exit', `exit=${run.exitCode}`);
      } else {
        const raw = workspace.readProbeOutput(layout.outPath);
        if (raw === undefined) {
          // Covers a missing file, an oversized file, invalid UTF-8, and any
          // non-regular replacement (symlink/FIFO/device/socket).
          audit.failure(invocationId, 'unreadable-output');
        } else {
          const parsed = parseSealedProbeResult(raw, request.outcomes);
          if (parsed.result === 'ERROR') {
            audit.failure(invocationId, 'nonconformant-output');
          } else {
            audit.invocation({ invocationId, repo: request.privateRepo });
            // Never echo probe bytes: re-serialize the validated symbol ourselves.
            result = canonicalizeSealedProbeResult(parsed.result);
          }
        }
      }
    } catch (error) {
      audit.failure(invocationId, 'launch-failed', error.message);
    }

    if (!safeDestroy(invocationId)) {
      return CANONICAL_ERROR_RESULT_JSON;
    }
    return result;
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
     * Handles one request and resolves to the canonical result JSON.
     *
     * Requests are queued so at most one probe runs at a time.
     */
    handle(request) {
      // Budget is consumed per *response*, not per launch: every response the
      // agent observes is one of the four symbols, so every response — including
      // a rejection — is what the budget bounds.
      if (invocationsUsed >= config.maxInvocations) {
        audit.failure('budget', 'budget-exhausted', `max=${config.maxInvocations}`);
        return Promise.resolve(CANONICAL_ERROR_RESULT_JSON);
      }
      invocationsUsed += 1;

      const queued = tail.then(() => execute(request)).catch((error) => {
        audit.failure('queue', 'unexpected-error', error && error.message);
        return CANONICAL_ERROR_RESULT_JSON;
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
  };
}

module.exports = { createBroker };
