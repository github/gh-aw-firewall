import {
  CANONICAL_DENIAL_REASON,
  DynamicRepositoryRegistry,
  EnclaveSensitivityLedger,
  isCanonicalDynamicSelector,
  resolveDenialTimingBucketMs,
} from './dynamic-registry';
import type { EnclaveDynamicPolicy } from '../types/enclave-options';

function policy(overrides: Partial<EnclaveDynamicPolicy> = {}): EnclaveDynamicPolicy {
  return {
    allowedOwners: ['octo-org'],
    allowedRepositories: ['other-org/exact-repo'],
    sensitivity: 'confidential',
    executor: 'agent',
    githubPolicy: { version: 'github-repository-read-v1', tools: ['list_issues', 'issue_read'] },
    maxRepositories: 2,
    limits: {
      memoryLimit: '1g',
      cpuLimit: '1',
      pidsLimit: 128,
      tmpfsLimit: '256m',
      timeout: 120,
      maxOutputBytes: 8192,
      maxTaskBytes: 4096,
    },
    quotas: { totalInvocations: 3, totalBytes: 1_000_000, totalSeconds: 3600 },
    auditLabels: { run: 'test-run' },
    expiresAt: '2999-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('isCanonicalDynamicSelector', () => {
  it('accepts exact canonical lowercase owner/repo selectors', () => {
    expect(isCanonicalDynamicSelector('octo-org/private-service')).toBe(true);
  });

  it('rejects uppercase, trimmed, or path-traversal selectors with no normalization', () => {
    expect(isCanonicalDynamicSelector('Octo-Org/private-service')).toBe(false);
    expect(isCanonicalDynamicSelector(' octo-org/private-service')).toBe(false);
    expect(isCanonicalDynamicSelector('octo-org/private-service ')).toBe(false);
    expect(isCanonicalDynamicSelector('octo-org/..')).toBe(false);
    expect(isCanonicalDynamicSelector('octo-org/repo/extra')).toBe(false);
    expect(isCanonicalDynamicSelector('octo-org%2Fprivate-service')).toBe(false);
  });
});

describe('DynamicRepositoryRegistry', () => {
  it('admits a selector within an allowed owner and resolves the default-branch SHA', async () => {
    const registry = new DynamicRepositoryRegistry(policy(), () => 'abc123');
    const outcome = await registry.admit({
      runId: 'run-1',
      entryId: 'agent',
      invocationId: 'inv-1',
      selector: 'octo-org/private-service',
    });
    expect(outcome).toEqual({ admitted: true, repo: 'octo-org/private-service', defaultBranchSha: 'abc123' });
  });

  it('admits an exact allowed repository even outside the allowed owners', async () => {
    const registry = new DynamicRepositoryRegistry(policy(), () => 'sha-1');
    const outcome = await registry.admit({
      runId: 'run-1',
      entryId: 'agent',
      invocationId: 'inv-1',
      selector: 'other-org/exact-repo',
    });
    expect(outcome.admitted).toBe(true);
  });

  it('returns the same canonical denial for malformed, out-of-policy, and expired selectors', async () => {
    const registry = new DynamicRepositoryRegistry(policy(), () => 'sha');
    const malformed = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-a', selector: 'Not-Canonical/Repo',
    });
    const outOfPolicy = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-b', selector: 'unrelated-org/repo',
    });
    const expiredRegistry = new DynamicRepositoryRegistry(
      policy({ expiresAt: '2000-01-01T00:00:00Z' }),
      () => 'sha',
    );
    const expired = await expiredRegistry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-c', selector: 'octo-org/private-service',
    });
    expect(malformed).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(outOfPolicy).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(expired).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('denies a selector once the resolver rejects it, without disclosing why', async () => {
    const registry = new DynamicRepositoryRegistry(policy(), () => {
      throw new Error('repository is private and inaccessible to this token');
    });
    const outcome = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(outcome).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('is idempotent by (run, entry, invocation, repository): a retry returns the same terminal outcome', async () => {
    let calls = 0;
    const registry = new DynamicRepositoryRegistry(policy(), () => {
      calls += 1;
      return `sha-${calls}`;
    });
    const request = { runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service' };
    const first = await registry.admit(request);
    const retry = await registry.admit(request);
    expect(retry).toEqual(first);
    expect(calls).toBe(1);
  });

  it('denies rebinding one invocation id to a different repository', async () => {
    const registry = new DynamicRepositoryRegistry(policy(), () => 'sha');
    await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const outcome = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'other-org/exact-repo',
    });
    expect(outcome).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('enforces maxRepositories across distinct invocations', async () => {
    const registry = new DynamicRepositoryRegistry(policy({ maxRepositories: 1 }), () => 'sha');
    const first = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const second = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'other-org/exact-repo',
    });
    expect(first.admitted).toBe(true);
    expect(second).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(registry.admittedRepositoryCount).toBe(1);
  });

  it('re-admits an already-admitted repository from a different invocation without exceeding maxRepositories', async () => {
    const registry = new DynamicRepositoryRegistry(policy({ maxRepositories: 1 }), () => 'sha');
    await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const outcome = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(outcome.admitted).toBe(true);
  });

  it('enforces the total invocation quota', async () => {
    const registry = new DynamicRepositoryRegistry(policy({ quotas: { totalInvocations: 1, totalBytes: 1, totalSeconds: 1 } }), () => 'sha');
    const first = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const second = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(first.admitted).toBe(true);
    expect(second).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('cannot race two concurrent admissions past maxRepositories', async () => {
    const registry = new DynamicRepositoryRegistry(policy({ maxRepositories: 1 }), () => 'sha');
    const [first, second] = await Promise.all([
      registry.admit({ runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service' }),
      registry.admit({ runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'other-org/exact-repo' }),
    ]);
    const admittedCount = [first, second].filter(o => o.admitted).length;
    expect(admittedCount).toBe(1);
  });

  it('fails closed for new admissions while reconciliation is incomplete', async () => {
    const registry = new DynamicRepositoryRegistry(policy(), () => 'sha');
    registry.markReconciliationIncomplete();
    const outcome = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(outcome).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    registry.markReconciled();
    const afterReconcile = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(afterReconcile.admitted).toBe(true);
  });
});

describe('resolveDenialTimingBucketMs', () => {
  it('always resolves to a fixed bucket boundary plus bounded jitter, never raw elapsed time', () => {
    const buckets = [100, 1_000, 10_000, 60_000, 120_000, 180_000, 240_000, 300_000, 600_000, 1_200_000, 2_400_000, 4_800_000];
    for (const elapsed of [0, 50, 500, 5_000, 50_000, 5_000_000]) {
      const bucketed = resolveDenialTimingBucketMs(elapsed);
      const jitter = bucketed - Math.max(...buckets.filter(b => b <= bucketed));
      expect(buckets.some(bucket => bucketed >= bucket && bucketed < bucket + 1001)).toBe(true);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(1001);
    }
  });
});

describe('EnclaveSensitivityLedger', () => {
  it('never bounds an unlimited sensitivity class', () => {
    const ledger = new EnclaveSensitivityLedger();
    expect(ledger.debit('trusted', 1_000_000)).toBe(true);
    expect(ledger.debit('public', 1_000_000)).toBe(true);
  });

  it('rejects a debit once the shared run-wide bound is exhausted', () => {
    const ledger = new EnclaveSensitivityLedger();
    expect(ledger.debit('sealed', 1)).toBe(false);
    expect(ledger.debit('confidential', 8)).toBe(true);
    expect(ledger.debit('confidential', 1)).toBe(false);
  });
});
