'use strict';

const crypto = require('crypto');

function createExecutorSettlement({ admission, audit, config, runner, workspace, state }) {
  /** Invocations already settled, so a retry can never double-settle. */
  const settledInvocations = new Set();
  /** Invocations that reached dynamic admission and therefore own an identity. */
  const admittedInvocations = new Set();
  const activeCancellations = new Set();

  /**
   * Settles one dynamic invocation exactly once. Reports whether AWF confirmed
   * revocation; an unconfirmed revocation is never treated as success.
   */
  async function settleDynamic(invocationId, outcome, outputBytes, executionSeconds) {
    if (!admission || settledInvocations.has(invocationId)) {
      return { settled: true, revoked: true };
    }
    settledInvocations.add(invocationId);
    try {
      return await admission.settle({ invocationId, outcome, outputBytes, executionSeconds });
    } catch (error) {
      audit.failure(invocationId, 'dynamic-settlement-failed', error.message);
      return { settled: false, revoked: false };
    }
  }

  async function withCancellation(externalSignal, invoke) {
    const invocationId = crypto.randomBytes(12).toString('hex');
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    if (runner.hostOwned) {
      externalSignal?.addEventListener('abort', abort);
      if (externalSignal?.aborted) abort();
    }
    activeCancellations.add(cancellation);
    try {
      await invoke(invocationId, cancellation.signal);
    } finally {
      activeCancellations.delete(cancellation);
      if (runner.hostOwned) externalSignal?.removeEventListener('abort', abort);
      // A dynamic invocation that reached admission must always settle its
      // reservation and revoke its identity, even if an unexpected error
      // escaped the pipeline. `settleDynamic` is a no-op once an invocation
      // has already settled, so this can never double-charge or double-revoke.
      if (admission && admittedInvocations.has(invocationId)) {
        await settleDynamic(invocationId, 'broker-error', 0, 0);
      }
    }
  }

  function safeDestroy(invocationId) {
    if (runner.hostOwned) return true;
    try {
      workspace.destroyInvocationWorkspace(config.workDir, invocationId);
      return true;
    } catch (error) {
      audit.failure(invocationId, 'cleanup-failed', error.message);
      return false;
    }
  }

  return {
    settleDynamic,
    withCancellation,
    safeDestroy,
    markAdmitted(invocationId) {
      admittedInvocations.add(invocationId);
    },
    /** Stops admissions and cancels any active runtime invocation. */
    close() {
      state.accepting = false;
      for (const cancellation of activeCancellations) cancellation.abort();
    },
  };
}

module.exports = { createExecutorSettlement };
