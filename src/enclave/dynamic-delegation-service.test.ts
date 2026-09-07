import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CANONICAL_DENIAL_REASON } from './dynamic-registry';
import { createEnclaveInformationBudgetLedger } from './information-budget';
import { DelegationControlError } from './delegation-control-client';
import { parseEnclaveDynamicDelegationControlEndpoint } from './dynamic-delegation-handoff';
import { typedDynamicEnclavePolicyFixture } from './dynamic-policy.test-utils';
import {
  DELEGATION_CHANNEL_VERSION,
  type DelegationAdmissionRequestMessage,
} from './dynamic-delegation-protocol';
import {
  DynamicDelegationService,
  ENCLAVE_DYNAMIC_ENTRY_ID,
  deriveDelegationIdempotencyKey,
  hashForAudit,
  resolveDynamicDelegationRunId,
} from './dynamic-delegation-service';

const ENDPOINT = parseEnclaveDynamicDelegationControlEndpoint(
  'http://127.0.0.1:8090/internal/awf-enclave-mcp-control/github-repository-delegation-v1',
)!;
const CAPABILITY = 'c'.repeat(64);
const RUN_ID = '42-1';

interface ControlCall {
  operation: string;
  args: unknown[];
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const calls: ControlCall[] = [];
  let created = 0;
  const client = {
    calls,
    async status(runId: string, entryId: string) {
      calls.push({ operation: 'status', args: [runId, entryId] });
      return {
        recoveryIncomplete: false,
        generation: 1,
        liveIdentityCount: 0,
        labelledHandles: [] as string[],
      };
    },
    async reconcile() {
      calls.push({ operation: 'reconcile', args: [] });
    },
    async revoke(handle: string) {
      calls.push({ operation: 'revoke', args: [handle] });
    },
    async revokeByLabels(runId: string, entryId: string) {
      calls.push({ operation: 'revoke-by-labels', args: [runId, entryId] });
      return 0;
    },
    async createOrConfirm(request: Record<string, unknown>) {
      calls.push({ operation: 'create-or-confirm', args: [request] });
      created += 1;
      return {
        handle: `dlg_${created}`,
        executorBearer: `dlgbearer_${created}`,
        repository: request.repository as string,
        toolPolicy: 'github-repository-read-v1',
        tools: ['issue_read', 'list_issues'],
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
    ...overrides,
  };
  return client;
}

function makeService(clientOverrides: Record<string, unknown> = {}, auditDir?: string) {
  const client = fakeClient(clientOverrides);
  const service = new DynamicDelegationService({
    policy: typedDynamicEnclavePolicyFixture(),
    identity: { runId: RUN_ID, entryId: ENCLAVE_DYNAMIC_ENTRY_ID },
    handoff: { endpoint: ENDPOINT, capability: CAPABILITY },
    ledger: createEnclaveInformationBudgetLedger(new Map()),
    auditPath: path.join(auditDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'awf-audit-')), 'a.jsonl'),
    client: client as never,
    // Admission timing normalization is asserted exhaustively by the
    // registry's own suite; here it would only make every case sleep.
    clock: { nowMs: () => 0, sleep: async () => undefined },
    jitter: () => 0,
  });
  return { service, client };
}

function request(
  invocationId: string,
  selector = 'octo-org/service',
): DelegationAdmissionRequestMessage {
  return {
    version: DELEGATION_CHANNEL_VERSION,
    invocationId,
    selector,
    schemaHash: 'd'.repeat(64),
  };
}

describe('dynamic delegation run identity', () => {
  it('derives the compiler envelope run id from the workflow run and attempt', () => {
    expect(resolveDynamicDelegationRunId({ GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' }))
      .toBe('42-1');
  });

  it.each([
    ['a missing run id', { GITHUB_RUN_ATTEMPT: '1' }],
    ['a missing attempt', { GITHUB_RUN_ID: '42' }],
    ['a non-numeric run id', { GITHUB_RUN_ID: 'main', GITHUB_RUN_ATTEMPT: '1' }],
  ])('fails closed for %s', (_label, env) => {
    expect(resolveDynamicDelegationRunId(env)).toBeUndefined();
  });

  it('derives a stable idempotency key from the invocation binding', () => {
    const key = deriveDelegationIdempotencyKey(RUN_ID, 'agent', 'abc123def4567890', 'octo/one');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveDelegationIdempotencyKey(RUN_ID, 'agent', 'abc123def4567890', 'octo/one'))
      .toBe(key);
    expect(deriveDelegationIdempotencyKey(RUN_ID, 'agent', 'abc123def4567890', 'octo/two'))
      .not.toBe(key);
  });
});

describe('dynamic delegation recovery', () => {
  it('blocks admission until status, revocation, and reconciliation complete', async () => {
    const { service, client } = makeService();
    expect(service.isAdmitting).toBe(false);
    const denied = await service.admit(request('1111111111111111'));
    expect(denied).toMatchObject({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(client.calls).toEqual([]);

    await service.recover();
    expect(service.isAdmitting).toBe(true);
    expect(client.calls.map((call) => call.operation)).toEqual(['status', 'reconcile']);
  });

  it('revokes stale labelled identities before reconciling', async () => {
    const { service, client } = makeService({
      async status(runId: string, entryId: string) {
        (this as { calls: ControlCall[] }).calls.push({ operation: 'status', args: [runId, entryId] });
        return {
          recoveryIncomplete: true,
          generation: 2,
          liveIdentityCount: 1,
          labelledHandles: ['dlg_stale'],
        };
      },
    });
    await service.recover();
    expect(client.calls.map((call) => call.operation)).toEqual([
      'status',
      'revoke-by-labels',
      'reconcile',
    ]);
  });

  it('keeps admissions blocked when reconciliation fails', async () => {
    const { service } = makeService({
      async reconcile() {
        throw new DelegationControlError('unavailable', 'reconcile', 'down');
      },
    });
    await expect(service.recover()).rejects.toThrow(DelegationControlError);
    expect(service.isAdmitting).toBe(false);
    await expect(service.admit(request('2222222222222222'))).resolves.toMatchObject({
      admitted: false,
    });
  });
});

describe('dynamic delegation admission', () => {
  it('mints exactly one identity bound to the admitted repository', async () => {
    const { service, client } = makeService();
    await service.recover();
    const response = await service.admit(request('3333333333333333'));
    expect(response).toMatchObject({
      admitted: true,
      repository: 'octo-org/service',
      executorBearer: 'dlgbearer_1',
      readMode: 'live',
    });
    const createCall = client.calls.find((call) => call.operation === 'create-or-confirm');
    expect(createCall?.args[0]).toMatchObject({
      runId: RUN_ID,
      enclaveEntryId: 'agent',
      invocationId: '3333333333333333',
      repository: 'octo-org/service',
      schemaHash: 'd'.repeat(64),
      requestedTtlSeconds: 120,
    });
    expect(createCall?.args[0]).not.toHaveProperty('admittedDefaultBranchSha');
  });

  it('never exposes the identity handle to the broker', async () => {
    const { service } = makeService();
    await service.recover();
    const response = await service.admit(request('4444444444444444'));
    expect(JSON.stringify(response)).not.toContain('dlg_1');
    expect(JSON.stringify(response)).toContain('dlgbearer_1');
  });

  it('returns the canonical denial for an out-of-policy selector without calling mcpg', async () => {
    const { service, client } = makeService();
    await service.recover();
    const before = client.calls.length;
    await expect(service.admit(request('5555555555555555', 'other-org/not-listed')))
      .resolves.toMatchObject({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(client.calls.length).toBe(before);
  });

  it('returns the canonical denial for a malformed selector', async () => {
    const { service } = makeService();
    await service.recover();
    await expect(service.admit(request('6666666666666666', 'Octo-Org/Service')))
      .resolves.toMatchObject({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('replays the same identity for an exact retry', async () => {
    const { service, client } = makeService();
    await service.recover();
    const first = await service.admit(request('7777777777777777'));
    const second = await service.admit(request('7777777777777777'));
    expect(second).toEqual(first);
    expect(client.calls.filter((call) => call.operation === 'create-or-confirm')).toHaveLength(1);
  });

  it('joins a concurrent identical retry instead of minting a second identity', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    const { service, client } = makeService({
      createOrConfirm(request: Record<string, unknown>) {
        (this as { calls: ControlCall[] }).calls.push({
          operation: 'create-or-confirm',
          args: [request],
        });
        return new Promise((resolve) => { resolveCreate = resolve; });
      },
    });
    await service.recover();
    const first = service.admit(request('1212121212121212'));
    const second = service.admit(request('1212121212121212'));
    // The registry's synchronous reservation runs before the control call, so
    // yield once to let both admissions reach create-or-confirm.
    await new Promise((resolve) => { setImmediate(resolve); });
    resolveCreate!({
      handle: 'dlg_1',
      executorBearer: 'dlgbearer_1',
      repository: 'octo-org/service',
      toolPolicy: 'github-repository-read-v1',
      tools: ['issue_read', 'list_issues'],
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await second).toEqual(await first);
    expect(client.calls.filter((call) => call.operation === 'create-or-confirm')).toHaveLength(1);
  });

  it('denies a second repository for the same invocation', async () => {
    const { service } = makeService();
    await service.recover();
    await service.admit(request('8888888888888888', 'octo-org/one'));
    await expect(service.admit(request('8888888888888888', 'octo-org/two')))
      .resolves.toMatchObject({ admitted: false });
  });

  it('settles the reservation and denies when identity creation fails', async () => {
    const { service } = makeService({
      async createOrConfirm() {
        throw new DelegationControlError('denied', 'create-or-confirm', 'outside envelope');
      },
    });
    await service.recover();
    await expect(service.admit(request('9999999999999999')))
      .resolves.toMatchObject({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    // The invocation charge stays committed; byte/second reservations do not leak.
    expect(service.quotaUsage.invocations.debited).toBe(1);
    expect(service.quotaUsage.outputBytes.reserved).toBe(0);
    expect(service.quotaUsage.executionSeconds.reserved).toBe(0);
  });

  it('blocks further admissions when identity creation leaves state unresolved', async () => {
    const { service } = makeService({
      async createOrConfirm() {
        throw new DelegationControlError('unavailable', 'create-or-confirm', 'timeout');
      },
    });
    await service.recover();
    await service.admit(request('aaaaaaaaaaaaaaaa'));
    expect(service.isAdmitting).toBe(false);
  });

  it('enforces the envelope invocation quota across admissions', async () => {
    const { service } = makeService();
    await service.recover();
    for (let index = 0; index < 10; index += 1) {
      const response = await service.admit(request(index.toString(16).padStart(16, '0')));
      expect(response.admitted).toBe(true);
      await service.settle({
        version: DELEGATION_CHANNEL_VERSION,
        invocationId: index.toString(16).padStart(16, '0'),
        outcome: 'success',
        outputBytes: 10,
        executionSeconds: 1,
      });
    }
    await expect(service.admit(request('bbbbbbbbbbbbbbbb')))
      .resolves.toMatchObject({ admitted: false });
  });
});

describe('dynamic delegation settlement', () => {
  it('revokes the identity and settles the reserved quota on success', async () => {
    const { service, client } = makeService();
    await service.recover();
    await service.admit(request('cccccccccccccccc'));
    expect(service.quotaUsage.outputBytes.reserved).toBe(8192);
    const receipt = await service.settle({
      version: DELEGATION_CHANNEL_VERSION,
      invocationId: 'cccccccccccccccc',
      outcome: 'success',
      outputBytes: 128,
      executionSeconds: 7,
    });
    expect(receipt).toMatchObject({ settled: true, revoked: true });
    expect(client.calls.some((call) => call.operation === 'revoke')).toBe(true);
    expect(service.quotaUsage.outputBytes).toMatchObject({ debited: 128, reserved: 0 });
    expect(service.quotaUsage.executionSeconds).toMatchObject({ debited: 7, reserved: 0 });
  });

  it.each(['agent-failure', 'schema-failure', 'timeout', 'cancelled', 'broker-error'] as const)(
    'revokes the identity on a %s outcome',
    async (outcome) => {
      const { service, client } = makeService();
      await service.recover();
      await service.admit(request('dddddddddddddddd'));
      await service.settle({
        version: DELEGATION_CHANNEL_VERSION,
        invocationId: 'dddddddddddddddd',
        outcome,
        outputBytes: 0,
        executionSeconds: 3,
      });
      expect(client.calls.filter((call) => call.operation === 'revoke')).toHaveLength(1);
      // The invocation charge is never refunded after a failure.
      expect(service.quotaUsage.invocations.debited).toBe(1);
    },
  );

  it('reports an unresolved revocation and blocks further admissions', async () => {
    const { service } = makeService({
      async revoke() {
        throw new DelegationControlError('unavailable', 'revoke', 'down');
      },
    });
    await service.recover();
    await service.admit(request('eeeeeeeeeeeeeeee'));
    const receipt = await service.settle({
      version: DELEGATION_CHANNEL_VERSION,
      invocationId: 'eeeeeeeeeeeeeeee',
      outcome: 'success',
      outputBytes: 1,
      executionSeconds: 1,
    });
    expect(receipt.revoked).toBe(false);
    expect(service.isAdmitting).toBe(false);
  });

  it('clamps reported usage to the per-invocation envelope bounds', async () => {
    const { service } = makeService();
    await service.recover();
    await service.admit(request('ffffffffffffffff'));
    await service.settle({
      version: DELEGATION_CHANNEL_VERSION,
      invocationId: 'ffffffffffffffff',
      outcome: 'success',
      outputBytes: 10_000_000,
      executionSeconds: 10_000,
    });
    expect(service.quotaUsage.outputBytes.debited).toBe(8192);
    expect(service.quotaUsage.executionSeconds.debited).toBe(120);
  });

  it('sweeps every labelled identity at shutdown', async () => {
    const { service, client } = makeService();
    await service.recover();
    await service.shutdown();
    expect(client.calls[client.calls.length - 1]).toMatchObject({
      operation: 'revoke-by-labels',
      args: [RUN_ID, 'agent'],
    });
  });

  it('surfaces an unresolved shutdown revocation', async () => {
    const { service } = makeService({
      async revokeByLabels() {
        throw new DelegationControlError('unavailable', 'revoke-by-labels', 'down');
      },
    });
    await service.recover();
    await expect(service.shutdown()).rejects.toThrow(DelegationControlError);
    expect(service.isAdmitting).toBe(false);
  });
});

describe('dynamic delegation audit redaction', () => {
  let auditDir: string;

  beforeEach(() => {
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-delegation-audit-'));
  });

  afterEach(() => {
    fs.rmSync(auditDir, { recursive: true, force: true });
  });

  it('records hashed selectors and handles, never raw private material', async () => {
    const { service } = makeService({}, auditDir);
    await service.recover();
    await service.admit(request('0102030405060708'));
    await service.settle({
      version: DELEGATION_CHANNEL_VERSION,
      invocationId: '0102030405060708',
      outcome: 'success',
      outputBytes: 12,
      executionSeconds: 1,
    });
    const audit = fs.readFileSync(path.join(auditDir, 'a.jsonl'), 'utf8');
    expect(audit).toContain(hashForAudit('octo-org/service'));
    expect(audit).not.toContain('octo-org/service');
    expect(audit).not.toContain('dlgbearer_1');
    expect(audit).not.toContain('dlg_1"');
    expect(audit).not.toContain(CAPABILITY);
    expect(audit).not.toContain('127.0.0.1');
    for (const line of audit.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(audit).toMatch(/"readMode":"live"/);
  });

  it('writes the audit stream with owner-only permissions', async () => {
    const { service } = makeService({}, auditDir);
    await service.recover();
    expect(fs.statSync(path.join(auditDir, 'a.jsonl')).mode & 0o777).toBe(0o600);
  });
});
