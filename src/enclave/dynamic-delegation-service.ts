/**
 * Host-side runtime for dynamic GitHub-MCP-backed enclave repository
 * admission (ADR 0001 `docs/adr/0001-agent-enclaves.md`).
 *
 * This is the only component that holds the mcpg delegation-control
 * capability. It owns, for one dynamic `enclaves[]` entry:
 *
 *  1. **Recovery.** Before any admission is allowed it calls `status`, revokes
 *     every stale labelled identity, and only then calls the transactional
 *     `reconcile`. New admissions stay blocked until that sequence succeeds.
 *  2. **Admission.** Each `enclave_run_agent` selector goes through the
 *     `DynamicRepositoryRegistry` first — canonical form, envelope match,
 *     `maxRepositories`, expiry, run-wide quota reservation, shared disclosure
 *     ledger — and only an admitted selector reaches the control plane.
 *  3. **Identity.** One `create-or-confirm` per invocation binds the run,
 *     backend, entry, invocation, exact repository, `github-repository-read-v1`,
 *     the exact finite-schema hash, the requested TTL, and the invocation
 *     deadline. Only the executor bearer leaves this process; the handle stays
 *     in AWF-private state.
 *  4. **Settlement.** Every terminal path settles the reserved output-byte and
 *     execution-second quotas and revokes the identity. An unresolved
 *     revocation re-blocks admissions and is reported to the broker so it can
 *     never emit a success-shaped result.
 *  5. **Shutdown.** `revoke-by-labels` sweeps anything still live.
 *
 * Audit is bounded, structured, and redacted: selectors are hashed, and
 * bearers, handles, capabilities, endpoints, prompts, model output, and
 * repository content never appear.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { EnclaveDynamicPolicy } from '../types/enclave-options';
import { logger } from '../logger';
import type { EnclaveInformationBudgetLedger } from './information-budget';
import {
  CANONICAL_DENIAL_REASON,
  DynamicRepositoryRegistry,
  type DefaultBranchResolver,
  type DynamicAdmissionClock,
  type DynamicAdmissionJitterSource,
  type DynamicAdmissionUsage,
  type DynamicQuotaUsage,
} from './dynamic-registry';
import {
  DelegationControlClient,
  DelegationControlError,
  type DelegationIdentity,
} from './delegation-control-client';
import type { EnclaveDynamicDelegationHandoff } from './dynamic-delegation-handoff';
import {
  DELEGATION_CHANNEL_VERSION,
  type DelegationAdmissionRequestMessage,
  type DelegationAdmissionResponseMessage,
  type DelegationSettlementMessage,
  type DelegationSettlementReceiptMessage,
} from './dynamic-delegation-protocol';

/**
 * Stable enclave-entry identifier. AWF accepts at most one agent entry per
 * run, so a fixed token is both stable across an AWF restart inside the same
 * workflow run — which is what label-based reconciliation needs — and free of
 * any private selector material.
 */
export const ENCLAVE_DYNAMIC_ENTRY_ID = 'agent';

/** Extra seconds allowed beyond the invocation timeout for broker overhead. */
const INVOCATION_DEADLINE_GRACE_SECONDS = 30;

/** Bound on one audit line, so a pathological value cannot fill the disk. */
const MAX_AUDIT_LINE_BYTES = 4 * 1024;

export interface DynamicDelegationRunIdentity {
  /** Must equal the compiler envelope's `run_id`. */
  runId: string;
  entryId: string;
}

/**
 * Derives the delegation run id the compiler bound into the mcpg envelope:
 * `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` (gh-aw `enclaveDelegationRunID`).
 * Returns `undefined` when either half is missing or malformed, so AWF fails
 * closed rather than inventing a run identity mcpg would reject.
 */
export function resolveDynamicDelegationRunId(env: NodeJS.ProcessEnv): string | undefined {
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  if (typeof runId !== 'string' || !/^[0-9]{1,20}$/.test(runId)) return undefined;
  if (typeof attempt !== 'string' || !/^[0-9]{1,10}$/.test(attempt)) return undefined;
  return `${runId}-${attempt}`;
}

/** Truncated SHA-256, so an audit record can correlate without disclosing. */
export function hashForAudit(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Derives the idempotency key mcpg dedupes retries on. It is a pure function
 * of the invocation binding, so an exact retry replays the same identity and a
 * different selector can never reuse another invocation's key.
 */
export function deriveDelegationIdempotencyKey(
  runId: string,
  entryId: string,
  invocationId: string,
  selector: string,
): string {
  return crypto
    .createHash('sha256')
    .update([runId, entryId, invocationId, selector].join('\u0000'), 'utf8')
    .digest('hex');
}

export interface DynamicDelegationServiceOptions {
  policy: EnclaveDynamicPolicy;
  identity: DynamicDelegationRunIdentity;
  handoff: EnclaveDynamicDelegationHandoff;
  ledger: EnclaveInformationBudgetLedger;
  auditPath: string;
  /** Injected in tests; production has no confined default-branch resolver. */
  resolveDefaultBranchSha?: DefaultBranchResolver;
  client?: DelegationControlClient;
  /**
   * Injected only by tests, so admission-timing normalization (covered
   * exhaustively by the registry's own suite) does not make every service test
   * sleep through a fixed bucket.
   */
  clock?: DynamicAdmissionClock;
  jitter?: DynamicAdmissionJitterSource;
}

interface LiveIdentity {
  handle: string;
  repository: string;
  usageHandle: string;
}

/**
 * One dynamic enclave entry's admission authority, identity lifecycle, and
 * usage settlement.
 */
export class DynamicDelegationService {
  private readonly registry: DynamicRepositoryRegistry;
  private readonly client: DelegationControlClient;
  private readonly policy: EnclaveDynamicPolicy;
  private readonly identity: DynamicDelegationRunIdentity;
  private readonly auditPath: string;
  private readonly live = new Map<string, LiveIdentity>();
  /**
   * Terminal admission outcomes, keyed by `(invocation, selector)` and
   * inserted before the first `await`, so an exact retry — including one that
   * arrives while the first is still resolving — replays the identical result
   * instead of issuing a second control call.
   */
  private readonly outcomes = new Map<string, Promise<DelegationAdmissionResponseMessage>>();
  private recovered = false;
  private reconciliationRequired = false;

  constructor(options: DynamicDelegationServiceOptions) {
    this.policy = options.policy;
    this.identity = options.identity;
    this.auditPath = options.auditPath;
    this.client = options.client ?? new DelegationControlClient({
      endpoint: options.handoff.endpoint,
      capability: options.handoff.capability,
    });
    this.registry = new DynamicRepositoryRegistry({
      policy: options.policy,
      ledger: options.ledger,
      // ADR 0001 makes the admitted default-branch SHA optional. AWF has no
      // already-authorized, repository-confined path to resolve it before the
      // delegated identity exists, and `github-repository-read-v1` grants only
      // list_issues/issue_read afterwards, so production omits it and audits
      // every read as live rather than adding a broader token or tool.
      resolveDefaultBranchSha: options.resolveDefaultBranchSha ?? (() => undefined),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.jitter ? { jitter: options.jitter } : {}),
    });
    // Fail closed until recovery proves the controller's state is safe.
    this.registry.markReconciliationIncomplete();
  }

  /** Exposed for the channel loop and tests; never leaves the host process. */
  get quotaUsage(): DynamicQuotaUsage {
    return this.registry.quotaUsage;
  }

  /** Whether the controller and AWF agree that state is reconciled. */
  get isAdmitting(): boolean {
    return this.recovered && !this.reconciliationRequired;
  }

  /**
   * Establishes a safe starting state: inspect, revoke stale labelled
   * identities, then transactionally reconcile. Any failure leaves admissions
   * blocked and is surfaced to the operator.
   */
  async recover(): Promise<void> {
    const status = await this.client.status(this.identity.runId, this.identity.entryId);
    this.audit('recovery-status', {
      recoveryIncomplete: status.recoveryIncomplete,
      generation: status.generation,
      liveIdentityCount: status.liveIdentityCount,
      labelledHandleCount: status.labelledHandles.length,
    });
    if (status.labelledHandles.length > 0) {
      const revoked = await this.client.revokeByLabels(
        this.identity.runId,
        this.identity.entryId,
      );
      this.audit('recovery-revoked-stale', { revoked });
    }
    await this.client.reconcile();
    this.recovered = true;
    this.reconciliationRequired = false;
    this.registry.markReconciled();
    this.audit('recovery-complete', {});
  }

  /**
   * Routes one invocation through canonical admission and, only if admitted,
   * mints or confirms its delegated identity.
   *
   * Every failure — malformed selector, out-of-policy owner, expired envelope,
   * exhausted quota, control denial, control outage — returns the identical
   * canonical denial. The registry normalizes admission timing; a control
   * failure after admission still settles the reservation so a denial can
   * never leak capacity.
   */
  async admit(
    request: DelegationAdmissionRequestMessage,
  ): Promise<DelegationAdmissionResponseMessage> {
    const key = `${request.invocationId}\u0000${request.selector}`;
    const replay = this.outcomes.get(key);
    if (replay) return replay;
    const pending = this.resolveAdmission(request);
    this.outcomes.set(key, pending);
    return pending;
  }

  private async resolveAdmission(
    request: DelegationAdmissionRequestMessage,
  ): Promise<DelegationAdmissionResponseMessage> {
    const selectorHash = hashForAudit(request.selector);
    if (!this.isAdmitting) {
      this.audit('admission-blocked', {
        invocationId: request.invocationId,
        selectorHash,
        reason: this.recovered ? 'reconciliation-required' : 'recovery-incomplete',
      });
      return this.deny(request);
    }
    const outcome = await this.registry.admit({
      runId: this.identity.runId,
      entryId: this.identity.entryId,
      invocationId: request.invocationId,
      selector: request.selector,
    });
    if (!outcome.admitted) {
      this.audit('admission-denied', { invocationId: request.invocationId, selectorHash });
      return this.deny(request);
    }

    const requestedTtlSeconds = this.policy.limits.timeoutSeconds;
    const invocationExpiresAt = new Date(
      Date.now() + (requestedTtlSeconds + INVOCATION_DEADLINE_GRACE_SECONDS) * 1000,
    );
    let identity: DelegationIdentity;
    try {
      identity = await this.client.createOrConfirm({
        runId: this.identity.runId,
        enclaveEntryId: this.identity.entryId,
        invocationId: request.invocationId,
        repository: outcome.repo,
        schemaHash: request.schemaHash,
        requestedTtlSeconds,
        invocationExpiresAt,
        idempotencyKey: deriveDelegationIdempotencyKey(
          this.identity.runId,
          this.identity.entryId,
          request.invocationId,
          outcome.repo,
        ),
        ...(outcome.defaultBranchSha === undefined
          ? {}
          : { admittedDefaultBranchSha: outcome.defaultBranchSha }),
      });
    } catch (error) {
      const kind = error instanceof DelegationControlError ? error.kind : 'unavailable';
      // The invocation charge stays committed: the envelope revealed the
      // opportunity to spend it the moment it admitted the repository.
      this.settleQuota(outcome.usageHandle, { outputBytes: 0, executionSeconds: 0 });
      if (error instanceof DelegationControlError && error.requiresReconciliation) {
        this.requireReconciliation('identity-creation-unresolved');
      }
      this.audit('identity-failed', {
        invocationId: request.invocationId,
        selectorHash,
        kind,
      });
      if (kind !== 'denied') {
        logger.error(
          'Enclaves: the mcpg delegation controller could not mint a dynamic repository identity. '
          + 'Dynamic admissions are blocked; no fallback identity is issued.',
        );
      }
      return this.deny(request);
    }

    this.live.set(request.invocationId, {
      handle: identity.handle,
      repository: identity.repository,
      usageHandle: outcome.usageHandle,
    });
    const readMode = identity.admittedDefaultBranchSha === undefined ? 'live' : 'pinned';
    this.audit('identity-created', {
      invocationId: request.invocationId,
      selectorHash,
      handleHash: hashForAudit(identity.handle),
      readMode,
      expiresAt: identity.expiresAt.toISOString(),
      schemaHash: request.schemaHash,
    });
    return {
      version: DELEGATION_CHANNEL_VERSION,
      invocationId: request.invocationId,
      admitted: true,
      repository: identity.repository,
      executorBearer: identity.executorBearer,
      expiresAt: identity.expiresAt.toISOString(),
      readMode,
      ...(identity.admittedDefaultBranchSha === undefined
        ? {}
        : { admittedDefaultBranchSha: identity.admittedDefaultBranchSha }),
    };
  }

  /**
   * Settles one finished invocation: the reserved worst-case byte and
   * execution-second capacity is replaced by the reported usage, and the
   * delegated identity is revoked. Reports whether revocation is definitive.
   */
  async settle(
    settlement: DelegationSettlementMessage,
  ): Promise<DelegationSettlementReceiptMessage> {
    const live = this.live.get(settlement.invocationId);
    this.live.delete(settlement.invocationId);
    if (live) {
      this.settleQuota(live.usageHandle, {
        outputBytes: Math.min(settlement.outputBytes, this.policy.limits.maxOutputBytes),
        executionSeconds: Math.min(
          settlement.executionSeconds,
          this.policy.limits.timeoutSeconds,
        ),
      });
    }
    let revoked = true;
    if (live) {
      try {
        await this.client.revoke(live.handle);
      } catch (error) {
        revoked = false;
        this.requireReconciliation('revocation-unresolved');
        this.audit('revocation-failed', {
          invocationId: settlement.invocationId,
          handleHash: hashForAudit(live.handle),
          kind: error instanceof DelegationControlError ? error.kind : 'unavailable',
        });
        logger.error(
          'Enclaves: a dynamic enclave identity could not be revoked. Further dynamic '
          + 'admissions are blocked until reconciliation succeeds.',
        );
      }
    }
    this.audit('usage-settled', {
      invocationId: settlement.invocationId,
      outcome: settlement.outcome,
      outputBytes: settlement.outputBytes,
      executionSeconds: settlement.executionSeconds,
      revoked,
      quota: this.registry.quotaUsage,
    });
    return {
      version: DELEGATION_CHANNEL_VERSION,
      invocationId: settlement.invocationId,
      settled: true,
      revoked,
    };
  }

  /**
   * Sweeps every identity still carrying this run/entry label pair. Called at
   * teardown and after any unresolved revocation.
   */
  async shutdown(): Promise<void> {
    try {
      const revoked = await this.client.revokeByLabels(
        this.identity.runId,
        this.identity.entryId,
      );
      this.live.clear();
      this.audit('shutdown-revoked', { revoked });
    } catch (error) {
      this.requireReconciliation('shutdown-revocation-unresolved');
      this.audit('shutdown-revocation-failed', {
        kind: error instanceof DelegationControlError ? error.kind : 'unavailable',
      });
      logger.error(
        'Enclaves: dynamic enclave identities could not be revoked at shutdown; mcpg state '
        + 'remains unreconciled and must be inspected by an operator.',
      );
      throw error;
    }
  }

  private settleQuota(usageHandle: string, usage: DynamicAdmissionUsage): void {
    try {
      this.registry.commitUsage(usageHandle, usage);
    } catch (error) {
      // Accounting can only fail on a programming error; record it rather
      // than letting an unsettled reservation silently strand capacity.
      this.audit('usage-accounting-failed', {
        message: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private requireReconciliation(reason: string): void {
    this.reconciliationRequired = true;
    this.registry.markReconciliationIncomplete();
    this.audit('reconciliation-required', { reason });
  }

  private deny(
    request: DelegationAdmissionRequestMessage,
  ): DelegationAdmissionResponseMessage {
    return {
      version: DELEGATION_CHANNEL_VERSION,
      invocationId: request.invocationId,
      admitted: false,
      reason: CANONICAL_DENIAL_REASON,
    };
  }

  /**
   * Appends one bounded, structured, redacted audit record.
   *
   * Callers pass only hashed selectors and handles, counts, and enumerated
   * categories. The record is truncated rather than dropped so a pathological
   * value can neither fill the disk nor silence the stream.
   */
  private audit(event: string, fields: Record<string, unknown>): void {
    let line: string;
    try {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        component: 'enclave-dynamic-delegation',
        runId: this.identity.runId,
        entryId: this.identity.entryId,
        event,
        ...fields,
      });
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), event, error: 'unserializable' });
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_AUDIT_LINE_BYTES) {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        component: 'enclave-dynamic-delegation',
        event,
        truncated: true,
      });
    }
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.auditPath, `${line}\n`, { mode: 0o600 });
    } catch {
      // Audit is best-effort on a full or read-only disk; the operator-facing
      // logger already carries every failure that blocks admissions.
    }
  }
}
