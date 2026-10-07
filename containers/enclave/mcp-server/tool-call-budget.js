'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Optional run-wide cap on enclave tool calls (cost control).
 *
 * The cap is trusted AWF configuration (`--max-num-tool-calls`), is shared by
 * every enclave tool the server publishes, and is independent of the
 * per-executor `maxInvocations` and per-repository disclosure budgets. Every
 * *attempted* well-formed tool call — including calls that are later rejected
 * as busy, oversized, invalid, or failed — consumes one unit. Once the cap is
 * exhausted, further calls are denied in-band with {@link TOOL_CALL_CAP_MESSAGE}
 * and never reach an executor.
 *
 * The decision depends only on how many calls the caller has already made and
 * on the trusted limit, never on repository content, so the distinct denial
 * message discloses nothing the caller does not already know.
 *
 * The counter is persisted in the broker's private control directory, keyed by
 * the AWF run id, so a restarted broker for the same run resumes the count
 * instead of resetting it.
 */

const TOOL_CALL_CAP_MESSAGE =
  'Max tool call count reached, no more tool calls are allowed. '
  + 'Make a decision based on what you already have in context.';

const TOOL_CALL_BUDGET_STATE_VERSION = 1;

/** Advisory sentence appended to published tool descriptions. */
function toolCallCapAdvisory(maxToolCalls) {
  return `You are allowed to make at most ${maxToolCalls} enclave tool calls in this run. `
    + 'After that, the system will deny any further enclave tool calls.';
}

function readPersistedCount(statePath, runId, files) {
  if (!statePath) return 0;
  let raw;
  try {
    raw = files.readFileSync(statePath, 'utf8');
  } catch {
    return 0;
  }
  try {
    const state = JSON.parse(raw);
    if (
      state
      && state.version === TOOL_CALL_BUDGET_STATE_VERSION
      && state.runId === runId
      && Number.isSafeInteger(state.used)
      && state.used >= 0
    ) {
      return state.used;
    }
  } catch {
    // A corrupt state file is treated as a fresh run for this run id.
  }
  return 0;
}

function writePersistedCount(statePath, runId, used, files) {
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  files.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  try {
    files.writeFileSync(
      tmpPath,
      JSON.stringify({ version: TOOL_CALL_BUDGET_STATE_VERSION, runId, used }),
      { mode: 0o600 },
    );
    files.renameSync(tmpPath, statePath);
  } catch (error) {
    try {
      files.rmSync(tmpPath, { force: true });
    } catch {
      // The original write error is the useful diagnostic.
    }
    throw error;
  }
}

/**
 * Creates the run-wide tool-call budget, or `undefined` when no finite limit
 * is configured (the default): no counter, no persistence, no advisory text.
 *
 * @param {{
 *   maxToolCalls?: number,
 *   runId?: string,
 *   statePath?: string,
 *   files?: typeof fs,
 *   warn?: (message: string) => void,
 * }} options
 */
function createToolCallBudget(options = {}) {
  const { maxToolCalls, runId, statePath } = options;
  if (maxToolCalls === undefined) return undefined;
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1) {
    throw new Error('maxToolCalls must be a positive integer');
  }
  const files = options.files || fs;
  const warn = options.warn
    || ((message) => process.stderr.write(`[awf-enclave] WARN ${message}\n`));
  let used = readPersistedCount(statePath, runId, files);
  let denialWarned = false;

  function persist() {
    if (!statePath) return;
    try {
      writePersistedCount(statePath, runId, used, files);
    } catch (error) {
      // The in-memory count keeps enforcing the cap for this process.
      warn(`Unable to persist enclave tool call count: ${error && error.message}`);
    }
  }

  return {
    limit: maxToolCalls,
    advisory: toolCallCapAdvisory(maxToolCalls),

    /** Number of attempted tool calls already counted against the cap. */
    used() {
      return used;
    },

    /**
     * Counts one attempted tool call. Returns `true` when the call may
     * proceed and `false` when the cap is exhausted. Node's single-threaded
     * event loop makes this check-and-increment indivisible.
     */
    tryConsume(toolName, agentName) {
      if (used >= maxToolCalls) {
        // Warn once so a model that keeps retrying cannot flood the logs.
        if (denialWarned) return false;
        denialWarned = true;
        warn(`Max tool call count reached. ${JSON.stringify({
          toolName,
          agentName,
          sessionID: runId,
          maxToolCalls,
        })}`);
        return false;
      }
      used += 1;
      persist();
      return true;
    },
  };
}

module.exports = {
  TOOL_CALL_BUDGET_STATE_VERSION,
  TOOL_CALL_CAP_MESSAGE,
  createToolCallBudget,
  toolCallCapAdvisory,
};
