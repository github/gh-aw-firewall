/**
 * Strict client for mcpg v0.4.17's `github-repository-delegation-v1` control
 * channel (`github/gh-aw-mcpg` `internal/proxy/delegation.go`,
 * `internal/delegation/{identity,store,envelope}.go`).
 *
 * Wire contract, reproduced exactly because mcpg decodes with
 * `DisallowUnknownFields` and rejects anything outside it:
 *
 * - every operation is `POST {origin}/internal/awf-enclave-mcp-control/<op>`,
 *   where `<op>` is a *sibling* of the controller name in the endpoint the
 *   compiler exports, not a child of it;
 * - the AWF-only capability travels in `Authorization`;
 * - request bodies are bounded (mcpg caps them at 64 KiB);
 * - `requested_ttl` is a Go `time.Duration`, i.e. an **integer number of
 *   nanoseconds**, and `invocation_expires_at` / `expires_at` are RFC 3339
 *   timestamps;
 * - `admitted_default_branch_sha` is optional on both the request and the
 *   response.
 *
 * Every response is validated before it is trusted: status, `content-type`,
 * bounded length, strict JSON, and — for create-or-confirm — an exact match
 * against the request's repository, tool policy, tool set, optional SHA, and
 * TTL/expiry bounds. Anything else is terminal; the client never returns a
 * partially trusted identity.
 */

import * as http from 'http';
import type { EnclaveDynamicDelegationEndpoint } from './dynamic-delegation-handoff';

/** The only delegated tool policy AWF understands. */
export const DELEGATION_TOOL_POLICY = 'github-repository-read-v1';

/** Exact, closed tool set `github-repository-read-v1` grants, sorted. */
export const DELEGATION_TOOLS: readonly string[] = Object.freeze(['issue_read', 'list_issues']);

/**
 * Fixed enclave backend identifier the compiler bakes into the envelope
 * (`buildMCPGatewayDelegationEnvelope` emits `"enclave_backend": "github"`).
 */
export const DELEGATION_ENCLAVE_BACKEND = 'github';

const NANOSECONDS_PER_SECOND = 1_000_000_000;
const MAX_CONTROL_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;

/** Distinguishes a policy denial from an operator-visible internal failure. */
export type DelegationControlFailureKind =
  /** mcpg refused the request under the compiler envelope (HTTP 403). */
  | 'denied'
  /** AWF built a request mcpg could not parse; a bug, never a caller signal. */
  | 'malformed-request'
  /** Wrong endpoint, controller disabled, or unsupported mcpg version. */
  | 'unsupported'
  /** mcpg could not persist or serve; transport, timeout, or 5xx. */
  | 'unavailable'
  /** mcpg answered, but the answer did not match the request or the contract. */
  | 'contract-violation';

export class DelegationControlError extends Error {
  constructor(
    readonly kind: DelegationControlFailureKind,
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = 'DelegationControlError';
  }

  /** Whether this failure leaves delegated state in an unknown condition. */
  get requiresReconciliation(): boolean {
    return this.kind === 'unavailable' || this.kind === 'contract-violation';
  }
}

export interface DelegationCreateOrConfirmRequest {
  runId: string;
  enclaveEntryId: string;
  invocationId: string;
  repository: string;
  schemaHash: string;
  /** Requested identity lifetime in whole seconds; converted to nanoseconds. */
  requestedTtlSeconds: number;
  /** Absolute invocation deadline; an identity can never outlive it. */
  invocationExpiresAt: Date;
  idempotencyKey: string;
  /** Only set when AWF actually resolved a SHA through a confined path. */
  admittedDefaultBranchSha?: string;
}

export interface DelegationIdentity {
  readonly handle: string;
  readonly executorBearer: string;
  readonly repository: string;
  readonly toolPolicy: string;
  readonly tools: readonly string[];
  readonly admittedDefaultBranchSha?: string;
  readonly expiresAt: Date;
}

export interface DelegationStatus {
  readonly recoveryIncomplete: boolean;
  readonly generation: number;
  readonly liveIdentityCount: number;
  readonly labelledHandles: readonly string[];
}

export interface DelegationControlClientOptions {
  endpoint: EnclaveDynamicDelegationEndpoint;
  capability: string;
  timeoutMs?: number;
  /** Injectable transport so tests can drive the exact wire contract. */
  request?: typeof http.request;
}

interface ControlResponse {
  statusCode: number;
  contentType: string;
  body: string;
}

/** Converts whole seconds to the integer nanoseconds Go's `time.Duration` decodes. */
export function secondsToGoDurationNanos(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new DelegationControlError(
      'malformed-request',
      'create-or-confirm',
      'requested TTL must be a positive whole number of seconds',
    );
  }
  const nanos = seconds * NANOSECONDS_PER_SECOND;
  if (!Number.isSafeInteger(nanos)) {
    throw new DelegationControlError(
      'malformed-request',
      'create-or-confirm',
      'requested TTL overflows a safe integer number of nanoseconds',
    );
  }
  return nanos;
}

export class DelegationControlClient {
  private readonly endpoint: EnclaveDynamicDelegationEndpoint;
  private readonly capability: string;
  private readonly timeoutMs: number;
  private readonly transport: typeof http.request;

  constructor(options: DelegationControlClientOptions) {
    this.endpoint = options.endpoint;
    this.capability = options.capability;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.transport = options.request ?? http.request;
  }

  /**
   * Creates, or idempotently confirms, exactly one delegated identity for one
   * invocation. The returned identity is verified field-by-field against the
   * request before it is handed to a caller.
   */
  async createOrConfirm(request: DelegationCreateOrConfirmRequest): Promise<DelegationIdentity> {
    const requestedTtlNanos = secondsToGoDurationNanos(request.requestedTtlSeconds);
    const body: Record<string, unknown> = {
      run_id: request.runId,
      enclave_backend: DELEGATION_ENCLAVE_BACKEND,
      enclave_entry_id: request.enclaveEntryId,
      invocation_id: request.invocationId,
      repository: request.repository,
      tool_policy: DELEGATION_TOOL_POLICY,
      schema_hash: request.schemaHash,
      requested_ttl: requestedTtlNanos,
      invocation_expires_at: request.invocationExpiresAt.toISOString(),
      idempotency_key: request.idempotencyKey,
    };
    if (request.admittedDefaultBranchSha !== undefined) {
      body.admitted_default_branch_sha = request.admittedDefaultBranchSha;
    }
    const decoded = await this.post('create-or-confirm', body);
    return this.verifyIdentity(decoded, request, requestedTtlNanos);
  }

  /** Reads the controller's recovery state and this label pair's live handles. */
  async status(runId: string, enclaveEntryId: string): Promise<DelegationStatus> {
    const decoded = await this.post('status', {
      run_id: runId,
      enclave_entry_id: enclaveEntryId,
    });
    const recoveryIncomplete = decoded.recovery_incomplete;
    const generation = decoded.generation;
    const liveIdentityCount = decoded.live_identity_count;
    const labelledHandles = decoded.labelled_handles;
    if (
      typeof recoveryIncomplete !== 'boolean'
      || !isSafeCount(generation)
      || !isSafeCount(liveIdentityCount)
      || !(labelledHandles === null || isStringArray(labelledHandles))
    ) {
      throw new DelegationControlError(
        'contract-violation',
        'status',
        'mcpg returned a malformed delegation status response',
      );
    }
    return {
      recoveryIncomplete,
      generation,
      liveIdentityCount,
      labelledHandles: Object.freeze(labelledHandles === null ? [] : [...labelledHandles]),
    };
  }

  /**
   * Clears mcpg's recovery-incomplete flag transactionally. AWF calls this
   * only after it has inspected — and revoked — every outstanding labelled
   * identity, never as a way to skip that inspection.
   */
  async reconcile(): Promise<void> {
    const decoded = await this.post('reconcile', {});
    if (decoded.reconciled !== true) {
      throw new DelegationControlError(
        'contract-violation',
        'reconcile',
        'mcpg did not confirm transactional delegation reconciliation',
      );
    }
  }

  /** Revokes one identity by opaque handle. Idempotent in mcpg. */
  async revoke(handle: string): Promise<void> {
    const decoded = await this.post('revoke', { handle });
    if (decoded.revoked !== true) {
      throw new DelegationControlError(
        'contract-violation',
        'revoke',
        'mcpg did not confirm delegated identity revocation',
      );
    }
  }

  /** Revokes every identity carrying this run/entry label pair. */
  async revokeByLabels(runId: string, enclaveEntryId: string): Promise<number> {
    const decoded = await this.post('revoke-by-labels', {
      run_id: runId,
      enclave_entry_id: enclaveEntryId,
    });
    const revoked = decoded.revoked;
    if (!isSafeCount(revoked)) {
      throw new DelegationControlError(
        'contract-violation',
        'revoke-by-labels',
        'mcpg did not report how many delegated identities were revoked',
      );
    }
    return revoked;
  }

  private verifyIdentity(
    decoded: Record<string, unknown>,
    request: DelegationCreateOrConfirmRequest,
    requestedTtlNanos: number,
  ): DelegationIdentity {
    const fail = (detail: string): never => {
      throw new DelegationControlError('contract-violation', 'create-or-confirm', detail);
    };
    const handle = decoded.handle;
    const executorBearer = decoded.executor_bearer;
    const repository = decoded.repository;
    const toolPolicy = decoded.tool_policy;
    const tools = decoded.tools;
    const expiresAtRaw = decoded.expires_at;
    const admittedSha = decoded.admitted_default_branch_sha;

    if (typeof handle !== 'string' || handle.length === 0) fail('identity handle is missing');
    if (typeof executorBearer !== 'string' || executorBearer.length === 0) {
      fail('executor bearer is missing');
    }
    if (repository !== request.repository) {
      fail('identity is bound to a different repository than the admitted selector');
    }
    if (toolPolicy !== DELEGATION_TOOL_POLICY) fail('identity carries an unexpected tool policy');
    if (
      !isStringArray(tools)
      || tools.length !== DELEGATION_TOOLS.length
      || [...tools].sort().join(',') !== DELEGATION_TOOLS.join(',')
    ) {
      fail('identity does not grant exactly list_issues and issue_read');
    }
    if (request.admittedDefaultBranchSha === undefined) {
      if (admittedSha !== undefined && admittedSha !== '') {
        fail('identity pinned a default-branch SHA that AWF never requested');
      }
    } else if (admittedSha !== request.admittedDefaultBranchSha) {
      fail('identity pinned a different default-branch SHA than the admitted one');
    }
    if (typeof expiresAtRaw !== 'string') fail('identity expiry is missing');
    const expiresAt = new Date(expiresAtRaw as string);
    if (Number.isNaN(expiresAt.getTime())) fail('identity expiry is not a valid timestamp');
    if (expiresAt.getTime() > request.invocationExpiresAt.getTime()) {
      fail('identity outlives the invocation deadline');
    }
    // mcpg computes ExpiresAt as now + RequestedTTL, capped by the envelope and
    // the invocation deadline, so a longer-lived identity means the controller
    // ignored the requested bound.
    const ttlCeilingMs = Date.now() + requestedTtlNanos / 1_000_000;
    if (expiresAt.getTime() > ttlCeilingMs) {
      fail('identity outlives the requested TTL');
    }
    return Object.freeze({
      handle: handle as string,
      executorBearer: executorBearer as string,
      repository: request.repository,
      toolPolicy: DELEGATION_TOOL_POLICY,
      tools: Object.freeze([...DELEGATION_TOOLS]),
      ...(request.admittedDefaultBranchSha === undefined
        ? {}
        : { admittedDefaultBranchSha: request.admittedDefaultBranchSha }),
      expiresAt,
    });
  }

  private async post(
    operation: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.send(operation, JSON.stringify(body));
    if (response.statusCode === 403) {
      throw new DelegationControlError(
        'denied',
        operation,
        'mcpg denied the delegation control request under the compiler envelope',
      );
    }
    if (response.statusCode === 400) {
      throw new DelegationControlError(
        'malformed-request',
        operation,
        'mcpg rejected the delegation control request as malformed',
      );
    }
    if (response.statusCode === 404) {
      throw new DelegationControlError(
        'unsupported',
        operation,
        'mcpg does not serve the github-repository-delegation-v1 control API at this endpoint',
      );
    }
    if (response.statusCode !== 200) {
      throw new DelegationControlError(
        'unavailable',
        operation,
        `mcpg delegation control returned HTTP ${response.statusCode}`,
      );
    }
    if (!response.contentType.toLowerCase().startsWith('application/json')) {
      throw new DelegationControlError(
        'contract-violation',
        operation,
        'mcpg delegation control returned a non-JSON content type',
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.body);
    } catch {
      throw new DelegationControlError(
        'contract-violation',
        operation,
        'mcpg delegation control returned invalid JSON',
      );
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new DelegationControlError(
        'contract-violation',
        operation,
        'mcpg delegation control returned a non-object response',
      );
    }
    return decoded as Record<string, unknown>;
  }

  private send(operation: string, payload: string): Promise<ControlResponse> {
    const url = new URL(`${this.endpoint.operationBasePath}${operation}`, this.endpoint.origin);
    const encoded = Buffer.from(payload, 'utf8');
    return new Promise<ControlResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: ControlResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve(value as ControlResponse);
      };
      const request = this.transport(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.capability}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': String(encoded.length),
          Connection: 'close',
        },
        timeout: this.timeoutMs,
      }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_CONTROL_RESPONSE_BYTES) {
            request.destroy();
            finish(new DelegationControlError(
              'contract-violation',
              operation,
              'mcpg delegation control response exceeded its bounded length',
            ));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => finish(undefined, {
          statusCode: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        }));
        response.on('error', () => finish(new DelegationControlError(
          'unavailable',
          operation,
          'mcpg delegation control response failed',
        )));
      });
      request.on('timeout', () => {
        request.destroy();
        finish(new DelegationControlError(
          'unavailable',
          operation,
          'mcpg delegation control request timed out',
        ));
      });
      request.on('error', () => finish(new DelegationControlError(
        'unavailable',
        operation,
        'mcpg delegation control request failed',
      )));
      const deadline = setTimeout(() => {
        request.destroy();
        finish(new DelegationControlError(
          'unavailable',
          operation,
          'mcpg delegation control request exceeded its deadline',
        ));
      }, this.timeoutMs);
      request.end(encoded);
    });
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
