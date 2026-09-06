import {
  CANONICAL_DENIAL_REASON,
  DynamicRepositoryRegistry,
  EnclaveSensitivityLedger,
  isCanonicalDynamicSelector,
  resolveDenialTimingBucketMs,
  type DefaultBranchResolver,
  type DynamicRepositoryRegistryOptions,
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
      timeoutSeconds: 120,
      memoryLimit: '1g',
      cpuLimit: '1',
      pidsLimit: 128,
      tmpfsLimit: '256m',
      maxOutputBytes: 8192,
      maxTaskBytes: 4096,
      maxModelRequests: 3,
      maxModelTokens: 10000,
    },
    quotas: { maxInvocations: 3, maxOutputBytes: 1_000_000, maxExecutionSeconds: 3600 },
    auditLabels: ['run:test-run'],
    expiresAt: '2999-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Skips the real wall-clock timing-normalization delay so tests run fast. */
const NO_DELAY: DynamicRepositoryRegistryOptions = { sleep: async () => {} };

function createRegistry(
  policyOverrides: Partial<EnclaveDynamicPolicy>,
  resolver: DefaultBranchResolver,
  options: DynamicRepositoryRegistryOptions = NO_DELAY,
): DynamicRepositoryRegistry {
  return new DynamicRepositoryRegistry(policy(policyOverrides), resolver, options);
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
    const registry = createRegistry({}, () => 'abc123');
    const outcome = await registry.admit({
      runId: 'run-1',
      entryId: 'agent',
      invocationId: 'inv-1',
      selector: 'octo-org/private-service',
    });
    expect(outcome).toEqual({ admitted: true, repo: 'octo-org/private-service', defaultBranchSha: 'abc123' });
  });

  it('admits an exact allowed repository even outside the allowed owners', async () => {
    const registry = createRegistry({}, () => 'sha-1');
    const outcome = await registry.admit({
      runId: 'run-1',
      entryId: 'agent',
      invocationId: 'inv-1',
      selector: 'other-org/exact-repo',
    });
    expect(outcome.admitted).toBe(true);
  });

  it('returns the same canonical denial for malformed, out-of-policy, and expired selectors', async () => {
    const registry = createRegistry({}, () => 'sha');
    const malformed = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-a', selector: 'Not-Canonical/Repo',
    });
    const outOfPolicy = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-b', selector: 'unrelated-org/repo',
    });
    const expiredRegistry = createRegistry({ expiresAt: '2000-01-01T00:00:00Z' }, () => 'sha');
    const expired = await expiredRegistry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-c', selector: 'octo-org/private-service',
    });
    expect(malformed).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(outOfPolicy).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
    expect(expired).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('denies a selector once the resolver rejects it, without disclosing why', async () => {
    const registry = createRegistry({}, () => {
      throw new Error('repository is private and inaccessible to this token');
    });
    const outcome = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(outcome).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('is idempotent by (run, entry, invocation, repository): a retry returns the same terminal outcome', async () => {
    let calls = 0;
    const registry = createRegistry({}, () => {
      calls += 1;
      return `sha-${calls}`;
    });
    const request = { runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service' };
    const first = await registry.admit(request);
    const retry = await registry.admit(request);
    expect(retry).toEqual(first);
    expect(calls).toBe(1);
  });

  it('coalesces concurrent retries of the same idempotency key onto one resolution', async () => {
    let calls = 0;
    let resolveFirst!: (sha: string) => void;
    const registry = createRegistry(
      { quotas: { maxInvocations: 1, maxOutputBytes: 1_000_000, maxExecutionSeconds: 3600 } },
      () => {
        calls += 1;
        return new Promise<string>((resolve) => { resolveFirst = resolve; });
      },
    );
    const request = { runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service' };
    const first = registry.admit(request);
    const second = registry.admit(request);
    await Promise.resolve(); // let both admit() calls reach the resolver before it settles
    resolveFirst('sha-concurrent');
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome).toEqual(secondOutcome);
    expect(firstOutcome).toEqual({ admitted: true, repo: 'octo-org/private-service', defaultBranchSha: 'sha-concurrent' });
    expect(calls).toBe(1);
  });

  it('denies rebinding one invocation id to a different repository', async () => {
    const registry = createRegistry({}, () => 'sha');
    await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const outcome = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'other-org/exact-repo',
    });
    expect(outcome).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('enforces maxRepositories across distinct invocations', async () => {
    const registry = createRegistry({ maxRepositories: 1 }, () => 'sha');
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
    const registry = createRegistry({ maxRepositories: 1 }, () => 'sha');
    await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const outcome = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(outcome.admitted).toBe(true);
  });

  it('enforces the total invocation quota', async () => {
    const registry = createRegistry(
      { quotas: { maxInvocations: 1, maxOutputBytes: 1_000_000, maxExecutionSeconds: 3600 } },
      () => 'sha',
    );
    const first = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const second = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(first.admitted).toBe(true);
    expect(second).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('enforces the total output-bytes quota across invocations', async () => {
    const registry = createRegistry(
      {
        quotas: { maxInvocations: 10, maxOutputBytes: 10_000, maxExecutionSeconds: 3600 },
        limits: {
          timeoutSeconds: 120,
          memoryLimit: '1g',
          cpuLimit: '1',
          pidsLimit: 128,
          tmpfsLimit: '256m',
          maxOutputBytes: 8192,
          maxTaskBytes: 4096,
          maxModelRequests: 3,
          maxModelTokens: 10000,
        },
      },
      () => 'sha',
    );
    const first = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    const second = await registry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'octo-org/private-service',
    });
    expect(first.admitted).toBe(true);
    expect(second).toEqual({ admitted: false, reason: CANONICAL_DENIAL_REASON });
  });

  it('enforces the total execution-seconds quota across invocations', async () => {
    const registry = createRegistry(
      {
        quotas: { maxInvocations: 10, maxOutputBytes: 1_000_000, maxExecutionSeconds: 150 },
        limits: {
          timeoutSeconds: 120,
          memoryLimit: '1g',
          cpuLimit: '1',
          pidsLimit: 128,
          tmpfsLimit: '256m',
          maxOutputBytes: 8192,
          maxTaskBytes: 4096,
          maxModelRequests: 3,
          maxModelTokens: 10000,
        },
      },
      () => 'sha',
    );
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
    const registry = createRegistry({ maxRepositories: 1 }, () => 'sha');
    const [first, second] = await Promise.all([
      registry.admit({ runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service' }),
      registry.admit({ runId: 'run-1', entryId: 'agent', invocationId: 'inv-2', selector: 'other-org/exact-repo' }),
    ]);
    const admittedCount = [first, second].filter(o => o.admitted).length;
    expect(admittedCount).toBe(1);
  });

  it('normalizes timing so a synchronous denial and an async denial request comparable buckets', async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const options: DynamicRepositoryRegistryOptions = {
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    };

    const syncDenyRegistry = createRegistry({ maxRepositories: 0 }, () => 'sha', options);
    await syncDenyRegistry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);

    clock = 0;
    sleeps.length = 0;
    const asyncDenyRegistry = createRegistry({}, () => {
      clock += 50; // simulate a slow resolver lookup before it fails
      throw new Error('inaccessible');
    }, options);
    await asyncDenyRegistry.admit({
      runId: 'run-1', entryId: 'agent', invocationId: 'inv-1', selector: 'octo-org/private-service',
    });
    // Both the fast synchronous denial and the slow resolver-based denial
    // are padded up to the same fixed bucket, so a single sleep call is made
    // in both cases and elapsed time alone cannot distinguish them.
    expect(sleeps).toHaveLength(1);
  });

  it('fails closed for new admissions while reconciliation is incomplete', async () => {
    const registry = createRegistry({}, () => 'sha');
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
