/**
 * AWF-private admission channel between the enclave MCP broker and the AWF
 * host process, for dynamic GitHub-MCP-backed enclaves (ADR 0001).
 *
 * ## Why a file channel
 *
 * gh-aw publishes mcpg's delegation control listener on the runner's own
 * loopback interface (`docker run -p 127.0.0.1:<port>:<port>`), and gh-aw's own
 * comment records the intent: "Only the AWF host process receives this
 * variable". No container — not the broker, not the executor, not the model
 * sidecar — can route to a `127.0.0.1`-published port, so the control client
 * necessarily lives in the AWF host process.
 *
 * The broker still has to route each `enclave_run_agent` through canonical
 * admission *before* any repository content is exposed. It therefore asks the
 * host over an AWF-private request/response directory that is already part of
 * the `0700` enclave private root and is bind-mounted only into the broker.
 * There is no network listener, so nothing new becomes reachable from
 * `awf-net`, the enclave agent network, the general MCP route, or the host's
 * external interfaces.
 *
 * ## What crosses the channel
 *
 * Broker → host: the canonical selector chosen by the invocation, the exact
 * finite output-schema hash, and the settlement of a finished invocation.
 * Host → broker: one canonical denial, or one repository plus one short-lived
 * executor bearer and its read mode.
 *
 * Never: the control endpoint, the control capability, the identity handle,
 * the compiler envelope, mcpg's state path or generation, the job token, or
 * repository content.
 */

/** Wire version. A mismatch is terminal on both sides; there is no migration. */
export const DELEGATION_CHANNEL_VERSION = 1;

/** Bound on any single channel document, in bytes. */
export const DELEGATION_CHANNEL_MAX_BYTES = 8 * 1024;

export const DELEGATION_CHANNEL_REQUEST_SUFFIX = '.admit.json';
export const DELEGATION_CHANNEL_RESPONSE_SUFFIX = '.admitted.json';
export const DELEGATION_CHANNEL_SETTLE_SUFFIX = '.settle.json';
export const DELEGATION_CHANNEL_RECEIPT_SUFFIX = '.settled.json';

/** Broker-generated invocation identifier shape (12 random bytes, hex). */
export const DELEGATION_INVOCATION_ID_PATTERN = /^[0-9a-f]{16,64}$/;

/** Lowercase hex SHA-256 of the invocation's canonical finite output schema. */
export const DELEGATION_SCHEMA_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Terminal outcomes the broker reports. Every one of them settles the
 * reserved quota and revokes the delegated identity; only `success` may be
 * paired with a success-shaped tool result, and only once the receipt confirms
 * revocation.
 */
export const DELEGATION_TERMINAL_OUTCOMES = Object.freeze([
  'success',
  'agent-failure',
  'schema-failure',
  'timeout',
  'cancelled',
  'broker-error',
] as const);

export type DelegationTerminalOutcome = typeof DELEGATION_TERMINAL_OUTCOMES[number];

/** Whether repository reads for an invocation are pinned or live. */
export type DelegationReadMode = 'pinned' | 'live';

export interface DelegationAdmissionRequestMessage {
  version: typeof DELEGATION_CHANNEL_VERSION;
  invocationId: string;
  /** Caller-supplied selector, forwarded verbatim for canonical matching. */
  selector: string;
  schemaHash: string;
}

export type DelegationAdmissionResponseMessage =
  | {
    version: typeof DELEGATION_CHANNEL_VERSION;
    invocationId: string;
    admitted: true;
    repository: string;
    executorBearer: string;
    expiresAt: string;
    readMode: DelegationReadMode;
    admittedDefaultBranchSha?: string;
  }
  | {
    version: typeof DELEGATION_CHANNEL_VERSION;
    invocationId: string;
    admitted: false;
    reason: string;
  };

export interface DelegationSettlementMessage {
  version: typeof DELEGATION_CHANNEL_VERSION;
  invocationId: string;
  outcome: DelegationTerminalOutcome;
  outputBytes: number;
  executionSeconds: number;
}

export interface DelegationSettlementReceiptMessage {
  version: typeof DELEGATION_CHANNEL_VERSION;
  invocationId: string;
  settled: true;
  /**
   * Whether the delegated identity is definitively revoked. `false` means the
   * control plane is in an unresolved state: the broker must not return a
   * success-shaped result, and AWF blocks further admissions until
   * reconciliation succeeds.
   */
  revoked: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strictly parses a broker admission request. Returns `undefined` if invalid. */
export function parseDelegationAdmissionRequest(
  raw: unknown,
): DelegationAdmissionRequestMessage | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { version, invocationId, selector, schemaHash } = raw;
  if (version !== DELEGATION_CHANNEL_VERSION) return undefined;
  if (typeof invocationId !== 'string' || !DELEGATION_INVOCATION_ID_PATTERN.test(invocationId)) {
    return undefined;
  }
  // The selector is deliberately *not* pattern-checked here: a malformed
  // selector must reach the registry so it produces the same canonical
  // denial, at the same normalized timing, as an out-of-policy one.
  if (typeof selector !== 'string' || selector.length > 256) return undefined;
  if (typeof schemaHash !== 'string' || !DELEGATION_SCHEMA_HASH_PATTERN.test(schemaHash)) {
    return undefined;
  }
  return { version: DELEGATION_CHANNEL_VERSION, invocationId, selector, schemaHash };
}

/** Strictly parses a broker settlement report. Returns `undefined` if invalid. */
export function parseDelegationSettlement(
  raw: unknown,
): DelegationSettlementMessage | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { version, invocationId, outcome, outputBytes, executionSeconds } = raw;
  if (version !== DELEGATION_CHANNEL_VERSION) return undefined;
  if (typeof invocationId !== 'string' || !DELEGATION_INVOCATION_ID_PATTERN.test(invocationId)) {
    return undefined;
  }
  if (
    typeof outcome !== 'string'
    || !(DELEGATION_TERMINAL_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    return undefined;
  }
  if (!Number.isSafeInteger(outputBytes) || (outputBytes as number) < 0) return undefined;
  if (!Number.isSafeInteger(executionSeconds) || (executionSeconds as number) < 0) return undefined;
  return {
    version: DELEGATION_CHANNEL_VERSION,
    invocationId,
    outcome: outcome as DelegationTerminalOutcome,
    outputBytes: outputBytes as number,
    executionSeconds: executionSeconds as number,
  };
}
