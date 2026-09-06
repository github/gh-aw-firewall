/**
 * AWF-owned mutable registry for dynamic GitHub-MCP-backed enclave repository
 * admission (ADR 0001 `docs/adr/0001-agent-enclaves.md`).
 *
 * This module implements the registry-side invariants AWF alone can enforce
 * from the already-validated `enclaves[].dynamic` policy envelope: canonical
 * selector matching, `maxRepositories`/expiry/quota enforcement, a shared
 * per-repository sensitivity ledger, idempotent admission keyed by
 * `(run, enclave entry, invocation id, canonical repository)`, and a single
 * non-disclosing canonical denial with a fixed timing bucket. It does not
 * itself perform the mcpg control-channel delegation calls described by the
 * ADR: the compiler does not yet emit an explicit AWF control-endpoint
 * variable (see the "Version coordination" note in the tracking issue), so
 * that wiring is a follow-up once the endpoint contract lands upstream.
 */

import * as crypto from 'crypto';
import {
  CANONICAL_DYNAMIC_REPOSITORY_PATTERN,
  ENCLAVE_SENSITIVITY_RUN_BITS,
  type EnclaveDynamicPolicy,
  type EnclaveSensitivity,
} from '../types/enclave-options';
import { TIMING_BUCKETS_MS } from '../bounded-execution';

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
  | { admitted: true; repo: string; defaultBranchSha: string }
  | { admitted: false; reason: typeof CANONICAL_DENIAL_REASON };

export interface DynamicAdmissionRequest {
  runId: string;
  entryId: string;
  invocationId: string;
  /** Caller-supplied selector, validated for exact canonical form before matching. */
  selector: string;
}

/** Resolves the admitted repository's default-branch SHA. Injectable for tests. */
export type DefaultBranchResolver = (repo: string) => Promise<string> | string;

interface LedgerRecord {
  outcome: DynamicAdmissionOutcome;
  /** Terminal: a retried request with this key never re-evaluates the policy. */
  terminal: boolean;
}

/** Injectable clock/timer seams so tests can avoid real wall-clock delay. */
export interface DynamicRepositoryRegistryOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

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

function admissionKey(request: Pick<DynamicAdmissionRequest, 'runId' | 'entryId' | 'invocationId' | 'selector'>): string {
  return [request.runId, request.entryId, request.invocationId, request.selector].join('\u0000');
}

/**
 * Resolves the fixed response-timing bucket (plus secret-independent random
 * jitter) that a canonical denial or admission must appear to take, so
 * elapsed wall-clock time never distinguishes malformed, inaccessible,
 * nonexistent, expired, over-quota, and out-of-policy selectors from one
 * another. See `docs/awf-config-spec.md` §14 for the fixed bucket list.
 */
export function resolveDenialTimingBucketMs(elapsedMs: number): number {
  for (const bucket of TIMING_BUCKETS_MS) {
    if (elapsedMs <= bucket) return bucket + crypto.randomInt(0, 1001);
  }
  return TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1] + crypto.randomInt(0, 1001);
}

/**
 * AWF-owned per-run registry for one dynamic `enclaves[].dynamic` policy
 * envelope. One instance is scoped to one enclave entry for one workflow run;
 * static and dynamic admissions still share the run-wide sensitivity ledger
 * through {@link EnclaveSensitivityLedger} (see `src/enclave/preflight.ts` and
 * `docs/awf-config-spec.md` §14 for the shared-ledger invariant).
 */
export class DynamicRepositoryRegistry {
  private readonly admissions = new Map<string, LedgerRecord>();
  /**
   * Concurrent/retried calls sharing the same idempotency key coalesce onto
   * this single in-flight promise, so they can never both pass the
   * synchronous reservation, both invoke the resolver, or settle conflicting
   * outcomes for the same key.
   */
  private readonly inFlight = new Map<string, Promise<DynamicAdmissionOutcome>>();
  private readonly admittedRepos = new Set<string>();
  private readonly reservedRepos = new Set<string>();
  private readonly inFlightInvocations = new Map<string, string>();
  private debitedInvocations = 0;
  private reservedInvocations = 0;
  private debitedOutputBytes = 0;
  private reservedOutputBytes = 0;
  private debitedExecutionSeconds = 0;
  private reservedExecutionSeconds = 0;
  private reconciled = true;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly policy: EnclaveDynamicPolicy,
    private readonly resolveDefaultBranchSha: DefaultBranchResolver,
    options: DynamicRepositoryRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Number of distinct repositories admitted so far under this envelope. */
  get admittedRepositoryCount(): number {
    return this.admittedRepos.size;
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
   * Idempotent by `(run, enclave entry, invocation id, canonical repository)`:
   * a retried request with the same key returns the exact same terminal
   * outcome without re-evaluating policy, and a request that reuses an
   * invocation id with a different selector is always denied rather than
   * rebinding the invocation to another repository.
   *
   * `maxRepositories` and every total quota (`maxInvocations`,
   * `maxOutputBytes`, `maxExecutionSeconds`, reserved at this invocation's
   * worst-case per-invocation limits) are reserved synchronously before any
   * asynchronous default-branch lookup, so two concurrent admissions can
   * never both observe capacity and both commit, regardless of how long the
   * lookup takes. Concurrent or retried calls sharing the same idempotency
   * key are coalesced onto one in-flight promise rather than independently
   * re-evaluated, so they can never double-debit a quota or settle
   * conflicting outcomes.
   *
   * Every outcome — admitted or denied — is normalized to the fixed,
   * jittered timing bucket in {@link resolveDenialTimingBucketMs} before
   * returning, so elapsed wall-clock time never distinguishes a
   * synchronously rejected (malformed/out-of-policy/expired/over-quota)
   * selector from one that failed only after the asynchronous
   * default-branch lookup.
   */
  async admit(request: DynamicAdmissionRequest): Promise<DynamicAdmissionOutcome> {
    const key = admissionKey(request);
    const existing = this.admissions.get(key);
    if (existing) return existing.outcome;
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = this.performAdmission(request, key);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async performAdmission(request: DynamicAdmissionRequest, key: string): Promise<DynamicAdmissionOutcome> {
    const startedAtMs = this.now();
    const reservation = this.reserve(request);
    let outcome: DynamicAdmissionOutcome;
    if (!reservation.ok) {
      outcome = this.deny();
    } else {
      try {
        const defaultBranchSha = await this.resolveDefaultBranchSha(request.selector);
        if (typeof defaultBranchSha !== 'string' || defaultBranchSha.length === 0) {
          this.rollback(reservation);
          outcome = this.deny();
        } else {
          this.commit(reservation);
          outcome = { admitted: true, repo: request.selector, defaultBranchSha };
        }
      } catch {
        this.rollback(reservation);
        outcome = this.deny();
      }
    }
    await this.normalizeTiming(startedAtMs);
    return this.settle(key, outcome);
  }

  /** Delays until the elapsed time since `startedAtMs` reaches a fixed, jittered bucket. */
  private async normalizeTiming(startedAtMs: number): Promise<void> {
    const elapsedMs = this.now() - startedAtMs;
    const bucketMs = resolveDenialTimingBucketMs(elapsedMs);
    const remainingMs = bucketMs - elapsedMs;
    if (remainingMs > 0) await this.sleep(remainingMs);
  }

  /**
   * Synchronously validates policy and reserves capacity across
   * `maxRepositories` and every total quota. Runs entirely without an
   * `await`, so no other admission can interleave between the capacity
   * check and the reservation.
   */
  private reserve(request: DynamicAdmissionRequest): Reservation {
    if (!this.reconciled) return { ok: false };
    const invocationKey = `${request.runId}\u0000${request.entryId}\u0000${request.invocationId}`;
    const boundSelector = this.inFlightInvocations.get(invocationKey);
    if (boundSelector !== undefined && boundSelector !== request.selector) return { ok: false };
    if (!isCanonicalDynamicSelector(request.selector)) return { ok: false };
    if (!selectorAllowedByPolicy(this.policy, request.selector)) return { ok: false };
    if (Date.parse(this.policy.expiresAt) <= this.now()) return { ok: false };
    if (this.debitedInvocations + this.reservedInvocations >= this.policy.quotas.maxInvocations) {
      return { ok: false };
    }
    const outputBytesNeeded = this.policy.limits.maxOutputBytes;
    if (this.debitedOutputBytes + this.reservedOutputBytes + outputBytesNeeded > this.policy.quotas.maxOutputBytes) {
      return { ok: false };
    }
    const executionSecondsNeeded = this.policy.limits.timeoutSeconds;
    if (
      this.debitedExecutionSeconds + this.reservedExecutionSeconds + executionSecondsNeeded
      > this.policy.quotas.maxExecutionSeconds
    ) {
      return { ok: false };
    }
    const isNewRepo = !this.admittedRepos.has(request.selector) && !this.reservedRepos.has(request.selector);
    if (isNewRepo && this.admittedRepos.size + this.reservedRepos.size >= this.policy.maxRepositories) {
      return { ok: false };
    }

    this.inFlightInvocations.set(invocationKey, request.selector);
    if (isNewRepo) this.reservedRepos.add(request.selector);
    this.reservedInvocations += 1;
    this.reservedOutputBytes += outputBytesNeeded;
    this.reservedExecutionSeconds += executionSecondsNeeded;
    return {
      ok: true,
      invocationKey,
      selector: request.selector,
      isNewRepo,
      outputBytesNeeded,
      executionSecondsNeeded,
    };
  }

  private commit(reservation: Reservation & { ok: true }): void {
    this.reservedInvocations -= 1;
    this.debitedInvocations += 1;
    this.reservedOutputBytes -= reservation.outputBytesNeeded;
    this.debitedOutputBytes += reservation.outputBytesNeeded;
    this.reservedExecutionSeconds -= reservation.executionSecondsNeeded;
    this.debitedExecutionSeconds += reservation.executionSecondsNeeded;
    if (reservation.isNewRepo) {
      this.reservedRepos.delete(reservation.selector);
      this.admittedRepos.add(reservation.selector);
    }
  }

  private rollback(reservation: Reservation & { ok: true }): void {
    this.inFlightInvocations.delete(reservation.invocationKey);
    this.reservedInvocations -= 1;
    this.reservedOutputBytes -= reservation.outputBytesNeeded;
    this.reservedExecutionSeconds -= reservation.executionSecondsNeeded;
    if (reservation.isNewRepo) this.reservedRepos.delete(reservation.selector);
  }

  private settle(key: string, outcome: DynamicAdmissionOutcome): DynamicAdmissionOutcome {
    this.admissions.set(key, { outcome, terminal: true });
    return outcome;
  }

  private deny(): DynamicAdmissionOutcome {
    return { admitted: false, reason: CANONICAL_DENIAL_REASON };
  }
}

type Reservation =
  | { ok: false }
  | {
    ok: true;
    invocationKey: string;
    selector: string;
    isNewRepo: boolean;
    outputBytesNeeded: number;
    executionSecondsNeeded: number;
  };

/**
 * Shared per-run information budget debited by both static and dynamic
 * admissions, per `ENCLAVE_SENSITIVITY_RUN_BITS` (`docs/awf-config-spec.md`
 * §14). Sensitivity classes with a `null` bound are unlimited; every other
 * class shares one run-wide bit budget across every executor and admission
 * mode so a dynamic admission cannot bypass the static-mode ledger.
 */
export class EnclaveSensitivityLedger {
  private readonly debited = new Map<EnclaveSensitivity, number>();

  /** Returns whether the debit was accepted; rejects once the run bound is exhausted. */
  debit(sensitivity: EnclaveSensitivity, bits: number): boolean {
    const bound = ENCLAVE_SENSITIVITY_RUN_BITS[sensitivity];
    if (bound === null) return true;
    const spent = this.debited.get(sensitivity) ?? 0;
    if (spent + bits > bound) return false;
    this.debited.set(sensitivity, spent + bits);
    return true;
  }

  spent(sensitivity: EnclaveSensitivity): number {
    return this.debited.get(sensitivity) ?? 0;
  }
}
