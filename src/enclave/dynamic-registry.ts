/**
 * AWF-owned mutable registry for dynamic GitHub-MCP-backed enclave repository
 * admission (ADR 0001 `docs/adr/0001-agent-enclaves.md`).
 *
 * This module implements the registry-side invariants AWF alone can enforce
 * from an already-validated `enclaves[].dynamic` policy envelope: canonical
 * selector matching, `maxRepositories`, expiry, atomic reservation and debit of
 * every compiler-owned run-wide quota, registration into the *shared* live
 * per-repository information ledger that static executors already debit,
 * idempotent admission keyed by `(run, enclave entry, invocation id, canonical
 * repository)`, and a single non-disclosing canonical denial whose wall-clock
 * cost is normalized to a fixed bucket.
 *
 * It deliberately does **not** perform the mcpg control-channel delegation
 * calls ADR 0001 describes. No released compiler starts mcpg's
 * `github-repository-delegation-v1` controller or hands AWF its control
 * endpoint, so `validateEnclavesConfig` refuses any run that declares
 * `enclaves[].dynamic` (see `DYNAMIC_ENCLAVE_EXECUTION_UNSUPPORTED_REASON` in
 * `./preflight`). This registry is the admission half of that contract, kept
 * complete and tested so the control-plane client is the only remaining work
 * once the endpoint handoff lands upstream.
 */

import * as crypto from 'crypto';
import {
  CANONICAL_DYNAMIC_REPOSITORY_PATTERN,
  type EnclaveDynamicPolicy,
} from '../types/enclave-options';
import { TIMING_BUCKETS_MS } from '../bounded-execution';
import type { EnclaveInformationBudgetLedger } from './information-budget';

/** Single non-disclosing outcome returned for every admission failure. */
export const CANONICAL_DENIAL_REASON = 'enclave dynamic repository admission denied';

/**
 * AWF-only mcpg delegation-control capability, minted by the compiler during
 * startup for create/confirm/revoke calls on the private mcpg control
 * channel. This value must never be mounted into the primary or enclave
 * agent; {@link takeEnclaveDynamicDelegationCapability} removes it from the
 * given environment once read.
 */
export const ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY_ENV =
  'AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY';
export const ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT_ENV =
  'AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT';

/** Validates the compiler-to-AWF private control listener handoff. */
export function isValidEnclaveDynamicDelegationControlEndpoint(
  value: string | undefined,
): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return false;
  }
  return endpoint.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    && !endpoint.username
    && !endpoint.password
    && !endpoint.search
    && !endpoint.hash
    && endpoint.port !== '';
}

/**
 * Reads and deletes the delegation-control capability from `env` so it can
 * never leak into an inherited environment after this call. Returns
 * `undefined` if absent.
 */
export function takeEnclaveDynamicDelegationCapability(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY_ENV];
  delete env[ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY_ENV];
  return value;
}

/** Whether a value is a well-formed run-scoped 256-bit lowercase hex capability. */
export function isValidEnclaveDynamicDelegationCapability(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export type DynamicAdmissionOutcome =
  | {
    admitted: true;
    repo: string;
    defaultBranchSha: string;
    /**
     * Opaque handle for {@link DynamicRepositoryRegistry.commitUsage}. Equal
     * to the idempotency key, so a retried admission settles the same charge.
     */
    usageHandle: string;
  }
  | { admitted: false; reason: typeof CANONICAL_DENIAL_REASON };

export interface DynamicAdmissionRequest {
  runId: string;
  entryId: string;
  invocationId: string;
  /** Caller-supplied selector, validated for exact canonical form before matching. */
  selector: string;
}

/** Actual per-invocation usage reported once an admitted invocation finishes. */
export interface DynamicAdmissionUsage {
  /** Response bytes the invocation actually emitted. */
  outputBytes: number;
  /** Wall-clock seconds the invocation actually consumed. */
  executionSeconds: number;
}

/** Read-only view of an envelope's run-wide quota consumption. */
export interface DynamicQuotaUsage {
  invocations: { debited: number; reserved: number; limit: number };
  outputBytes: { debited: number; reserved: number; limit: number };
  executionSeconds: { debited: number; reserved: number; limit: number };
}

/** Resolves the admitted repository's default-branch SHA. Injectable for tests. */
export type DefaultBranchResolver = (repo: string) => Promise<string> | string;

/**
 * Injectable elapsed-time source used only for admission timing normalization,
 * so tests can assert the fixed bucket exactly instead of racing real timers.
 * Policy expiry is always evaluated against the real wall clock.
 */
export interface DynamicAdmissionClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

/** Secret-independent jitter in `[0, 1000]` milliseconds. */
export type DynamicAdmissionJitterSource = () => number;

export interface DynamicRepositoryRegistryOptions {
  policy: EnclaveDynamicPolicy;
  resolveDefaultBranchSha: DefaultBranchResolver;
  /**
   * The live per-repository information ledger static executors already debit.
   * Dynamic admission registers into this same ledger so an admitted
   * repository cannot fork or refill a disclosure budget by switching
   * admission modes.
   */
  ledger: EnclaveInformationBudgetLedger;
  clock?: DynamicAdmissionClock;
  jitter?: DynamicAdmissionJitterSource;
}

/** Raised when reported usage cannot be reconciled against a live reservation. */
export class DynamicUsageAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DynamicUsageAccountingError';
  }
}

const DEFAULT_CLOCK: DynamicAdmissionClock = {
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, ms)); }),
};

/** Uniform, secret-independent jitter in `[0, 1000]` ms. */
const DEFAULT_JITTER: DynamicAdmissionJitterSource = () => crypto.randomInt(0, 1001);

/**
 * Whether a selector is the exact canonical UTF-8 byte sequence ADR 0001
 * requires: no trimming, case folding, Unicode normalization, URL decoding,
 * or alternate syntax before policy matching.
 */
export function isCanonicalDynamicSelector(selector: string): boolean {
  return typeof selector === 'string' && CANONICAL_DYNAMIC_REPOSITORY_PATTERN.test(selector);
}

function ownerOf(selector: string): string {
  return selector.slice(0, selector.indexOf('/'));
}

function selectorAllowedByPolicy(policy: EnclaveDynamicPolicy, selector: string): boolean {
  if (policy.allowedRepositories.includes(selector)) return true;
  return policy.allowedOwners.includes(ownerOf(selector));
}

function invocationKeyOf(request: DynamicAdmissionRequest): string {
  return [request.runId, request.entryId, request.invocationId].join('\u0000');
}

function admissionKey(request: DynamicAdmissionRequest): string {
  return [invocationKeyOf(request), request.selector].join('\u0000');
}

/**
 * Resolves the fixed response-timing bucket (plus secret-independent random
 * jitter) that a canonical denial or admission must appear to take, so
 * elapsed wall-clock time never distinguishes malformed, inaccessible,
 * nonexistent, expired, over-quota, and out-of-policy selectors from one
 * another. See `docs/awf-config-spec.md` §14 for the fixed bucket list.
 */
export function resolveDenialTimingBucketMs(
  elapsedMs: number,
  jitter: DynamicAdmissionJitterSource = DEFAULT_JITTER,
): number {
  const largest = TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1];
  const bucket = TIMING_BUCKETS_MS.find((candidate) => elapsedMs <= candidate) ?? largest;
  return bucket + jitter();
}

interface RepositoryRefs {
  /** Reservations still resolving; a repository slot stays held while > 0. */
  pending: number;
  /** Whether at least one admission for this repository has committed. */
  admitted: boolean;
}

interface Reservation {
  key: string;
  invocationKey: string;
  selector: string;
  /** Worst-case per-invocation charges held against the run-wide quotas. */
  reservedOutputBytes: number;
  reservedExecutionSeconds: number;
  settled: boolean;
}

/**
 * AWF-owned per-run registry for one dynamic `enclaves[].dynamic` policy
 * envelope. One instance is scoped to one enclave entry for one workflow run;
 * static and dynamic admissions share the run-wide per-repository information
 * ledger passed to the constructor (see `src/enclave/information-budget.ts`
 * and `docs/awf-config-spec.md` §14 for the shared-ledger invariant).
 */
export class DynamicRepositoryRegistry {
  /**
   * Idempotency map. The promise is inserted synchronously, before the first
   * `await`, so concurrent identical retries observe the same in-flight
   * admission instead of independently reserving capacity, and so a request
   * that has already reached a terminal outcome replays it forever.
   */
  private readonly admissions = new Map<string, Promise<DynamicAdmissionOutcome>>();
  private readonly repositories = new Map<string, RepositoryRefs>();
  private readonly boundInvocations = new Map<string, string>();
  private readonly liveReservations = new Map<string, Reservation>();
  private admittedRepositories = 0;

  private debitedInvocations = 0;
  private reservedInvocations = 0;
  private debitedOutputBytes = 0;
  private reservedOutputBytes = 0;
  private debitedExecutionSeconds = 0;
  private reservedExecutionSeconds = 0;
  private reconciled = true;

  private readonly policy: EnclaveDynamicPolicy;
  private readonly resolveDefaultBranchSha: DefaultBranchResolver;
  private readonly ledger: EnclaveInformationBudgetLedger;
  private readonly clock: DynamicAdmissionClock;
  private readonly jitter: DynamicAdmissionJitterSource;

  constructor(options: DynamicRepositoryRegistryOptions) {
    this.policy = options.policy;
    this.resolveDefaultBranchSha = options.resolveDefaultBranchSha;
    this.ledger = options.ledger;
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.jitter = options.jitter ?? DEFAULT_JITTER;
  }

  /** Number of distinct repositories admitted so far under this envelope. */
  get admittedRepositoryCount(): number {
    return this.admittedRepositories;
  }

  /** Run-wide consumption of every compiler-owned quota. */
  get quotaUsage(): DynamicQuotaUsage {
    return {
      invocations: {
        debited: this.debitedInvocations,
        reserved: this.reservedInvocations,
        limit: this.policy.quotas.maxInvocations,
      },
      outputBytes: {
        debited: this.debitedOutputBytes,
        reserved: this.reservedOutputBytes,
        limit: this.policy.quotas.maxOutputBytes,
      },
      executionSeconds: {
        debited: this.debitedExecutionSeconds,
        reserved: this.reservedExecutionSeconds,
        limit: this.policy.quotas.maxExecutionSeconds,
      },
    };
  }

  /**
   * Marks this registry as unable to admit further requests until shutdown
   * reconciliation with mcpg's labelled delegation state completes. Per ADR
   * 0001, AWF must fail closed for new dynamic admissions while outstanding
   * delegated identities are unknown.
   */
  markReconciliationIncomplete(): void {
    this.reconciled = false;
  }

  markReconciled(): void {
    this.reconciled = true;
  }

  /**
   * Atomically validates and admits (or denies) one invocation's selector.
   *
   * Idempotent by `(run, enclave entry, invocation id, canonical repository)`:
   * a retried request with the same key returns the exact same outcome —
   * joining the in-flight admission if one is still resolving — without
   * re-evaluating policy or reserving a second time. A request that reuses an
   * invocation id with a different selector is always denied rather than
   * rebinding the invocation to another repository.
   *
   * `maxRepositories` and all three run-wide quotas are reserved synchronously
   * before any asynchronous default-branch lookup, so two concurrent
   * admissions can never both observe capacity and both commit, regardless of
   * how long the lookup takes.
   *
   * Every outcome — malformed selector, policy denial, resolution failure, or
   * success — is delayed to the same fixed timing bucket plus
   * secret-independent jitter before it is returned.
   */
  admit(request: DynamicAdmissionRequest): Promise<DynamicAdmissionOutcome> {
    const key = admissionKey(request);
    const existing = this.admissions.get(key);
    if (existing) return existing;

    const startedMs = this.clock.nowMs();
    const reservation = this.reserve(key, request);
    const pending = this.resolve(request, reservation, startedMs);
    this.admissions.set(key, pending);
    return pending;
  }

  /**
   * Records the actual charges of an admitted invocation. The worst-case
   * reservation taken at admission is released and replaced by the reported
   * usage. Per ADR 0001 these charges stay committed even if the invocation
   * later fails: the envelope revealed the opportunity to spend them the
   * moment it admitted the repository. Calling this twice for the same handle
   * is a no-op, so a retried settlement can never double-charge.
   */
  commitUsage(usageHandle: string, usage: DynamicAdmissionUsage): void {
    const reservation = this.liveReservations.get(usageHandle);
    if (!reservation) {
      if (this.admissions.has(usageHandle)) return;
      throw new DynamicUsageAccountingError(`Unknown dynamic admission usage handle: ${usageHandle}`);
    }
    if (!Number.isSafeInteger(usage.outputBytes) || usage.outputBytes < 0) {
      throw new DynamicUsageAccountingError('outputBytes must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(usage.executionSeconds) || usage.executionSeconds < 0) {
      throw new DynamicUsageAccountingError('executionSeconds must be a non-negative safe integer');
    }
    if (usage.outputBytes > reservation.reservedOutputBytes) {
      throw new DynamicUsageAccountingError(
        `outputBytes ${usage.outputBytes} exceeds the reserved per-invocation limit `
        + `${reservation.reservedOutputBytes}`,
      );
    }
    if (usage.executionSeconds > reservation.reservedExecutionSeconds) {
      throw new DynamicUsageAccountingError(
        `executionSeconds ${usage.executionSeconds} exceeds the reserved per-invocation limit `
        + `${reservation.reservedExecutionSeconds}`,
      );
    }
    this.reservedOutputBytes -= reservation.reservedOutputBytes;
    this.reservedExecutionSeconds -= reservation.reservedExecutionSeconds;
    this.debitedOutputBytes += usage.outputBytes;
    this.debitedExecutionSeconds += usage.executionSeconds;
    this.liveReservations.delete(usageHandle);
  }

  /**
   * Synchronously validates policy and reserves capacity. Runs entirely
   * without an `await`, so no other admission can interleave between the
   * capacity check and the reservation.
   */
  private reserve(key: string, request: DynamicAdmissionRequest): Reservation | undefined {
    if (!this.reconciled) return undefined;
    if (!isCanonicalDynamicSelector(request.selector)) return undefined;
    const invocationKey = invocationKeyOf(request);
    const boundSelector = this.boundInvocations.get(invocationKey);
    if (boundSelector !== undefined && boundSelector !== request.selector) return undefined;
    if (!selectorAllowedByPolicy(this.policy, request.selector)) return undefined;
    if (Date.parse(this.policy.expiresAt) <= Date.now()) return undefined;

    const quotas = this.policy.quotas;
    const outputBytes = this.policy.limits.maxOutputBytes;
    const executionSeconds = this.policy.limits.timeoutSeconds;
    if (this.debitedInvocations + this.reservedInvocations + 1 > quotas.maxInvocations) return undefined;
    if (this.debitedOutputBytes + this.reservedOutputBytes + outputBytes > quotas.maxOutputBytes) {
      return undefined;
    }
    if (
      this.debitedExecutionSeconds + this.reservedExecutionSeconds + executionSeconds
      > quotas.maxExecutionSeconds
    ) {
      return undefined;
    }

    let refs = this.repositories.get(request.selector);
    if (!refs) {
      if (this.repositories.size + 1 > this.policy.maxRepositories) return undefined;
      refs = { pending: 0, admitted: false };
      this.repositories.set(request.selector, refs);
    }

    refs.pending += 1;
    this.boundInvocations.set(invocationKey, request.selector);
    this.reservedInvocations += 1;
    this.reservedOutputBytes += outputBytes;
    this.reservedExecutionSeconds += executionSeconds;
    return {
      key,
      invocationKey,
      selector: request.selector,
      reservedOutputBytes: outputBytes,
      reservedExecutionSeconds: executionSeconds,
      settled: false,
    };
  }

  /**
   * Commits an admission: the invocation charge becomes permanent, the
   * repository slot transfers from pending to admitted, and the repository
   * opens (or keeps) its balance in the shared information ledger. Byte and
   * execution-second charges stay reserved at their worst case until
   * {@link commitUsage} reports the actual figures.
   */
  private commit(reservation: Reservation): void {
    if (reservation.settled) return;
    reservation.settled = true;
    this.reservedInvocations -= 1;
    this.debitedInvocations += 1;
    const refs = this.repositories.get(reservation.selector);
    if (refs) {
      refs.pending -= 1;
      if (!refs.admitted) {
        refs.admitted = true;
        this.admittedRepositories += 1;
      }
    }
    this.ledger.registerRepository(reservation.selector, this.policy.sensitivity);
    this.liveReservations.set(reservation.key, reservation);
  }

  /**
   * Releases a reservation that never became an admission. The repository slot
   * is only freed once no other in-flight reservation holds it and no
   * admission has committed it, so a rollback can never drop a repository
   * another concurrent request already owns.
   */
  private rollback(reservation: Reservation): void {
    if (reservation.settled) return;
    reservation.settled = true;
    this.reservedInvocations -= 1;
    this.reservedOutputBytes -= reservation.reservedOutputBytes;
    this.reservedExecutionSeconds -= reservation.reservedExecutionSeconds;
    const refs = this.repositories.get(reservation.selector);
    if (refs) {
      refs.pending -= 1;
      if (refs.pending === 0 && !refs.admitted) {
        this.repositories.delete(reservation.selector);
      }
    }
    if (this.boundInvocations.get(reservation.invocationKey) === reservation.selector && !refs?.admitted) {
      this.boundInvocations.delete(reservation.invocationKey);
    }
  }

  private async resolve(
    request: DynamicAdmissionRequest,
    reservation: Reservation | undefined,
    startedMs: number,
  ): Promise<DynamicAdmissionOutcome> {
    if (!reservation) return this.normalizeTiming(startedMs, this.deny());
    try {
      const defaultBranchSha = await this.resolveDefaultBranchSha(request.selector);
      if (typeof defaultBranchSha !== 'string' || defaultBranchSha.length === 0) {
        this.rollback(reservation);
        return this.normalizeTiming(startedMs, this.deny());
      }
      this.commit(reservation);
      return this.normalizeTiming(startedMs, {
        admitted: true,
        repo: request.selector,
        defaultBranchSha,
        usageHandle: reservation.key,
      });
    } catch {
      this.rollback(reservation);
      return this.normalizeTiming(startedMs, this.deny());
    }
  }

  /**
   * Delays `outcome` until the selected fixed bucket (plus secret-independent
   * jitter) has elapsed, so wall-clock time never distinguishes one admission
   * outcome from another.
   */
  private async normalizeTiming(
    startedMs: number,
    outcome: DynamicAdmissionOutcome,
  ): Promise<DynamicAdmissionOutcome> {
    const elapsedMs = this.clock.nowMs() - startedMs;
    const targetMs = resolveDenialTimingBucketMs(elapsedMs, this.jitter);
    await this.clock.sleep(Math.max(0, targetMs - elapsedMs));
    return outcome;
  }

  private deny(): DynamicAdmissionOutcome {
    return { admitted: false, reason: CANONICAL_DENIAL_REASON };
  }
}
