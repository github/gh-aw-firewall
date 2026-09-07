'use strict';

const fs = require('fs');
const path = require('path');
const { finiteSchemaHash } = require('../../bounded-execution/schema-hash');

/**
 * Broker side of the AWF-private dynamic delegation channel.
 *
 * The broker never holds the mcpg delegation-control endpoint or capability:
 * gh-aw publishes that listener on the *runner's* `127.0.0.1` only, which no
 * container can route to. Instead the broker asks the AWF host process, over a
 * `0700` directory bind-mounted only into this container, to run canonical
 * admission and mint the invocation's delegated identity.
 *
 * What the broker sends: the caller's selector verbatim, the exact finite
 * output-schema hash, and — after the enclave finishes — the terminal outcome
 * with its actual output-byte and execution-second usage.
 *
 * What the broker receives: one canonical denial, or one repository plus one
 * short-lived executor bearer and its read mode. It never receives the control
 * endpoint, the control capability, the identity handle, the compiler
 * envelope, mcpg's state path, or its policy generation.
 */

const CHANNEL_VERSION = 1;
const MAX_MESSAGE_BYTES = 8 * 1024;
const REQUEST_SUFFIX = '.admit.json';
const RESPONSE_SUFFIX = '.admitted.json';
const SETTLE_SUFFIX = '.settle.json';
const RECEIPT_SUFFIX = '.settled.json';
const POLL_INTERVAL_MS = 20;

/** Admission must resolve well inside the smallest useful timing bucket. */
const DEFAULT_ADMISSION_TIMEOUT_MS = 60_000;
/** Settlement is a single loopback revoke; it must not stall teardown. */
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 30_000;

const TERMINAL_OUTCOMES = new Set([
  'success',
  'agent-failure',
  'schema-failure',
  'timeout',
  'cancelled',
  'broker-error',
]);

function writeAtomic(target, value) {
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
}

function readBounded(target) {
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MESSAGE_BYTES) return undefined;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Waits for `target` to appear, up to `timeoutMs`. Returns the parsed document
 * or `undefined`; the caller fails closed on `undefined`.
 */
async function awaitDocument(target, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const document = readBounded(target);
    if (document !== undefined) {
      fs.rmSync(target, { force: true });
      return document;
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Creates the broker's admission client for one dynamic enclave entry.
 *
 * `config.dynamicSensitivity` is trusted broker configuration derived from the
 * compiler envelope; an invocation can never express or widen it.
 */
function createDynamicDelegationClient(config, deps = {}) {
  const directory = config.dynamicChannelDir;
  const pollIntervalMs = deps.pollIntervalMs || POLL_INTERVAL_MS;
  const admissionTimeoutMs = deps.admissionTimeoutMs || DEFAULT_ADMISSION_TIMEOUT_MS;
  const settlementTimeoutMs = deps.settlementTimeoutMs || DEFAULT_SETTLEMENT_TIMEOUT_MS;

  return {
    sensitivity: config.dynamicSensitivity,

    /**
     * Routes one invocation through AWF's canonical admission.
     *
     * Returns `{ admitted: false }` for every failure — malformed selector,
     * out-of-policy owner, exhausted quota, control denial, control outage, or
     * a missing/unparsable reply — so the caller emits the single canonical
     * error with no distinguishing detail.
     */
    async admit({ invocationId, selector, schema }) {
      const requestPath = path.join(directory, `${invocationId}${REQUEST_SUFFIX}`);
      const responsePath = path.join(directory, `${invocationId}${RESPONSE_SUFFIX}`);
      try {
        writeAtomic(requestPath, {
          version: CHANNEL_VERSION,
          invocationId,
          selector,
          schemaHash: finiteSchemaHash(schema),
        });
      } catch {
        return { admitted: false };
      }
      const response = await awaitDocument(responsePath, admissionTimeoutMs, pollIntervalMs);
      if (!response || response.version !== CHANNEL_VERSION) return { admitted: false };
      if (response.invocationId !== invocationId || response.admitted !== true) {
        return { admitted: false };
      }
      const { repository, executorBearer, readMode } = response;
      if (
        typeof repository !== 'string'
        || repository !== selector
        || typeof executorBearer !== 'string'
        || executorBearer.length === 0
        || (readMode !== 'live' && readMode !== 'pinned')
      ) {
        return { admitted: false };
      }
      return {
        admitted: true,
        repo: repository,
        executorBearer,
        readMode,
        sensitivity: config.dynamicSensitivity,
      };
    },

    /**
     * Reports one invocation's terminal outcome and actual usage, and waits
     * for AWF's receipt.
     *
     * `revoked !== true` means the delegated identity's state is unresolved;
     * the caller must not return a success-shaped result, because a bearer
     * that may still be live has already touched repository content.
     */
    async settle({ invocationId, outcome, outputBytes, executionSeconds }) {
      const settlePath = path.join(directory, `${invocationId}${SETTLE_SUFFIX}`);
      const receiptPath = path.join(directory, `${invocationId}${RECEIPT_SUFFIX}`);
      const terminalOutcome = TERMINAL_OUTCOMES.has(outcome) ? outcome : 'broker-error';
      try {
        writeAtomic(settlePath, {
          version: CHANNEL_VERSION,
          invocationId,
          outcome: terminalOutcome,
          outputBytes: Math.max(0, Math.trunc(outputBytes) || 0),
          executionSeconds: Math.max(0, Math.trunc(executionSeconds) || 0),
        });
      } catch {
        return { settled: false, revoked: false };
      }
      const receipt = await awaitDocument(receiptPath, settlementTimeoutMs, pollIntervalMs);
      if (
        !receipt
        || receipt.version !== CHANNEL_VERSION
        || receipt.invocationId !== invocationId
        || receipt.settled !== true
      ) {
        return { settled: false, revoked: false };
      }
      return { settled: true, revoked: receipt.revoked === true };
    },
  };
}

module.exports = {
  CHANNEL_VERSION,
  DEFAULT_ADMISSION_TIMEOUT_MS,
  DEFAULT_SETTLEMENT_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  RECEIPT_SUFFIX,
  REQUEST_SUFFIX,
  RESPONSE_SUFFIX,
  SETTLE_SUFFIX,
  createDynamicDelegationClient,
};
